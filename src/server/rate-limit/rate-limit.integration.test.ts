import { beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so it is erased before `vi.mock` hoisting runs. */
import type { RateLimiterConfig } from "./rate-limit";

/**
 * ATL-086 — the rate limiter.
 *
 * Exercised against the in-memory store, which mirrors the fixed-window
 * semantics the REST adapter gets from `INCR` + `EXPIRE ... NX`: the window
 * opens on first increment and its expiry is never extended. Mirroring that
 * matters, because a sliding window would let a caller who keeps knocking hold
 * their own window open forever — the opposite of what the limit is for.
 *
 * The REST adapter's own wire behaviour is covered separately below.
 */

const HMAC_KEY = Buffer.alloc(32, 5).toString("base64");

vi.mock("@/config/env", () => ({
  env: {
    AUDIT_HMAC_KEY: HMAC_KEY,
    RATE_LIMIT_REDIS_URL: "https://counter.example.test",
    RATE_LIMIT_REDIS_TOKEN: "test-token",
  },
}));

const { RATE_LIMIT_POLICIES, RateLimiter, clientAddressFrom, resolvePolicy } =
  await import("./rate-limit");
const { RateLimitStoreUnavailableError, createMemoryRateLimitStore, createRestRateLimitStore } =
  await import("./rate-limit-store");
const { setLogSink } = await import("@/lib/telemetry/logger");

const POLICY = { name: "test", max: 3, windowSeconds: 60 };

let clock = 0;

function limiter(overrides: Partial<RateLimiterConfig> = {}) {
  return new RateLimiter({
    store: createMemoryRateLimitStore(() => clock),
    hmacKey: Buffer.from(HMAC_KEY, "base64"),
    enabled: true,
    ...overrides,
  });
}

const ip = (value: string) => [{ kind: "ip", value }];

beforeEach(() => {
  clock = 1_000_000;
  setLogSink(() => {});
});

describe("window behaviour", () => {
  it("allows up to the limit and refuses beyond it", async () => {
    const rl = limiter();

    for (let i = 0; i < POLICY.max; i++) {
      expect((await rl.check(POLICY, ip("1.2.3.4"))).allowed).toBe(true);
    }

    expect((await rl.check(POLICY, ip("1.2.3.4"))).allowed).toBe(false);
  });

  it("reports how long to wait", async () => {
    const rl = limiter();
    for (let i = 0; i <= POLICY.max; i++) await rl.check(POLICY, ip("1.2.3.4"));

    const decision = await rl.check(POLICY, ip("1.2.3.4"));
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(POLICY.windowSeconds);
  });

  it("does not extend the window when a blocked caller keeps knocking", async () => {
    /**
     * The property that separates a fixed window from a sliding one. If each
     * refused attempt pushed the expiry out, a caller hammering the endpoint
     * would never be let back in — and the limit would become a permanent ban
     * triggered by exactly the behaviour it is meant to slow down.
     */
    const rl = limiter();
    for (let i = 0; i <= POLICY.max; i++) await rl.check(POLICY, ip("1.2.3.4"));

    clock += 30_000;
    await rl.check(POLICY, ip("1.2.3.4"));

    clock += 31_000; // past the original 60s window
    expect((await rl.check(POLICY, ip("1.2.3.4"))).allowed).toBe(true);
  });

  it("resets after the window elapses", async () => {
    const rl = limiter();
    for (let i = 0; i <= POLICY.max; i++) await rl.check(POLICY, ip("1.2.3.4"));

    clock += POLICY.windowSeconds * 1000 + 1;
    expect((await rl.check(POLICY, ip("1.2.3.4"))).allowed).toBe(true);
  });

  it("counts each identifier separately", async () => {
    const rl = limiter();
    for (let i = 0; i <= POLICY.max; i++) await rl.check(POLICY, ip("1.2.3.4"));

    expect((await rl.check(POLICY, ip("5.6.7.8"))).allowed).toBe(true);
  });

  it("counts each policy separately", async () => {
    const rl = limiter();
    for (let i = 0; i <= POLICY.max; i++) await rl.check(POLICY, ip("1.2.3.4"));

    const other = { name: "other", max: 3, windowSeconds: 60 };
    expect((await rl.check(other, ip("1.2.3.4"))).allowed).toBe(true);
  });
});

describe("multiple identifiers", () => {
  it("refuses when any single key is exhausted", async () => {
    const rl = limiter();
    const shared = { kind: "email", value: "dana@example.com" };

    // Exhaust the email key from several addresses — the distributed attack.
    for (let i = 0; i <= POLICY.max; i++) {
      await rl.check(POLICY, [{ kind: "ip", value: `10.0.0.${i}` }, shared]);
    }

    const fresh = await rl.check(POLICY, [{ kind: "ip", value: "10.0.99.1" }, shared]);
    expect(fresh.allowed).toBe(false);
  });

  it("refuses a single host spraying many addresses", async () => {
    const rl = limiter();
    const host = { kind: "ip", value: "1.2.3.4" };

    for (let i = 0; i <= POLICY.max; i++) {
      await rl.check(POLICY, [host, { kind: "email", value: `victim${i}@example.com` }]);
    }

    const next = await rl.check(POLICY, [host, { kind: "email", value: "another@example.com" }]);
    expect(next.allowed).toBe(false);
  });

  it("increments every identifier even once one is over the limit", async () => {
    /**
     * Short-circuiting would let an attacker keep a second counter permanently
     * below its threshold by ensuring the first always trips first.
     */
    const rl = limiter();
    const host = { kind: "ip", value: "1.2.3.4" };
    const email = { kind: "email", value: "dana@example.com" };

    for (let i = 0; i < 10; i++) await rl.check(POLICY, [host, email]);

    // The email key must have been counted too, not skipped behind the IP key.
    expect((await rl.check(POLICY, [{ kind: "ip", value: "9.9.9.9" }, email])).allowed).toBe(false);
  });

  it("allows when no identifier is supplied", async () => {
    // Nothing to key on is not the same as being over the limit.
    expect((await limiter().check(POLICY, [])).allowed).toBe(true);
  });
});

describe("identifier pseudonymisation", () => {
  it("never puts a raw identifier in the store key", async () => {
    const seen: string[] = [];
    const rl = new RateLimiter({
      store: {
        increment: (key: string) => {
          seen.push(key);
          return Promise.resolve({ count: 1, ttlSeconds: 60 });
        },
      },
      hmacKey: Buffer.from(HMAC_KEY, "base64"),
      enabled: true,
    });

    await rl.check(POLICY, [
      { kind: "ip", value: "203.0.113.7" },
      { kind: "email", value: "dana@example.com" },
    ]);

    expect(seen.join(" ")).not.toContain("203.0.113.7");
    expect(seen.join(" ")).not.toContain("dana@example.com");
    expect(seen.every((k) => /^rl:test:(ip|email):[0-9a-f]{32}$/.test(k))).toBe(true);
  });

  it("is stable for the same identifier and distinct across identifiers", async () => {
    const seen: string[] = [];
    const store = {
      increment: (key: string) => {
        seen.push(key);
        return Promise.resolve({ count: 1, ttlSeconds: 60 });
      },
    };
    const rl = new RateLimiter({
      store,
      hmacKey: Buffer.from(HMAC_KEY, "base64"),
      enabled: true,
    });

    await rl.check(POLICY, ip("1.2.3.4"));
    await rl.check(POLICY, ip("1.2.3.4"));
    await rl.check(POLICY, ip("5.6.7.8"));

    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).not.toBe(seen[2]);
  });
});

describe("store outage", () => {
  const brokenStore = {
    increment: () => Promise.reject(new RateLimitStoreUnavailableError()),
  };

  it("fails open so a counter outage cannot lock users out", async () => {
    /**
     * The documented trade (ATL-086). Failing closed would let an attacker
     * degrade one dependency and take down authentication entirely — a cheaper
     * denial of service than the abuse this defends against.
     */
    const rl = new RateLimiter({
      store: brokenStore,
      hmacKey: Buffer.from(HMAC_KEY, "base64"),
      enabled: true,
    });

    const decision = await rl.check(POLICY, ip("1.2.3.4"));
    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
  });

  it("raises an error-level alert, which is what bounds the exposure", async () => {
    const records: { level: string; event: string }[] = [];
    setLogSink((record) => records.push(record));

    const rl = new RateLimiter({
      store: brokenStore,
      hmacKey: Buffer.from(HMAC_KEY, "base64"),
      enabled: true,
    });
    await rl.check(POLICY, ip("1.2.3.4"));

    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", event: "ratelimit.store_unavailable" }),
    );
  });

  it("does not log the identifier it was checking", async () => {
    const records: unknown[] = [];
    setLogSink((record) => records.push(record));

    const rl = new RateLimiter({
      store: brokenStore,
      hmacKey: Buffer.from(HMAC_KEY, "base64"),
      enabled: true,
    });
    await rl.check(POLICY, [{ kind: "ip", value: "203.0.113.7" }]);

    expect(JSON.stringify(records)).not.toContain("203.0.113.7");
  });

  it("allows when no store is configured", async () => {
    // Local development and CI have no counter service.
    const rl = new RateLimiter({
      store: null,
      hmacKey: Buffer.from(HMAC_KEY, "base64"),
      enabled: false,
    });

    expect((await rl.check(POLICY, ip("1.2.3.4"))).allowed).toBe(true);
  });
});

describe("policy configuration", () => {
  it("uses documented defaults when nothing is overridden", () => {
    expect(resolvePolicy(RATE_LIMIT_POLICIES.signIn)).toEqual({
      name: "signin",
      max: 5,
      windowSeconds: 15 * 60,
    });
  });

  it("applies per-environment overrides", () => {
    const resolved = resolvePolicy(RATE_LIMIT_POLICIES.signIn, { max: 2, windowSeconds: 30 });
    expect(resolved).toMatchObject({ max: 2, windowSeconds: 30 });
  });

  it("ignores an invalid override rather than disabling the limit", () => {
    // The failure direction that matters: a malformed value must not silently
    // remove the protection.
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      expect(resolvePolicy(RATE_LIMIT_POLICIES.signIn, { max: bad }).max).toBe(5);
    }
  });

  it("keeps the sign-in limit at the value security §5 was implemented with", () => {
    expect(RATE_LIMIT_POLICIES.signIn).toMatchObject({ max: 5, windowSeconds: 900 });
  });
});

describe("clientAddressFrom", () => {
  it("takes the right-most forwarded hop, not the left-most", () => {
    /**
     * `x-forwarded-for` is appended to by each proxy, so the left-most entry is
     * whatever the caller claimed. Trusting it would let an attacker rotate a
     * header value and reset their own counter at will.
     */
    const headers = new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" });
    expect(clientAddressFrom(headers)).toBe("3.3.3.3");
  });

  it("falls back to x-real-ip", () => {
    expect(clientAddressFrom(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("returns null when no address is present", () => {
    expect(clientAddressFrom(new Headers())).toBeNull();
  });

  it("ignores an empty forwarded header", () => {
    expect(clientAddressFrom(new Headers({ "x-forwarded-for": " , " }))).toBeNull();
  });
});

describe("REST store adapter", () => {
  function respondWith(body: unknown, ok = true) {
    return vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve({ ok, json: () => Promise.resolve(body) } as unknown as Response),
    );
  }

  it("returns the count and ttl from the pipeline", async () => {
    const fetchImpl = respondWith([{ result: 3 }, { result: 1 }, { result: 42 }]);
    const store = createRestRateLimitStore({
      endpoint: "https://counter.example.test",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await store.increment("k", 60)).toEqual({ count: 3, ttlSeconds: 42 });
  });

  it("sets the expiry with NX so the window cannot slide", async () => {
    const fetchImpl = respondWith([{ result: 1 }, { result: 1 }, { result: 60 }]);
    const store = createRestRateLimitStore({
      endpoint: "https://counter.example.test",
      token: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await store.increment("k", 60);

    const body = fetchImpl.mock.calls[0]?.[1].body;
    expect(typeof body === "string" ? body : "").toContain('["EXPIRE","k","60","NX"]');
  });

  it("sends the credential as a header, never in the URL", async () => {
    // Security §19: sensitive values must not travel in URLs, which are the part
    // most likely to reach a proxy log.
    const fetchImpl = respondWith([{ result: 1 }, { result: 1 }, { result: 60 }]);
    const store = createRestRateLimitStore({
      endpoint: "https://counter.example.test",
      token: "super-secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await store.increment("k", 60);

    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).not.toContain("super-secret");
    expect((call?.[1].headers as Record<string, string>).authorization).toBe("Bearer super-secret");
  });

  it("treats a non-2xx response as an outage", async () => {
    const store = createRestRateLimitStore({
      endpoint: "https://counter.example.test",
      token: "t",
      fetchImpl: respondWith([], false) as unknown as typeof fetch,
    });

    await expect(store.increment("k", 60)).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
  });

  it("treats a malformed body as an outage", async () => {
    const store = createRestRateLimitStore({
      endpoint: "https://counter.example.test",
      token: "t",
      fetchImpl: respondWith({ not: "an array" }) as unknown as typeof fetch,
    });

    await expect(store.increment("k", 60)).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
  });

  it("treats a network failure as an outage", async () => {
    const store = createRestRateLimitStore({
      endpoint: "https://counter.example.test",
      token: "t",
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    await expect(store.increment("k", 60)).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
  });

  it("falls back to the full window when the ttl is unusable", async () => {
    // -1 (no expiry) and -2 (no key) both mean the window is not what we think.
    // Reporting the full window never tells a caller to retry sooner than it should.
    const store = createRestRateLimitStore({
      endpoint: "https://counter.example.test",
      token: "t",
      fetchImpl: respondWith([
        { result: 2 },
        { result: 0 },
        { result: -1 },
      ]) as unknown as typeof fetch,
    });

    expect((await store.increment("k", 90)).ttlSeconds).toBe(90);
  });
});
