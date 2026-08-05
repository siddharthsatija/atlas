import { beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so it is erased before `vi.mock` hoisting runs. */
import type * as RateLimitStoreModule from "@/server/rate-limit/rate-limit-store";

/**
 * ATL-086 — rate limiting on the sign-in surface.
 *
 * Separate from `actions.integration.test.ts` because that suite deliberately
 * runs with **no** counter store configured, so the limiter is disabled and the
 * return-path assertions it exists for are not entangled with limit state. This
 * file configures a store and asserts the limit actually bites.
 *
 * The ticket calls for "integration tests hitting each limited surface". This is
 * the sign-in surface; the monitoring ingest surface is covered in
 * `src/app/api/monitoring/error/route.integration.test.ts`.
 */

const signInWithOtp = vi.fn();
const signInWithOAuth = vi.fn();
const cookieStore = { get: vi.fn(), getAll: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };

let requestHeaders = new Headers();

vi.mock("@/server/auth/supabase-server-client", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { signInWithOtp, signInWithOAuth } }),
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

vi.mock("@/config/env", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://atlas.test",
    ATLAS_ENV: "production",
    AUDIT_HMAC_KEY: Buffer.alloc(32, 6).toString("base64"),
    RATE_LIMIT_REDIS_URL: "https://counter.example.test",
    RATE_LIMIT_REDIS_TOKEN: "test-token",
  },
}));

/**
 * A shared in-memory counter standing in for the REST store.
 *
 * The limiter constructs its store through `createRestRateLimitStore`, so that
 * factory is what gets replaced — the limiter's own logic, key derivation, and
 * policy resolution all remain the real thing.
 */
const counters = new Map<string, number>();

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

const { requestMagicLinkAction } = await import("./actions");
const { INITIAL_MAGIC_LINK_STATE } = await import("./form-state");
const { RATE_LIMIT_POLICIES } = await import("@/server/rate-limit/rate-limit");

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

async function requestLink(email: string) {
  return requestMagicLinkAction(INITIAL_MAGIC_LINK_STATE, formData({ email }));
}

beforeEach(() => {
  counters.clear();
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.9" });
  signInWithOtp.mockReset();
  signInWithOtp.mockResolvedValue({ data: {}, error: null });
});

describe("sign-in rate limiting", () => {
  it("allows requests up to the policy limit", async () => {
    for (let i = 0; i < RATE_LIMIT_POLICIES.signIn.max; i++) {
      const result = await requestLink(`user${i}@example.com`);
      expect(result.code).toBe("verification_sent");
    }
  });

  it("refuses beyond the limit with the neutral rate_limited code", async () => {
    for (let i = 0; i < RATE_LIMIT_POLICIES.signIn.max; i++) {
      await requestLink(`user${i}@example.com`);
    }

    const refused = await requestLink("one-more@example.com");
    expect(refused.code).toBe("rate_limited");
  });

  it("does not contact the provider once refused", async () => {
    // Checked before the provider call, so a refused attempt sends no mail and
    // costs nothing downstream.
    for (let i = 0; i < RATE_LIMIT_POLICIES.signIn.max; i++) {
      await requestLink(`user${i}@example.com`);
    }
    signInWithOtp.mockClear();

    await requestLink("one-more@example.com");
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("limits one inbox even when the requests come from many addresses", async () => {
    // The distributed inbox-bombing case, caught by the email key.
    for (let i = 0; i < RATE_LIMIT_POLICIES.signIn.max; i++) {
      requestHeaders = new Headers({ "x-forwarded-for": `198.51.100.${i}` });
      await requestLink("victim@example.com");
    }

    requestHeaders = new Headers({ "x-forwarded-for": "198.51.100.200" });
    expect((await requestLink("victim@example.com")).code).toBe("rate_limited");
  });

  it("treats the address case-insensitively", async () => {
    // Otherwise varying capitalisation would reset the per-address counter.
    for (let i = 0; i < RATE_LIMIT_POLICIES.signIn.max; i++) {
      requestHeaders = new Headers({ "x-forwarded-for": `198.51.100.${i}` });
      await requestLink("Victim@Example.com");
    }

    requestHeaders = new Headers({ "x-forwarded-for": "198.51.100.200" });
    expect((await requestLink("victim@example.com  ".trim())).code).toBe("rate_limited");
  });

  it("keeps separate users on separate counters", async () => {
    for (let i = 0; i < RATE_LIMIT_POLICIES.signIn.max; i++) {
      await requestLink(`user${i}@example.com`);
    }

    requestHeaders = new Headers({ "x-forwarded-for": "192.0.2.55" });
    expect((await requestLink("someone-else@example.com")).code).toBe("verification_sent");
  });

  it("still validates the address before consuming any limit", async () => {
    const result = await requestMagicLinkAction(INITIAL_MAGIC_LINK_STATE, formData({}));
    expect(result.code).toBe("invalid_email");
    expect(counters.size).toBe(0);
  });

  it("stores no raw address or email in the counter keys", async () => {
    await requestLink("dana@example.com");

    const keys = [...counters.keys()].join(" ");
    expect(keys).not.toContain("dana@example.com");
    expect(keys).not.toContain("203.0.113.9");
  });
});
