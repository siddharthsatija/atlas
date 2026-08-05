import type { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so both are erased before `vi.mock` hoisting runs. */
import type * as RateLimitStoreModule from "@/server/rate-limit/rate-limit-store";
import type * as MonitoringModule from "@/lib/telemetry/monitoring";

/**
 * ATL-086 — rate limiting on the monitoring ingest surface.
 *
 * The second of the two limited surfaces that exist today (the first is sign-in).
 *
 * This route keeps its always-204 contract even when refusing: ATL-095's own
 * reasoning is that a telemetry endpoint reporting *why* it rejected something
 * becomes a probing oracle, and a 429 is exactly such a report. So the assertion
 * here is that an over-limit report is **dropped** — never forwarded to the
 * collector — while the caller still sees 204.
 */

const counters = new Map<string, number>();
const forwarded: unknown[] = [];

vi.mock("@/server/rate-limit/rate-limit-store", async () => {
  const actual = await vi.importActual<typeof RateLimitStoreModule>(
    "@/server/rate-limit/rate-limit-store",
  );

  return {
    ...actual,
    createRestRateLimitStore: () => ({
      increment: (key: string, windowSeconds: number) => {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return Promise.resolve({ count: next, ttlSeconds: windowSeconds });
      },
    }),
  };
});

/** Captures what would reach the collector, without standing one up. */
vi.mock("@/lib/telemetry/monitoring", async () => {
  const actual = await vi.importActual<typeof MonitoringModule>("@/lib/telemetry/monitoring");

  return {
    ...actual,
    captureMonitoringEvent: (_config: unknown, input: unknown) => {
      forwarded.push(input);
      return Promise.resolve({ status: "delivered" });
    },
  };
});

let POST: (request: NextRequest) => Promise<NextResponse>;
let policyMax: number;

beforeAll(async () => {
  const kek = Buffer.alloc(32, 1).toString("base64");
  const auditKey = Buffer.alloc(32, 2).toString("base64");

  vi.stubEnv("ATLAS_ENV", "local");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-fixture");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-fixture");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("ATLAS_KEK", kek);
  vi.stubEnv("AUDIT_HMAC_KEY", auditKey);
  vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-fixture");
  vi.stubEnv("RATE_LIMIT_REDIS_URL", "https://counter.example.test");
  vi.stubEnv("RATE_LIMIT_REDIS_TOKEN", "redis-fixture");

  ({ POST } = await import("./route"));
  ({
    RATE_LIMIT_POLICIES: {
      monitoringIngest: { max: policyMax },
    },
  } = await import("@/server/rate-limit/rate-limit"));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const validReport = {
  boundary: "route" as const,
  route: "/assets/:id",
  errorName: "TypeError",
  occurredAt: "2026-08-04T09:15:00.000Z",
};

function ingest(address: string): Promise<NextResponse> {
  const request = new Request("http://localhost:3000/api/monitoring/error", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify(validReport),
  });
  return POST(request as unknown as NextRequest);
}

beforeEach(() => {
  counters.clear();
  forwarded.length = 0;
});

describe("monitoring ingest rate limiting", () => {
  it("forwards reports up to the limit", async () => {
    for (let i = 0; i < policyMax; i++) await ingest("203.0.113.10");
    expect(forwarded).toHaveLength(policyMax);
  });

  it("drops reports beyond the limit", async () => {
    for (let i = 0; i < policyMax; i++) await ingest("203.0.113.10");
    forwarded.length = 0;

    await ingest("203.0.113.10");
    expect(forwarded).toHaveLength(0);
  });

  it("still answers 204 when refusing, preserving the ATL-095 contract", async () => {
    // A 429 here would tell a prober that it had found a real endpoint and hit a
    // threshold. The route reports nothing, as it does for every other rejection.
    for (let i = 0; i < policyMax; i++) await ingest("203.0.113.10");

    const refused = await ingest("203.0.113.10");
    expect(refused.status).toBe(204);
  });

  it("limits per address", async () => {
    for (let i = 0; i < policyMax; i++) await ingest("203.0.113.10");
    forwarded.length = 0;

    await ingest("198.51.100.4");
    expect(forwarded).toHaveLength(1);
  });

  it("stores no raw address in the counter keys", async () => {
    await ingest("203.0.113.10");
    expect([...counters.keys()].join(" ")).not.toContain("203.0.113.10");
  });
});
