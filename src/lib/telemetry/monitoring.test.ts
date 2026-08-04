import { describe, expect, it, vi, afterEach } from "vitest";
import { buildErrorReport } from "./error-report";
import { reportError, resetErrorSink } from "./error-reporter";
import {
  MONITORING_SCHEMA_VERSION,
  buildMonitoringEvent,
  redactMonitoringEvent,
} from "./monitoring-event";
import { createHttpTransport, nullTransport } from "./monitoring-transport";
import {
  captureMonitoringEvent,
  initErrorMonitoring,
  resolveMonitoringConfig,
  resolveRelease,
  type MonitoringConfig,
} from "./monitoring";
import { initClientErrorMonitoring } from "./monitoring-client";
import type { MonitoringEvent } from "./monitoring-event";

/**
 * ATL-095 — error monitoring.
 *
 * The poisoned fixture is the same one ATL-010 uses, deliberately: the value of a
 * shared fixture is that a regression in either layer trips the same tripwire.
 */

const NOW = new Date("2026-07-30T09:15:00.000Z");

/** Every category architecture §16 forbids, in one string. */
const POISONED_MESSAGE =
  "Failed for Dana Whitfield <dana@example.com>, phone 555-0100, 42 Roseway Ave, " +
  'token sk_live_9f2b7c1d, body {"draft":"Please delete my account"}';

const RESTRICTED_FRAGMENTS = [
  "Dana Whitfield",
  "dana@example.com",
  "555-0100",
  "Roseway",
  "sk_live_9f2b7c1d",
  "Please delete my account",
];

function poisonedReport() {
  const error = new Error(POISONED_MESSAGE);
  error.stack = `Error: ${error.message}\n    at save (/srv/atlas/personal-fields.ts:20:11)`;
  return buildErrorReport({
    error,
    boundary: "route",
    pathname: "/assets/8f14e45f-ceea-467a-9dbf-2a0e1b7e4a11",
    now: NOW,
  });
}

function collectingTransport() {
  const sent: MonitoringEvent[] = [];
  return {
    sent,
    transport: {
      send: (event: MonitoringEvent) => {
        sent.push(event);
        return Promise.resolve({ status: "delivered" as const });
      },
    },
  };
}

function configWith(transport: MonitoringConfig["transport"]): MonitoringConfig {
  return { transport, release: "a1b2c3d4", environment: "production" };
}

afterEach(() => {
  resetErrorSink();
  vi.restoreAllMocks();
});

describe("buildMonitoringEvent", () => {
  it("captures route, release, environment, request ID, status and error code", () => {
    // Architecture §16 "capture" list, as far as it applies to an error event.
    const event = buildMonitoringEvent({
      report: poisonedReport(),
      release: "a1b2c3d4",
      environment: "production",
      requestId: "iad1::abcdef-12345",
      status: 500,
      errorCode: "RATE_LIMITED",
    });

    expect(event).toEqual({
      schemaVersion: MONITORING_SCHEMA_VERSION,
      boundary: "route",
      route: "/assets/:id",
      errorName: "Error",
      occurredAt: NOW.toISOString(),
      release: "a1b2c3d4",
      environment: "production",
      requestId: "iad1::abcdef-12345",
      status: 500,
      errorCode: "RATE_LIMITED",
    });
  });

  it("omits optional fields rather than sending undefined", () => {
    const event = buildMonitoringEvent({
      report: poisonedReport(),
      release: "a1b2c3d4",
      environment: "local",
    });
    expect(Object.keys(event)).not.toContain("requestId");
    expect(Object.keys(event)).not.toContain("status");
    expect(Object.keys(event)).not.toContain("errorCode");
  });
});

describe("redactMonitoringEvent — poisoned fixture", () => {
  it("drops keys that are not on the allowlist", () => {
    // Simulates a future contributor adding a field that seems harmless.
    const { event, droppedKeys } = redactMonitoringEvent({
      ...buildMonitoringEvent({ report: poisonedReport(), release: "a1", environment: "staging" }),
      userEmail: "dana@example.com",
      message: POISONED_MESSAGE,
      stack: "at save (/srv/atlas/personal-fields.ts:20:11)",
      requestBody: '{"draft":"Please delete my account"}',
    });

    expect(droppedKeys.sort()).toEqual(["message", "requestBody", "stack", "userEmail"]);
    const serialised = JSON.stringify(event);
    for (const fragment of RESTRICTED_FRAGMENTS) {
      expect(serialised).not.toContain(fragment);
    }
  });

  it("removes an allowlisted field whose value carries restricted data", () => {
    // The realistic leak: a proxy echoes a personal value into a header that
    // becomes the request ID.
    const { event, redactedKeys } = redactMonitoringEvent({
      ...buildMonitoringEvent({ report: poisonedReport(), release: "a1", environment: "staging" }),
      requestId: "dana@example.com",
    });

    expect(redactedKeys).toContain("requestId");
    expect(event.requestId).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("dana@example.com");
  });

  it.each([
    ["email", "user@example.com"],
    ["phone", "+1 555 0100 99"],
    ["provider key", "sk_live_9f2b7c1dabc"],
    ["bearer token", "Bearer abc.def.ghi"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.payload"],
    ["long hex", "a".repeat(40)],
  ])("scrubs a %s appearing in any allowlisted string field", (_label, value) => {
    const { event } = redactMonitoringEvent({
      ...buildMonitoringEvent({ report: poisonedReport(), release: "a1", environment: "staging" }),
      errorCode: value,
    });
    expect(event.errorCode).toBeUndefined();
  });

  it.each([
    ["an opaque identifier segment", "/assets/8f14e45fceea467a9dbf2a0e"],
    ["an email in the path", "/requests/dana@example.com"],
    ["an uppercase or mixed-case segment", "/Assets/Dana"],
    ["a path traversal attempt", "/assets/../../etc/passwd"],
    ["a query string that survived", "/assets?token=abc"],
  ])("drops a route containing %s", (_label, route) => {
    // If ATL-010's redaction were ever bypassed, this is the backstop. It checks
    // the template shape positively rather than guessing at what an identifier
    // looks like — the email case is exactly what a negative check missed.
    const { event, redactedKeys } = redactMonitoringEvent({
      ...buildMonitoringEvent({ report: poisonedReport(), release: "a1", environment: "staging" }),
      route,
    });
    expect(redactedKeys).toContain("route");
    expect(event.route).toBeUndefined();
  });

  it.each(["/", "/overview", "/assets/:id", "/settings/notifications", "/requests/:id/edit"])(
    "keeps the valid route template %s",
    (route) => {
      const { event, redactedKeys } = redactMonitoringEvent({
        ...buildMonitoringEvent({
          report: poisonedReport(),
          release: "a1",
          environment: "staging",
        }),
        route,
      });
      expect(redactedKeys).not.toContain("route");
      expect(event.route).toBe(route);
    },
  );

  it("keeps occurredAt, which a resemblance-based scan would strip", () => {
    // Regression: a generic "looks like a phone number" pattern matched
    // 2026-07-30T09:15:00.000Z and silently removed this field from every event.
    const { event, redactedKeys } = redactMonitoringEvent(
      buildMonitoringEvent({ report: poisonedReport(), release: "a1", environment: "staging" }),
    );
    expect(redactedKeys).toEqual([]);
    expect(event.occurredAt).toBe(NOW.toISOString());
  });

  it.each([
    ["release", { release: "not a valid release!" }],
    ["errorCode", { errorCode: "lowercase-code" }],
    ["environment", { environment: "prod" }],
    ["status", { status: 99 }],
    ["status", { status: 1.5 }],
  ])("drops %s when it fails its shape check", (key, override) => {
    const { event, redactedKeys } = redactMonitoringEvent({
      ...buildMonitoringEvent({ report: poisonedReport(), release: "a1", environment: "staging" }),
      ...override,
    });
    expect(redactedKeys).toContain(key);
    expect(event[key as keyof MonitoringEvent]).toBeUndefined();
  });

  it("survives a non-object candidate", () => {
    for (const value of [null, undefined, "string", 42, []]) {
      expect(() => redactMonitoringEvent(value)).not.toThrow();
    }
  });
});

describe("captureMonitoringEvent", () => {
  it("redacts before transport, not after", async () => {
    const { sent, transport } = collectingTransport();

    await captureMonitoringEvent(configWith(transport), {
      report: poisonedReport(),
      requestId: "dana@example.com", // poisoned correlation ID
    });

    expect(sent).toHaveLength(1);
    // The transport never saw the offending value — it was removed upstream of
    // the send call, which is the acceptance criterion.
    expect(sent[0]!.requestId).toBeUndefined();
    expect(JSON.stringify(sent[0])).not.toContain("dana@example.com");
  });

  it("reports what redaction removed without echoing values", async () => {
    const { transport } = collectingTransport();
    const result = await captureMonitoringEvent(configWith(transport), {
      report: poisonedReport(),
      requestId: "dana@example.com",
    });

    expect(result.redactedKeys).toContain("requestId");
    expect(JSON.stringify(result)).not.toContain("dana@example.com");
  });

  it("tags every event with release and environment", async () => {
    const { sent, transport } = collectingTransport();
    await captureMonitoringEvent(configWith(transport), { report: poisonedReport() });
    expect(sent[0]).toMatchObject({ release: "a1b2c3d4", environment: "production" });
  });
});

describe("initErrorMonitoring", () => {
  it("connects the ATL-010 seam so a boundary report reaches the transport", async () => {
    const { sent, transport } = collectingTransport();
    initErrorMonitoring(configWith(transport));

    reportError({
      error: Object.assign(new Error(POISONED_MESSAGE), { digest: "ff00aa" }),
      boundary: "component",
      pathname: "/requests/9021",
      component: "RequestCard",
      now: NOW,
    });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      boundary: "component",
      route: "/requests/:id",
      component: "RequestCard",
      digest: "ff00aa",
      release: "a1b2c3d4",
    });
    for (const fragment of RESTRICTED_FRAGMENTS) {
      expect(JSON.stringify(sent[0])).not.toContain(fragment);
    }
  });

  it("returns a teardown that removes the sink", async () => {
    const { sent, transport } = collectingTransport();
    const teardown = initErrorMonitoring(configWith(transport));
    teardown();

    reportError({ error: new Error("x"), boundary: "route", pathname: "/overview" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(0);
  });

  it("does not let a failing transport escape into the boundary", () => {
    initErrorMonitoring(
      configWith({
        send: () => Promise.reject(new Error("collector down")),
      }),
    );

    // `reportError` runs inside componentDidCatch. It must return normally.
    expect(() =>
      reportError({ error: new Error("x"), boundary: "component", pathname: "/overview" }),
    ).not.toThrow();
  });
});

describe("createHttpTransport — fail-safe delivery", () => {
  const event = buildMonitoringEvent({
    report: poisonedReport(),
    release: "a1",
    environment: "production",
  });

  it("posts the event as JSON with the credential in a header, never the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const transport = createHttpTransport({
      endpoint: "https://collector.example.com/ingest",
      apiKey: "monitoring-key",
      fetchImpl: fetchImpl,
    });

    const result = await transport.send(event);

    expect(result.status).toBe("delivered");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://collector.example.com/ingest");
    expect(url).not.toContain("monitoring-key"); // security §19
    expect((init.headers as Record<string, string>)["x-atlas-monitoring-key"]).toBe(
      "monitoring-key",
    );
    expect(init.credentials).toBe("omit");
  });

  it("reports failure without throwing when the collector is unreachable", async () => {
    const transport = createHttpTransport({
      endpoint: "https://collector.example.com/ingest",
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    await expect(transport.send(event)).resolves.toEqual({ status: "failed" });
  });

  it("reports failure on a non-2xx response", async () => {
    const transport = createHttpTransport({
      endpoint: "https://collector.example.com/ingest",
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    });
    await expect(transport.send(event)).resolves.toEqual({ status: "failed" });
  });

  it("aborts rather than holding a request open", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const transport = createHttpTransport({
      endpoint: "https://collector.example.com/ingest",
      timeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(transport.send(event)).resolves.toEqual({ status: "failed" });
  });

  it("fails safely when no fetch implementation exists", async () => {
    const transport = createHttpTransport({
      endpoint: "https://collector.example.com/ingest",
      fetchImpl: undefined as unknown as typeof fetch,
    });
    const original = globalThis.fetch;
    // @ts-expect-error — deliberately simulating a runtime without fetch.
    delete globalThis.fetch;
    await expect(transport.send(event)).resolves.toEqual({ status: "failed" });
    globalThis.fetch = original;
  });

  it("is disabled, not broken, when no endpoint is configured", async () => {
    await expect(nullTransport.send(event)).resolves.toEqual({ status: "disabled" });
  });
});

describe("resolveRelease", () => {
  it("prefers an explicit release tag", () => {
    expect(resolveRelease({ ATLAS_RELEASE: "v1.4.2", VERCEL_GIT_COMMIT_SHA: "abc1234" })).toBe(
      "v1.4.2",
    );
  });

  it("falls back to a shortened platform commit SHA", () => {
    expect(resolveRelease({ VERCEL_GIT_COMMIT_SHA: "a".repeat(40) })).toBe("a".repeat(12));
    expect(resolveRelease({ GITHUB_SHA: "b".repeat(40) })).toBe("b".repeat(12));
  });

  it("ignores a commit value that is not a SHA", () => {
    // A branch name or a "refs/heads/..." value must not become a release tag.
    expect(resolveRelease({ VERCEL_GIT_COMMIT_SHA: "refs/heads/main" })).toBe("unknown");
  });

  it("reports 'unknown' rather than omitting the tag", () => {
    // An untagged deploy should be visible, not indistinguishable from a tagged one.
    expect(resolveRelease({})).toBe("unknown");
    expect(resolveRelease({ ATLAS_RELEASE: "   " })).toBe("unknown");
  });

  it("always produces a value the redaction pass accepts", () => {
    for (const source of [{}, { ATLAS_RELEASE: "v1.4.2" }, { GITHUB_SHA: "c".repeat(40) }]) {
      const { redactedKeys } = redactMonitoringEvent(
        buildMonitoringEvent({
          report: poisonedReport(),
          release: resolveRelease(source),
          environment: "production",
        }),
      );
      expect(redactedKeys).not.toContain("release");
    }
  });
});

describe("resolveMonitoringConfig", () => {
  it("uses the null transport when no endpoint is set", () => {
    const config = resolveMonitoringConfig({
      endpoint: undefined,
      release: "a1",
      environment: "local",
      createTransport: () => {
        throw new Error("must not construct a transport without an endpoint");
      },
    });
    expect(config.transport).toBe(nullTransport);
  });

  it("builds a transport when an endpoint is set", () => {
    const built = { send: () => Promise.resolve({ status: "delivered" as const }) };
    const config = resolveMonitoringConfig({
      endpoint: "https://collector.example.com",
      release: "a1",
      environment: "production",
      createTransport: () => built,
    });
    expect(config.transport).toBe(built);
  });
});

describe("initClientErrorMonitoring", () => {
  it("posts the redacted report to the first-party ingest route", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    initClientErrorMonitoring({ fetchImpl: fetchImpl as unknown as typeof fetch });

    reportError({
      error: Object.assign(new Error(POISONED_MESSAGE), { digest: "ff00aa" }),
      boundary: "route",
      pathname: "/assets/8f14e45f-ceea-467a",
      now: NOW,
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/monitoring/error");
    expect(init.keepalive).toBe(true);

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.route).toBe("/assets/:id");
    for (const fragment of RESTRICTED_FRAGMENTS) {
      expect(init.body as string).not.toContain(fragment);
    }
  });

  it("never sends the collector credential from the browser", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    initClientErrorMonitoring({ fetchImpl: fetchImpl as unknown as typeof fetch });
    reportError({ error: new Error("x"), boundary: "route", pathname: "/overview" });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.stringify(init.headers)).not.toMatch(/monitoring-key/i);
  });

  it("swallows a failed ingest request", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    initClientErrorMonitoring({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(() =>
      reportError({ error: new Error("x"), boundary: "route", pathname: "/overview" }),
    ).not.toThrow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  });
});
