import { describe, expect, it } from "vitest";
import {
  BLOCKING_SEVERITIES,
  evaluateDependencyPolicy,
  parseAuditReport,
  type Advisory,
  type DependencyException,
} from "./dependency-policy";

/** ATL-090 — dependency policy: critical findings block; exceptions are time-boxed. */

const NOW = new Date("2026-08-01T12:00:00.000Z");

const advisory = (overrides: Partial<Advisory> = {}): Advisory => ({
  id: "GHSA-aaaa-bbbb-cccc",
  severity: "high",
  module: "example-pkg",
  title: "Example vulnerability",
  paths: [".>example-pkg"],
  ...overrides,
});

const exception = (overrides: Partial<DependencyException> = {}): DependencyException => ({
  id: "GHSA-aaaa-bbbb-cccc",
  reason: "Dev-only; upstream fix pending",
  acceptedBy: "security-engineer",
  expires: "2026-12-31",
  tracking: "ATL-090",
  ...overrides,
});

const rules = (advisories: Advisory[], exceptions: DependencyException[] = []) =>
  evaluateDependencyPolicy({ advisories, exceptions, now: NOW }).map((v) => v.rule);

describe("severity policy", () => {
  it("blocks on high and critical", () => {
    expect(BLOCKING_SEVERITIES).toEqual(["high", "critical"]);
  });

  it.each(["high", "critical"] as const)("blocks an unexcepted %s advisory", (severity) => {
    expect(rules([advisory({ severity })])).toEqual(["blocking-advisory"]);
  });

  it.each(["info", "low", "moderate"] as const)("does not block on %s", (severity) => {
    expect(rules([advisory({ severity })])).toEqual([]);
  });

  it("passes when there are no advisories", () => {
    expect(rules([])).toEqual([]);
  });

  it("includes the module, path, and patched version in the message", () => {
    const [violation] = evaluateDependencyPolicy({
      advisories: [advisory({ patchedVersions: ">=2.0.0" })],
      exceptions: [],
      now: NOW,
    });
    expect(violation?.message).toContain("example-pkg");
    expect(violation?.message).toContain(".>example-pkg");
    expect(violation?.message).toContain(">=2.0.0");
  });
});

describe("time-boxed exceptions", () => {
  it("allows a blocking advisory covered by an unexpired exception", () => {
    expect(rules([advisory()], [exception()])).toEqual([]);
  });

  it("blocks when the exception has expired", () => {
    expect(rules([advisory()], [exception({ expires: "2026-07-31" })])).toEqual([
      "expired-exception",
    ]);
  });

  it("treats the expiry date itself as still valid (end of day)", () => {
    expect(rules([advisory()], [exception({ expires: "2026-08-01" })])).toEqual([]);
  });

  it("does not apply an exception to a different advisory", () => {
    expect(rules([advisory({ id: "GHSA-zzzz-zzzz-zzzz" })], [exception()])).toContain(
      "blocking-advisory",
    );
  });

  it("reports an exception that no longer matches any advisory", () => {
    expect(rules([], [exception()])).toEqual(["stale-exception"]);
  });

  it("explains the original decision when an exception expires", () => {
    const [violation] = evaluateDependencyPolicy({
      advisories: [advisory()],
      exceptions: [exception({ expires: "2026-01-01", acceptedBy: "alice" })],
      now: NOW,
    });
    expect(violation?.message).toContain("alice");
    expect(violation?.message).toContain("ATL-090");
  });
});

describe("malformed exceptions", () => {
  it.each(["reason", "acceptedBy", "expires", "tracking"] as const)(
    "rejects an exception missing %s",
    (field) => {
      const broken = { ...exception(), [field]: "" };
      expect(rules([advisory()], [broken])).toEqual(["malformed-exception"]);
    },
  );

  it("rejects a non-ISO expiry", () => {
    expect(rules([advisory()], [exception({ expires: "31/12/2026" })])).toEqual([
      "malformed-exception",
    ]);
  });

  it("reports malformed exceptions before evaluating advisories", () => {
    // A broken policy file must not be able to silently permit an advisory.
    const violations = evaluateDependencyPolicy({
      advisories: [advisory({ severity: "critical" })],
      exceptions: [{ ...exception(), reason: "" }],
      now: NOW,
    });
    expect(violations.map((v) => v.rule)).toEqual(["malformed-exception"]);
  });
});

describe("parseAuditReport", () => {
  it("normalises a pnpm audit report", () => {
    const raw = {
      advisories: {
        "1234": {
          github_advisory_id: "GHSA-mh99-v99m-4gvg",
          severity: "high",
          module_name: "brace-expansion",
          title: "DoS via unbounded expansion",
          vulnerable_versions: "<=5.0.7",
          patched_versions: ">=5.0.8",
          findings: [{ paths: [".>eslint>minimatch>brace-expansion"] }],
        },
      },
    };
    expect(parseAuditReport(raw)).toEqual([
      {
        id: "GHSA-mh99-v99m-4gvg",
        severity: "high",
        module: "brace-expansion",
        title: "DoS via unbounded expansion",
        paths: [".>eslint>minimatch>brace-expansion"],
        vulnerableVersions: "<=5.0.7",
        patchedVersions: ">=5.0.8",
      },
    ]);
  });

  it("falls back to the advisory id embedded in the url", () => {
    const raw = {
      advisories: {
        "1": { url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "critical" },
      },
    };
    expect(parseAuditReport(raw)[0]?.id).toBe("GHSA-aaaa-bbbb-cccc");
  });

  it.each([null, undefined, {}, { advisories: null }, "nonsense"])(
    "tolerates a shapeless report (%s)",
    (raw) => {
      expect(parseAuditReport(raw)).toEqual([]);
    },
  );
});
