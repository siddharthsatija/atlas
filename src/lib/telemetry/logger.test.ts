import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED } from "./redaction";
import { log, logger, setLogSink, type LogRecord } from "./logger";

/**
 * ATL-085 — the redaction-aware logger.
 *
 * `eslint.config.mjs` has forbidden `console` in favour of "the redaction-aware
 * logger" since ATL-001. These tests hold that logger to architecture §16: the
 * "Capture" list is what may travel, and the "Never capture" list has no field to
 * travel in.
 */

function capture(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = [];
  const previous = setLogSink((record) => records.push(record));
  return { records, restore: () => setLogSink(previous) };
}

/**
 * A silent sink by default.
 *
 * Tests that assert on output install their own via `capture()`. Without this
 * the default `consoleSink` would write a JSON line to the real stdout for every
 * test that logs — noise that makes a genuine failure harder to spot.
 */
beforeEach(() => {
  setLogSink(() => {});
});

afterEach(() => {
  setLogSink(null);
});

describe("field allowlist", () => {
  it("emits the architecture §16 capture fields", () => {
    const { records, restore } = capture();

    logger.info("request.completed", {
      requestId: "req-01HN",
      route: "/assets/:id",
      operation: "assets.read",
      status: 200,
      latencyMs: 42,
      provider: "ai",
      providerAvailable: true,
      rlsDenialCount: 0,
    });

    expect(records[0]).toMatchObject({
      level: "info",
      event: "request.completed",
      requestId: "req-01HN",
      route: "/assets/:id",
      operation: "assets.read",
      status: 200,
      latencyMs: 42,
      provider: "ai",
      providerAvailable: true,
      rlsDenialCount: 0,
    });
    restore();
  });

  /**
   * The "Never capture" list, one case per entry.
   *
   * Passed as unknown extra keys because that is how they would actually arrive —
   * a caller spreading a domain object into a log call. Each must be dropped and
   * counted rather than silently ignored.
   */
  const forbidden: { name: string; fields: Record<string, unknown> }[] = [
    { name: "email", fields: { email: "dana@example.com" } },
    { name: "full name", fields: { fullName: "Dana Example" } },
    { name: "address", fields: { address: "1 Example St" } },
    { name: "phone number", fields: { phone: "+14155552671" } },
    { name: "account identifier", fields: { accountIdentifier: "acct-1" } },
    { name: "request body", fields: { body: "raw request body" } },
    { name: "AI prompt", fields: { prompt: "system prompt text" } },
    { name: "draft recipient", fields: { recipient: "privacy@example.com" } },
    { name: "draft subject", fields: { subject: "Delete my data" } },
    { name: "personal field value", fields: { value: "secret value" } },
    { name: "access token", fields: { accessToken: "eyJhbGciOi" } },
    { name: "user id", fields: { userId: "11111111-2222-3333-4444-555555555555" } },
  ];

  for (const { name, fields } of forbidden) {
    it(`drops a ${name} and counts it`, () => {
      const { records, restore } = capture();

      const outcome = log("info", "test.event", fields);

      const key = Object.keys(fields)[0]!;
      expect(outcome.droppedKeys).toContain(key);
      expect(records[0]).not.toHaveProperty(key);
      restore();
    });
  }

  it("has no free-text message field", () => {
    // Interpolation into a message is the most reliable way personal data reaches
    // a log, so there is deliberately nowhere to put one.
    const outcome = log("info", "test.event", {
      message: "user dana@example.com failed",
    } as never);

    expect(outcome.droppedKeys).toContain("message");
    expect(JSON.stringify(outcome.record)).not.toContain("dana");
  });
});

describe("shape validation", () => {
  it("rejects a concrete route in place of a template", () => {
    // The structural check, not the scrubber, is what catches this.
    const outcome = log("info", "test.event", { route: "/requests/dana@example.com" });
    expect(outcome.record).not.toHaveProperty("route");
    expect(outcome.redactedKeys).toContain("route");
  });

  it("rejects an out-of-range status and latency", () => {
    expect(log("info", "e", { status: 99 }).redactedKeys).toContain("status");
    expect(log("info", "e", { latencyMs: -1 }).redactedKeys).toContain("latencyMs");
  });

  it("rejects an event label that is not code-shaped", () => {
    const outcome = log("info", "Failed to load dana@example.com");
    expect(outcome.record).not.toHaveProperty("event");
    expect(outcome.redactedKeys).toContain("event");
  });

  it("scrubs a restricted pattern that passes its shape check", () => {
    /**
     * Defense in depth, demonstrated on the one permissive field.
     *
     * `component` allows letters, digits, spaces, dots, and dashes — which a
     * phone number satisfies. The structural layer therefore lets it through,
     * and the scrub is what stops it. This is why neither layer is sufficient
     * alone.
     */
    const outcome = log("error", "boundary.caught", { component: "Asset 415.555.2671" });

    expect(outcome.record.component).toBe(`Asset ${REDACTED}`);
    expect(outcome.redactedKeys).toContain("component");
  });

  it("stamps level and an ISO timestamp that survives redaction", () => {
    // The ISO-instant regression: an over-eager phone pattern once stripped this.
    const outcome = log("warn", "test.event");
    expect(outcome.record.level).toBe("warn");
    expect(outcome.record.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(outcome.record.occurredAt).not.toContain(REDACTED);
    expect(outcome.redactedKeys).not.toContain("occurredAt");
  });
});

describe("failure policy", () => {
  it("does not throw when the sink throws", () => {
    // A logging call sits on a request path; observability must not fail it.
    setLogSink(() => {
      throw new Error("sink exploded");
    });

    expect(() => logger.error("test.event")).not.toThrow();
  });

  it("routes each level to the sink", () => {
    const { records, restore } = capture();

    /**
     * The disable below is for a false positive, not a real finding.
     *
     * `testing-library/no-debugging-utils` matches on the method name and cannot
     * tell this logger's `debug` level from Testing Library's `debug()` screen
     * dump. Asserting that every level reaches the sink is the point of this
     * test, so calling it through the `logger` facade is deliberate.
     */
    // eslint-disable-next-line testing-library/no-debugging-utils -- logger level, not RTL debug()
    logger.debug("a.b");
    logger.info("a.b");
    logger.warn("a.b");
    logger.error("a.b");

    expect(records.map((r) => r.level)).toEqual(["debug", "info", "warn", "error"]);
    restore();
  });

  it("returns the previous sink so callers can restore it", () => {
    const first = vi.fn();
    const second = vi.fn();

    setLogSink(first);
    const returned = setLogSink(second);
    expect(returned).toBe(first);

    logger.info("a.b");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
