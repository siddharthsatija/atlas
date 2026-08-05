import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so it is erased before `vi.mock` hoisting runs. */
import type * as LoggerModule from "@/lib/telemetry/logger";

/**
 * ATL-086 regression — monitoring ingest survives an unreachable counter store.
 *
 * The endpoint's contract is that it answers 204 to everything (see the route's
 * own comments): a telemetry sink that reported *why* it rejected an event would
 * be an oracle, and one that returned 5xx would turn a degraded dependency into
 * a visible client error on a page that is otherwise fine.
 *
 * The store is configured here and pointed at a dead port, and **nothing in the
 * rate-limit path is mocked**, so the real REST adapter really fails.
 */

const requestHeaders = { "content-type": "application/json", "x-forwarded-for": "203.0.113.29" };

/** A configured store on a port nothing listens to: refuses immediately. */
vi.mock("@/config/env", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://atlas.test",
    ATLAS_ENV: "production",
    AUDIT_HMAC_KEY: Buffer.alloc(32, 7).toString("base64"),
    RATE_LIMIT_REDIS_URL: "http://127.0.0.1:1",
    RATE_LIMIT_REDIS_TOKEN: "unreachable-fixture",
  },
}));

const { POST } = await import("./route");
const { setLogSink } = await import("@/lib/telemetry/logger");

type LogRecord = Parameters<NonNullable<Parameters<(typeof LoggerModule)["setLogSink"]>[0]>>[0];

const logged: LogRecord[] = [];

const report = () =>
  POST(
    new NextRequest("https://atlas.test/api/monitoring/error", {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ message: "render failed", digest: "abc123" }),
    }),
  );

beforeEach(() => {
  logged.length = 0;
  setLogSink((record) => logged.push(record));
});

describe("monitoring ingest during a store outage", () => {
  it("still answers 204", async () => {
    const response = await report();

    expect(response.status).toBe(204);
  });

  it("does not throw", async () => {
    await expect(report()).resolves.toBeDefined();
  });

  it("logs the outage, so the alert is not swallowed by the always-204 contract", async () => {
    /**
     * The route catches everything to guarantee its status code. That guarantee
     * must not also mean silence — an outage nobody is told about is one nobody
     * fixes.
     */
    await report();

    const outages = logged.filter((record) => record.event === "ratelimit.store_unavailable");
    expect(outages).toHaveLength(1);
    expect(outages[0]?.level).toBe("error");
  });

  it("does not label the outage as a rate limit", async () => {
    await report();

    const outage = logged.find((record) => record.event === "ratelimit.store_unavailable");
    expect(outage?.errorCode).toBeUndefined();
  });

  it("logs no caller address", async () => {
    await report();

    expect(JSON.stringify(logged)).not.toContain("203.0.113.29");
  });
});
