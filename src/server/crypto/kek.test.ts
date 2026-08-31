import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for KEK resolution (ATL-084, ADR-003).
 *
 * No unit test previously existed for this module. The functions are pure
 * env-reads (with HMAC-free key decoding), so all paths are covered without
 * touching any real secret material — synthetic 32-byte all-zero/all-one
 * buffers are adequate because the tests verify selection logic, not crypto.
 *
 * Why these tests must exist independent of coverage numbers:
 *
 *  - `kekForVersion` is the single gate between a DEK's recorded version and the
 *    key actually used to unwrap it. The fail-closed path (throw `invalid_key`
 *    on an unknown version) is what turns a rotation misconfiguration into a loud
 *    error rather than a silent success with the wrong key.
 *
 *  - `previousKek` must return null for a partial pair so an incomplete rotation
 *    does not silently expose half-configured key material as if it were usable.
 */

// server-only is suppressed: kek.ts marks itself server-only so the Next.js
// build rejects client imports, but the logic is plain key-selection and
// does not depend on the deployment boundary being enforced at test time.
vi.mock("server-only", () => ({}));

// Two distinct synthetic keys — not real secrets. 32 bytes each (base64-encoded)
// so decodeKek's Buffer.from(encoded, "base64").length check passes.
const CURRENT_KEY_B64 = Buffer.alloc(32, 0x01).toString("base64");
const PREVIOUS_KEY_B64 = Buffer.alloc(32, 0x02).toString("base64");

// ── currentKek ────────────────────────────────────────────────────────────────

describe("currentKek", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the decoded current KEK with its version", async () => {
    vi.doMock("@/config/env", () => ({
      env: { ATLAS_KEK: CURRENT_KEY_B64, ATLAS_KEK_VERSION: 3 },
    }));
    const { currentKek } = await import("./kek");
    const gen = currentKek();
    expect(gen.version).toBe(3);
    expect(Buffer.isBuffer(gen.key)).toBe(true);
    expect(gen.key).toHaveLength(32);
    expect(gen.key.equals(Buffer.alloc(32, 0x01))).toBe(true);
  });
});

// ── previousKek ───────────────────────────────────────────────────────────────

describe("previousKek", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null when neither previous key nor version is configured", async () => {
    vi.doMock("@/config/env", () => ({
      env: {
        ATLAS_KEK: CURRENT_KEY_B64,
        ATLAS_KEK_VERSION: 1,
        ATLAS_KEK_PREVIOUS: undefined,
        ATLAS_KEK_PREVIOUS_VERSION: undefined,
      },
    }));
    const { previousKek } = await import("./kek");
    expect(previousKek()).toBeNull();
  });

  it("returns null when ATLAS_KEK_PREVIOUS is set but ATLAS_KEK_PREVIOUS_VERSION is missing", async () => {
    // A partial pair — the rotation was started (key material uploaded) but the
    // version was not yet configured. This must not return a partially-configured
    // generation as if it were usable.
    vi.doMock("@/config/env", () => ({
      env: {
        ATLAS_KEK: CURRENT_KEY_B64,
        ATLAS_KEK_VERSION: 2,
        ATLAS_KEK_PREVIOUS: PREVIOUS_KEY_B64,
        ATLAS_KEK_PREVIOUS_VERSION: undefined,
      },
    }));
    const { previousKek } = await import("./kek");
    expect(previousKek()).toBeNull();
  });

  it("returns null when ATLAS_KEK_PREVIOUS_VERSION is set but ATLAS_KEK_PREVIOUS is missing", async () => {
    vi.doMock("@/config/env", () => ({
      env: {
        ATLAS_KEK: CURRENT_KEY_B64,
        ATLAS_KEK_VERSION: 2,
        ATLAS_KEK_PREVIOUS: undefined,
        ATLAS_KEK_PREVIOUS_VERSION: 1,
      },
    }));
    const { previousKek } = await import("./kek");
    expect(previousKek()).toBeNull();
  });

  it("returns the decoded previous KEK with its version when both are present", async () => {
    vi.doMock("@/config/env", () => ({
      env: {
        ATLAS_KEK: CURRENT_KEY_B64,
        ATLAS_KEK_VERSION: 2,
        ATLAS_KEK_PREVIOUS: PREVIOUS_KEY_B64,
        ATLAS_KEK_PREVIOUS_VERSION: 1,
      },
    }));
    const { previousKek } = await import("./kek");
    const gen = previousKek();
    expect(gen).not.toBeNull();
    expect(gen?.version).toBe(1);
    expect(gen?.key).toHaveLength(32);
    expect(gen?.key.equals(Buffer.alloc(32, 0x02))).toBe(true);
  });
});

// ── kekForVersion ─────────────────────────────────────────────────────────────

describe("kekForVersion", () => {
  /**
   * The fail-closed invariant: an unknown version must throw `invalid_key`.
   *
   * The alternative — trying every KEK in turn — would work, but it turns a
   * configuration error into a silent success and removes the signal that a
   * rotation was rolled back or a version was skipped. This test pins that
   * decision: if kekForVersion ever starts returning a key for an unknown
   * version, this test catches it.
   */

  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the current key when the version matches", async () => {
    vi.doMock("@/config/env", () => ({
      env: {
        ATLAS_KEK: CURRENT_KEY_B64,
        ATLAS_KEK_VERSION: 5,
        ATLAS_KEK_PREVIOUS: undefined,
        ATLAS_KEK_PREVIOUS_VERSION: undefined,
      },
    }));
    const { kekForVersion } = await import("./kek");
    const key = kekForVersion(5);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.equals(Buffer.alloc(32, 0x01))).toBe(true);
  });

  it("returns the previous key when the version matches the previous generation", async () => {
    vi.doMock("@/config/env", () => ({
      env: {
        ATLAS_KEK: CURRENT_KEY_B64,
        ATLAS_KEK_VERSION: 2,
        ATLAS_KEK_PREVIOUS: PREVIOUS_KEY_B64,
        ATLAS_KEK_PREVIOUS_VERSION: 1,
      },
    }));
    const { kekForVersion } = await import("./kek");
    const key = kekForVersion(1);
    expect(key.equals(Buffer.alloc(32, 0x02))).toBe(true);
  });

  it("throws invalid_key for a version that matches neither current nor previous", async () => {
    // This is the critical fail-closed path: an unknown DEK version must not
    // silently produce a key, because that would either return the wrong key
    // or mask a rotation misconfiguration.
    vi.doMock("@/config/env", () => ({
      env: {
        ATLAS_KEK: CURRENT_KEY_B64,
        ATLAS_KEK_VERSION: 3,
        ATLAS_KEK_PREVIOUS: PREVIOUS_KEY_B64,
        ATLAS_KEK_PREVIOUS_VERSION: 2,
      },
    }));
    const { kekForVersion } = await import("./kek");
    // ./envelope is loaded transitively by ./kek; importing it here gets the
    // same cached instance, so instanceof checks against CryptoError are valid.
    const { CryptoError: CE } = await import("./envelope");

    expect(() => kekForVersion(99)).toThrow(CE);
    try {
      kekForVersion(99);
    } catch (e) {
      expect(e).toBeInstanceOf(CE);
      expect((e as InstanceType<typeof CE>).code).toBe("invalid_key");
    }
  });

  it("throws invalid_key when no previous is configured and version does not match current", async () => {
    vi.doMock("@/config/env", () => ({
      env: {
        ATLAS_KEK: CURRENT_KEY_B64,
        ATLAS_KEK_VERSION: 1,
        ATLAS_KEK_PREVIOUS: undefined,
        ATLAS_KEK_PREVIOUS_VERSION: undefined,
      },
    }));
    const { kekForVersion } = await import("./kek");
    const { CryptoError: CE } = await import("./envelope");

    expect(() => kekForVersion(0)).toThrow(CE);
    expect(() => kekForVersion(2)).toThrow(CE);
  });
});
