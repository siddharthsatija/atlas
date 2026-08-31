import { describe, expect, it, vi } from "vitest";

/**
 * Unit tests for branches not exercised by the integration suite
 * (rate-limit.integration.test.ts, which runs under the `server`/node project).
 *
 * Integration coverage already includes: window semantics, pseudonymisation,
 * clientAddressFrom (all four header cases), RateLimitStoreUnavailableError
 * fail-open + logging, resolvePolicy invalid-max guard, enabled=false / null-store
 * paths.
 *
 * Branches targeted here:
 *   - resolvePolicy: invalid windowSeconds (non-integer, zero, negative)
 *   - RateLimiter.check: non-RateLimitStoreUnavailableError must rethrow
 */

// server-only throws in jsdom. This test exercises pure logic that does not
// depend on the deployment boundary, so the guard is suppressed here.
vi.mock("server-only", () => ({}));

const HMAC_KEY = Buffer.alloc(32, 7).toString("base64");

vi.mock("@/config/env", () => ({
  env: {
    AUDIT_HMAC_KEY: HMAC_KEY,
    RATE_LIMIT_REDIS_URL: undefined,
    RATE_LIMIT_REDIS_TOKEN: undefined,
  },
}));

const { RateLimiter, resolvePolicy } = await import("./rate-limit");

const BASE_POLICY = { name: "unit_test", max: 5, windowSeconds: 60 } as const;

// ── resolvePolicy: windowSeconds guard ───────────────────────────────────────

describe("resolvePolicy — windowSeconds guard", () => {
  /**
   * The max guard is already tested in the integration suite. The windowSeconds
   * guard (Number.isInteger && > 0) is structurally identical but its branches
   * were not independently covered. A malformed override must fall back to the
   * documented default, never silently shorten or disable the window.
   */
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["float", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Infinity],
  ])("ignores a %s windowSeconds override and keeps the policy default", (_label, bad) => {
    const resolved = resolvePolicy(BASE_POLICY, { windowSeconds: bad });
    expect(resolved.windowSeconds).toBe(BASE_POLICY.windowSeconds);
    // Confirm the policy name is preserved — the override must not mutate identity.
    expect(resolved.name).toBe(BASE_POLICY.name);
  });

  it("applies a valid positive-integer windowSeconds override", () => {
    const resolved = resolvePolicy(BASE_POLICY, { windowSeconds: 30 });
    expect(resolved.windowSeconds).toBe(30);
  });

  it("applies valid max and windowSeconds overrides simultaneously", () => {
    const resolved = resolvePolicy(BASE_POLICY, { max: 2, windowSeconds: 120 });
    expect(resolved).toMatchObject({ max: 2, windowSeconds: 120, name: BASE_POLICY.name });
  });
});

// ── RateLimiter.check: non-RateLimitStoreUnavailableError must rethrow ───────

describe("RateLimiter.check — unrecognized store errors must rethrow", () => {
  /**
   * Security boundary: ONLY RateLimitStoreUnavailableError triggers the
   * fail-open (degraded) path. Any other thrown value — a programming bug,
   * an unexpected library exception — must propagate so it is not silently
   * swallowed as a routine outage and rate-limiting protection is not silently
   * removed without an alert.
   */
  function limiterWith(storeError: Error) {
    return new RateLimiter({
      store: { increment: vi.fn(() => Promise.reject(storeError)) },
      hmacKey: Buffer.from(HMAC_KEY, "base64"),
      enabled: true,
    });
  }

  it("rethrows a plain Error rather than treating it as a store outage", async () => {
    const unexpected = new Error("unexpected internal failure");
    await expect(
      limiterWith(unexpected).check(BASE_POLICY, [{ kind: "ip", value: "1.2.3.4" }]),
    ).rejects.toThrow(unexpected);
  });

  it("rethrows even when the message superficially resembles an outage message", async () => {
    // instanceof RateLimitStoreUnavailableError is the only gate, not message matching.
    const lookalike = new Error("rate limit store unavailable");
    await expect(
      limiterWith(lookalike).check(BASE_POLICY, [{ kind: "ip", value: "10.0.0.1" }]),
    ).rejects.toThrow(lookalike);
  });

  it("rethrows a TypeError rather than resolving as degraded", async () => {
    // Belt-and-suspenders: confirm the promise rejects, not resolves with degraded=true.
    const typeError = new TypeError("internal type error");
    const result = limiterWith(typeError).check(BASE_POLICY, [
      { kind: "ip", value: "192.168.1.1" },
    ]);
    await expect(result).rejects.toThrow(typeError);
  });

  it("propagates immediately on the first identifier that throws an unrecognized error", async () => {
    // For RateLimitStoreUnavailableError, every identifier is incremented even
    // after one fails — to avoid counter undercount. For unrecognized errors the
    // throw propagates immediately from inside the for-loop.
    const hard = new Error("hard failure");
    const store = { increment: vi.fn(() => Promise.reject(hard)) };
    const rl = new RateLimiter({
      store,
      hmacKey: Buffer.from(HMAC_KEY, "base64"),
      enabled: true,
    });

    await expect(
      rl.check(BASE_POLICY, [
        { kind: "ip", value: "1.1.1.1" },
        { kind: "email", value: "user@example.test" },
      ]),
    ).rejects.toThrow(hard);
  });
});
