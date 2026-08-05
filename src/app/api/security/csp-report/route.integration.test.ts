import type { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so it is erased before `vi.mock` hoisting runs. */
import type * as RateLimitStoreModule from "@/server/rate-limit/rate-limit-store";
import type * as LoggerModule from "@/lib/telemetry/logger";

/**
 * ATL-087 — the CSP violation report path.
 *
 * The acceptance criteria call for this path to be *verified*, and the thing
 * worth verifying is not that reports arrive — it is what survives the journey.
 * A violation report is unauthenticated, attacker-influenceable, and full of
 * URLs, so most of these assertions are about what is deliberately discarded.
 */

const counters = new Map<string, number>();
const logged: { event: string; directive?: string }[] = [];

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

let POST: (request: NextRequest) => Promise<NextResponse>;
let setLogSink: (typeof LoggerModule)["setLogSink"];
let ingestMax: number;

beforeAll(async () => {
  vi.stubEnv("ATLAS_ENV", "local");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-fixture");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-fixture");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("ATLAS_KEK", Buffer.alloc(32, 1).toString("base64"));
  vi.stubEnv("AUDIT_HMAC_KEY", Buffer.alloc(32, 2).toString("base64"));
  vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-fixture");
  vi.stubEnv("RATE_LIMIT_REDIS_URL", "https://counter.example.test");
  vi.stubEnv("RATE_LIMIT_REDIS_TOKEN", "redis-fixture");

  ({ POST } = await import("./route"));
  ({ setLogSink } = await import("@/lib/telemetry/logger"));
  ({
    RATE_LIMIT_POLICIES: {
      monitoringIngest: { max: ingestMax },
    },
  } = await import("@/server/rate-limit/rate-limit"));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function report(body: unknown, address = "203.0.113.20"): Promise<NextResponse> {
  const request = new Request("http://localhost:3000/api/security/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report", "x-forwarded-for": address },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

/** A URL carrying exactly the kind of value that must never be logged. */
const POISONED_URL = "https://atlas.test/requests?email=dana@example.com&token=sk_live_9f2b7c1d";

const legacyReport = {
  "csp-report": {
    "document-uri": POISONED_URL,
    referrer: POISONED_URL,
    "violated-directive": "script-src 'self'",
    "effective-directive": "script-src",
    "original-policy": "script-src 'self'",
    "blocked-uri": "https://evil.example/x.js?u=dana@example.com",
    "source-file": "/srv/atlas/personal-fields.ts",
  },
};

beforeEach(() => {
  counters.clear();
  logged.length = 0;
  setLogSink((record) => logged.push(record));
});

describe("accepted reports", () => {
  it("records the violated directive from a legacy report", async () => {
    await report(legacyReport);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ event: "csp.violation", directive: "script-src" });
  });

  it("records the directive from a Reporting API batch", async () => {
    await report([
      {
        type: "csp-violation",
        body: { documentURL: POISONED_URL, effectiveDirective: "style-src" },
      },
    ]);

    expect(logged[0]).toMatchObject({ event: "csp.violation", directive: "style-src" });
  });

  it("strips the value from a legacy violated-directive", async () => {
    // Historically `violated-directive` carried the whole directive including
    // its value, e.g. "script-src 'self'". Only the name is useful.
    await report({ "csp-report": { "violated-directive": "img-src 'self' data:" } });
    expect(logged[0]?.directive).toBe("img-src");
  });
});

describe("what the report path discards", () => {
  it("logs no URL from the report", async () => {
    /**
     * The assertion this endpoint exists to satisfy. `document-uri`, `referrer`,
     * and `blocked-uri` are full URLs an attacker can partly choose, arriving
     * unauthenticated. None of them reach a log sink.
     */
    await report(legacyReport);

    const serialised = JSON.stringify(logged);
    for (const fragment of [
      "dana@example.com",
      "sk_live_9f2b7c1d",
      "evil.example",
      "personal-fields.ts",
      "atlas.test/requests",
    ]) {
      expect(serialised).not.toContain(fragment);
    }
  });

  it("logs only the allowlisted fields", async () => {
    await report(legacyReport);

    // The ATL-085 allowlist is the guard: anything not named is dropped.
    expect(Object.keys(logged[0] ?? {}).sort()).toEqual([
      "count",
      "directive",
      "event",
      "level",
      "occurredAt",
    ]);
  });

  it("drops a directive that is not directive-shaped", async () => {
    // A caller controls this string, so it is validated like any other input.
    await report({ "csp-report": { "effective-directive": "<script>alert(1)</script>" } });
    expect(logged[0]).not.toHaveProperty("directive");
  });
});

describe("always 204", () => {
  it.each([
    ["a valid report", legacyReport],
    ["an unparseable body", "not json at all"],
    ["an empty object", {}],
    ["an unrecognised shape", { hello: "world" }],
    ["an empty Reporting API batch", []],
  ])("answers 204 for %s", async (_name, body) => {
    // An endpoint that reported *why* it rejected something would be a probing
    // oracle, and a browser has no use for the answer.
    expect((await report(body)).status).toBe(204);
  });

  it("logs nothing for a malformed report", async () => {
    await report("not json at all");
    expect(logged).toHaveLength(0);
  });
});

describe("abuse resistance", () => {
  it("is rate limited, because its URL is published in every response", async () => {
    for (let i = 0; i < ingestMax; i++) await report(legacyReport);
    logged.length = 0;

    await report(legacyReport);
    expect(logged).toHaveLength(0);
  });

  it("still answers 204 when rate limited", async () => {
    for (let i = 0; i < ingestMax; i++) await report(legacyReport);
    expect((await report(legacyReport)).status).toBe(204);
  });

  it("drops an oversized body unread", async () => {
    const huge = JSON.stringify({
      "csp-report": { "effective-directive": "script-src", padding: "x".repeat(20_000) },
    });

    expect((await report(huge)).status).toBe(204);
    expect(logged).toHaveLength(0);
  });

  it("stores no raw address in the rate-limit keys", async () => {
    await report(legacyReport, "198.51.100.77");
    expect([...counters.keys()].join(" ")).not.toContain("198.51.100.77");
  });
});
