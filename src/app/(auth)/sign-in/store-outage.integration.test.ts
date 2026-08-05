import { beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so it is erased before `vi.mock` hoisting runs. */
import type * as LoggerModule from "@/lib/telemetry/logger";

/**
 * ATL-086 regression — sign-in survives an unreachable rate-limit store.
 *
 * The E2E suite caught this: with a *configured but unreachable* counter store,
 * submitting the sign-in form rendered the global error boundary instead of the
 * neutral "Check your email" state.
 *
 * The approved decision is **fail open + alert**: an outage of the counter store
 * must never lock users out. `actions.integration.test.ts` runs with the store
 * unconfigured, so the limiter short-circuits before touching it — which is
 * exactly the path that cannot catch this. Here the store is configured and
 * pointed at a dead port, and **nothing in the rate-limit path is mocked**, so
 * the real REST adapter really fails.
 */

const signInWithOtp = vi.fn();
const cookieStore = { get: vi.fn(), getAll: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };
let requestHeaders = new Headers();

vi.mock("@/server/auth/supabase-server-client", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { signInWithOtp } }),
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve(requestHeaders),
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("REDIRECT");
  },
}));

/**
 * A configured store on a port nothing listens to.
 *
 * `127.0.0.1:1` refuses immediately, so the adapter fails fast rather than
 * waiting out its own timeout and slowing the suite.
 */
vi.mock("@/config/env", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://atlas.test",
    ATLAS_ENV: "production",
    AUDIT_HMAC_KEY: Buffer.alloc(32, 7).toString("base64"),
    RATE_LIMIT_REDIS_URL: "http://127.0.0.1:1",
    RATE_LIMIT_REDIS_TOKEN: "unreachable-fixture",
  },
}));

const { requestMagicLinkAction } = await import("./actions");
const { INITIAL_MAGIC_LINK_STATE } = await import("./form-state");
const { setLogSink } = await import("@/lib/telemetry/logger");
const { RATE_LIMIT_POLICIES } = await import("@/server/rate-limit/rate-limit");

type LogRecord = Parameters<NonNullable<Parameters<(typeof LoggerModule)["setLogSink"]>[0]>>[0];

const logged: LogRecord[] = [];

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

const requestLink = (email: string) =>
  requestMagicLinkAction(INITIAL_MAGIC_LINK_STATE, formData({ email }));

beforeEach(() => {
  logged.length = 0;
  setLogSink((record) => logged.push(record));
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.11" });
  signInWithOtp.mockReset();
  signInWithOtp.mockResolvedValue({ data: {}, error: null });
});

describe("store outage", () => {
  it("does not throw", async () => {
    // The defect the E2E run surfaced: a throw here reaches the global error
    // boundary, which is both a lockout and an alarming page for a user who did
    // nothing wrong.
    await expect(requestLink("dana@example.com")).resolves.toBeDefined();
  });

  it("returns the neutral verification state", async () => {
    const result = await requestLink("dana@example.com");

    expect(result.code).toBe("verification_sent");
  });

  it("still contacts the provider, so the link is actually sent", async () => {
    // Failing open has to mean the request proceeds — not that it is silently
    // dropped while reporting success.
    await requestLink("dana@example.com");

    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });

  it("answers identically for every address", async () => {
    /**
     * Security §5: the response must not reveal whether an address is
     * registered. A degraded limiter must not become an oracle by behaving
     * differently for one address than another.
     */
    const first = await requestLink("known@example.com");
    const second = await requestLink("unknown@example.com");

    expect(first.code).toBe(second.code);
  });

  it("logs the outage once per check, at error level", async () => {
    await requestLink("dana@example.com");

    const outages = logged.filter((r) => r.event === "ratelimit.store_unavailable");
    expect(outages).toHaveLength(1);
    expect(outages[0]?.level).toBe("error");
  });

  it("logs no identifier, and does not mislabel the outage as a rate limit", async () => {
    /**
     * The log line previously carried `errorCode: "RATE_LIMITED"`, which is what
     * made an outage read as a limit being hit — two different incidents wearing
     * the same word. A store outage is a dependency failure; `RATE_LIMITED` is a
     * user being throttled, and conflating them sends an operator looking for
     * abuse that is not happening.
     */
    await requestLink("dana@example.com");

    const outage = logged.find((r) => r.event === "ratelimit.store_unavailable");
    expect(outage?.errorCode).toBeUndefined();

    const serialised = JSON.stringify(logged);
    expect(serialised).not.toContain("dana@example.com");
    expect(serialised).not.toContain("203.0.113.11");
  });
});

describe("the limit still works when the store does", () => {
  it("returns rate_limited when a reachable store reports over the limit", async () => {
    /**
     * Guards the other direction: failing open must not have become "always
     * open". Uses the limiter directly with a store that reports a count past
     * the policy maximum, which is what a real over-limit response looks like.
     */
    const { RateLimiter } = await import("@/server/rate-limit/rate-limit");

    const overLimit = new RateLimiter({
      store: {
        increment: () =>
          Promise.resolve({ count: RATE_LIMIT_POLICIES.signIn.max + 1, ttlSeconds: 900 }),
      },
      hmacKey: Buffer.alloc(32, 7),
      enabled: true,
    });

    const decision = await overLimit.check(RATE_LIMIT_POLICIES.signIn, [
      { kind: "ip", value: "203.0.113.11" },
    ]);

    expect(decision.allowed).toBe(false);
    expect(decision.degraded).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });
});
