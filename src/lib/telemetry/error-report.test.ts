import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildErrorReport,
  toDigest,
  toErrorName,
  toRouteTemplate,
  toUserReference,
} from "./error-report";
import { reportError, resetErrorSink, setErrorSink } from "./error-reporter";
import type { ErrorReport } from "./error-report";

/**
 * ATL-010 — privacy-safe error reporting.
 *
 * The acceptance criterion is "reported errors contain no personal data, request
 * bodies, or tokens (redaction verified)". These tests verify it the way it can
 * actually fail: with errors that *do* carry that data, asserting it does not
 * survive into the report.
 */

const NOW = new Date("2026-07-30T09:15:00.000Z");

afterEach(() => {
  resetErrorSink();
});

describe("toRouteTemplate", () => {
  it("keeps known route segments", () => {
    expect(toRouteTemplate("/assets")).toBe("/assets");
    expect(toRouteTemplate("/settings/notifications")).toBe("/settings/notifications");
  });

  it("replaces record identifiers with a placeholder", () => {
    expect(toRouteTemplate("/assets/8f14e45f-ceea-467a-9dbf-2a0e1b7e4a11")).toBe("/assets/:id");
    expect(toRouteTemplate("/requests/4821/edit")).toBe("/requests/:id/edit");
  });

  it("replaces unrecognised segments rather than trusting them", () => {
    // The allowlist fails closed: a slug naming a service the user uses is itself
    // information about that user, so it never reaches telemetry.
    expect(toRouteTemplate("/assets/acme-payroll-account")).toBe("/assets/:id");
  });

  it("removes email addresses appearing anywhere in the path", () => {
    const template = toRouteTemplate("/requests/user@example.com");
    expect(template).toBe("/requests/:id");
    expect(template).not.toContain("@");
  });

  it("drops query strings and fragments entirely", () => {
    expect(toRouteTemplate("/assets?token=abc123&email=user@example.com")).toBe("/assets");
    expect(toRouteTemplate("/insights#finding-42")).toBe("/insights");
  });

  it("normalises the root and empty paths", () => {
    expect(toRouteTemplate("/")).toBe("/");
    expect(toRouteTemplate("")).toBe("/");
    expect(toRouteTemplate("///")).toBe("/");
  });
});

describe("toErrorName", () => {
  it("accepts identifier-shaped names", () => {
    expect(toErrorName(new TypeError("boom"))).toBe("TypeError");

    class ZodValidationError extends Error {
      override name = "ZodValidationError";
    }
    expect(toErrorName(new ZodValidationError())).toBe("ZodValidationError");
  });

  it("rejects a name carrying interpolated data", () => {
    const error = new Error("boom");
    error.name = "Error: could not save user@example.com";
    expect(toErrorName(error)).toBe("Error");
  });

  it("falls back for non-object throws", () => {
    expect(toErrorName("a string containing 555-0100")).toBe("Error");
    expect(toErrorName(null)).toBe("Error");
    expect(toErrorName(undefined)).toBe("Error");
    expect(toErrorName(42)).toBe("Error");
  });
});

describe("toDigest", () => {
  it("accepts a hash-shaped digest", () => {
    expect(toDigest(Object.assign(new Error("x"), { digest: "1a2b3c4d5e" }))).toBe("1a2b3c4d5e");
  });

  it("rejects a digest that is not hash-shaped", () => {
    // A displayed value must never be attacker-shaped: this is what stops a
    // crafted `digest` from smuggling text onto the recovery screen.
    expect(toDigest(Object.assign(new Error("x"), { digest: "user@example.com" }))).toBeUndefined();
    expect(toDigest(Object.assign(new Error("x"), { digest: "<img src=x>" }))).toBeUndefined();
    expect(toDigest(Object.assign(new Error("x"), { digest: 12345 }))).toBeUndefined();
  });

  it("is absent for a plain client-side error", () => {
    expect(toDigest(new Error("client failure"))).toBeUndefined();
    expect(toUserReference(new Error("client failure"))).toBeUndefined();
  });
});

describe("buildErrorReport", () => {
  it("produces exactly the allowlisted fields", () => {
    const report = buildErrorReport({
      error: Object.assign(new TypeError("boom"), { digest: "abc123" }),
      boundary: "route",
      pathname: "/assets/8f14e45f-ceea-467a-9dbf-2a0e1b7e4a11",
      now: NOW,
    });

    expect(Object.keys(report).sort()).toEqual([
      "boundary",
      "digest",
      "errorName",
      "occurredAt",
      "route",
    ]);
    expect(report).toEqual({
      boundary: "route",
      route: "/assets/:id",
      errorName: "TypeError",
      digest: "abc123",
      occurredAt: NOW.toISOString(),
    });
  });

  it("carries no trace of a message packed with restricted data", () => {
    // Every category architecture §16 forbids, in one error.
    const error = new Error(
      "Failed to save profile for Dana Whitfield <dana@example.com>, phone 555-0100, " +
        'at 42 Roseway Ave, token sk_live_9f2b7c1d, body {"draft":"Please delete my account"}',
    );
    error.stack = `Error: ${error.message}\n    at save (/srv/atlas/personal-fields.ts:20:11)`;

    const report = buildErrorReport({
      error,
      boundary: "component",
      pathname: "/settings/data",
      component: "PersonalFieldsPanel",
      now: NOW,
    });

    const serialised = JSON.stringify(report);
    for (const secret of [
      "Dana Whitfield",
      "dana@example.com",
      "555-0100",
      "Roseway",
      "sk_live_9f2b7c1d",
      "Please delete my account",
      "personal-fields.ts",
    ]) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).not.toMatch(/message|stack/i);
  });

  it("rejects a component label that is not identifier-shaped", () => {
    const report = buildErrorReport({
      error: new Error("x"),
      boundary: "component",
      pathname: "/overview",
      component: "Card for dana@example.com",
      now: NOW,
    });
    expect(report.component).toBeUndefined();
  });

  it("accepts a static component label", () => {
    const report = buildErrorReport({
      error: new Error("x"),
      boundary: "component",
      pathname: "/overview",
      component: "PrivacyScoreCard",
      now: NOW,
    });
    expect(report.component).toBe("PrivacyScoreCard");
  });

  it("survives a hostile error object without throwing", () => {
    // Report construction runs inside `componentDidCatch`. If it threw, the
    // boundary would re-enter with an unhandled error.
    const throwingGetter = {
      get name() {
        throw new Error("nope");
      },
      get digest() {
        throw new Error("nope");
      },
    };

    for (const value of [throwingGetter, null, undefined, "string", 0, [], Symbol("s")]) {
      expect(() =>
        buildErrorReport({ error: value, boundary: "route", pathname: "/overview", now: NOW }),
      ).not.toThrow();
    }

    expect(
      buildErrorReport({ error: throwingGetter, boundary: "route", pathname: "/", now: NOW }),
    ).toEqual({ boundary: "route", route: "/", errorName: "Error", occurredAt: NOW.toISOString() });
  });
});

describe("reportError", () => {
  it("delivers the redacted report to the installed sink", () => {
    const sink = vi.fn<(report: ErrorReport) => void>();
    setErrorSink(sink);

    reportError({
      error: Object.assign(new Error("contains dana@example.com"), { digest: "ff00aa" }),
      boundary: "route",
      pathname: "/requests/9021",
      now: NOW,
    });

    expect(sink).toHaveBeenCalledTimes(1);
    const [report] = sink.mock.calls[0]!;
    expect(report).toEqual({
      boundary: "route",
      route: "/requests/:id",
      errorName: "Error",
      digest: "ff00aa",
      occurredAt: NOW.toISOString(),
    });
    // The sink receives a report, never the error — so it cannot serialise more.
    expect(JSON.stringify(report)).not.toContain("dana@example.com");
  });

  it("returns the report so the boundary renders the same reference it reported", () => {
    const report = reportError({
      error: Object.assign(new Error("x"), { digest: "beef01" }),
      boundary: "global",
      pathname: "/",
      now: NOW,
    });
    expect(report.digest).toBe("beef01");
  });

  it("does not escalate a failing sink into an unhandled error", () => {
    // A throwing sink inside `componentDidCatch` would re-enter the boundary.
    setErrorSink(() => {
      throw new Error("transport down");
    });
    expect(() =>
      reportError({ error: new Error("x"), boundary: "component", pathname: "/overview" }),
    ).not.toThrow();
  });

  it("stays silent when no sink is installed", () => {
    // ATL-095 installs the real transport. Until then reports go nowhere rather
    // than to an unreviewed third party.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    resetErrorSink();
    reportError({ error: new Error("x"), boundary: "route", pathname: "/overview" });
    // NODE_ENV is "test" under Vitest, so the development-only log does not run.
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("restores the previous sink when replaced", () => {
    const first = vi.fn();
    const second = vi.fn();
    setErrorSink(first);
    const previous = setErrorSink(second);
    expect(previous).toBe(first);
  });
});
