import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CryptoError, KEY_BYTES } from "./envelope";
import type { RejectionKey } from "./rejection-key-service";

/**
 * ATL-203 — rejection key lifecycle over an in-memory key store.
 *
 * Mirrors the structure of encryption-service.integration.test.ts: the
 * repository is replaced with a fake, the cryptography is real. Tests cover
 * lazy creation, race-safe creation, read-only retrieval, round-trip HMAC
 * usage, the branded type contract, purpose isolation, and account deletion.
 *
 * Runs in the node project because the service is `server-only`.
 */

const KEK_V1 = Buffer.alloc(KEY_BYTES, 33).toString("base64");

const kekEnv = {
  ATLAS_KEK: KEK_V1,
  ATLAS_KEK_VERSION: 1,
  ATLAS_KEK_PREVIOUS: undefined as string | undefined,
  ATLAS_KEK_PREVIOUS_VERSION: undefined as number | undefined,
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-fixture",
};

vi.mock("@/config/env", () => ({
  get env() {
    return kekEnv;
  },
}));

interface FakeRow {
  id: string;
  userId: string;
  wrappedDek: string | null;
  kekVersion: number;
  status: "active" | "retired" | "destroyed";
  destroyedAt: string | null;
  keyPurpose: string;
}

/** In-memory stand-in for the rejection key path through `user_encryption_keys`. */
class FakeRejectionKeyStore {
  rows: FakeRow[] = [];

  /**
   * When set, the next `insertActiveForPurpose` call that would otherwise
   * succeed is blocked (simulating a concurrent first write winning the race).
   * The provided rowId and wrapped material are committed as the winner's row.
   */
  raceWinner: { rowId: string; wrapped: string } | null = null;

  findForUserByPurpose(userId: string, purpose: string) {
    return this.rows.filter((r) => r.userId === userId && r.keyPurpose === purpose);
  }

  private activeRow(userId: string, purpose: string) {
    return (
      this.rows.find(
        (r) => r.userId === userId && r.keyPurpose === purpose && r.status === "active",
      ) ?? null
    );
  }

  insertActiveForPurpose(
    id: string,
    userId: string,
    wrappedKey: string,
    kekVersion: number,
    purpose: string,
  ) {
    if (this.raceWinner !== null && !this.activeRow(userId, purpose)) {
      // A concurrent first write commits between our read and our insert.
      // Insert the winner's row and return null so the caller re-reads.
      this.rows.push({
        id: this.raceWinner.rowId,
        userId,
        wrappedDek: this.raceWinner.wrapped,
        kekVersion,
        status: "active",
        destroyedAt: null,
        keyPurpose: purpose,
      });
      return null;
    }
    if (this.activeRow(userId, purpose)) return null;
    const row: FakeRow = {
      id,
      userId,
      wrappedDek: wrappedKey,
      kekVersion,
      status: "active",
      destroyedAt: null,
      keyPurpose: purpose,
    };
    this.rows.push(row);
    return row;
  }

  listWrappedUnderByPurpose(purpose: string, kekVersion: number, limit: number) {
    return this.rows
      .filter(
        (r) => r.keyPurpose === purpose && r.kekVersion === kekVersion && r.status !== "destroyed",
      )
      .slice(0, limit);
  }

  rewrap(id: string, expectedKekVersion: number, newWrapped: string, newVersion: number) {
    const row = this.rows.find(
      (r) => r.id === id && r.kekVersion === expectedKekVersion && r.status !== "destroyed",
    );
    if (!row) return false;
    row.wrappedDek = newWrapped;
    row.kekVersion = newVersion;
    return true;
  }

  destroyAllForUser(userId: string, destroyedAt: string) {
    const targets = this.rows.filter((r) => r.userId === userId && r.status !== "destroyed");
    for (const row of targets) {
      row.wrappedDek = null;
      row.status = "destroyed";
      row.destroyedAt = destroyedAt;
    }
    return targets.length;
  }
}

let store: FakeRejectionKeyStore;

vi.mock("@/server/repositories/encryption-key-repository", () => ({
  EncryptionKeyRepository: class {
    findForUserByPurpose(userId: string, purpose: string) {
      return Promise.resolve(store.findForUserByPurpose(userId, purpose));
    }
    insertActiveForPurpose(
      id: string,
      userId: string,
      wrappedKey: string,
      kekVersion: number,
      purpose: string,
    ) {
      return Promise.resolve(
        store.insertActiveForPurpose(id, userId, wrappedKey, kekVersion, purpose),
      );
    }
    listWrappedUnderByPurpose(purpose: string, kekVersion: number, limit: number) {
      return Promise.resolve(store.listWrappedUnderByPurpose(purpose, kekVersion, limit));
    }
    rewrap(id: string, expectedKekVersion: number, newWrapped: string, newVersion: number) {
      return Promise.resolve(store.rewrap(id, expectedKekVersion, newWrapped, newVersion));
    }
    destroyAllForUser(userId: string, destroyedAt: string) {
      return Promise.resolve(store.destroyAllForUser(userId, destroyedAt));
    }
  },
}));

vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));

const { RejectionKeyService } = await import("./rejection-key-service");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function service() {
  return new RejectionKeyService({} as never);
}

async function failureCodeOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof CryptoError) return error.code;
    throw error;
  }
  throw new Error("expected the operation to fail closed, but it succeeded");
}

beforeEach(() => {
  store = new FakeRejectionKeyStore();
  kekEnv.ATLAS_KEK = KEK_V1;
  kekEnv.ATLAS_KEK_VERSION = 1;
  kekEnv.ATLAS_KEK_PREVIOUS = undefined;
  kekEnv.ATLAS_KEK_PREVIOUS_VERSION = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Wraps a fresh rejection key the way the service would, for pre-seeding or
 * race setup. Returns both the sealed envelope and the raw key bytes so tests
 * can verify the key the service returns is the expected one.
 */
async function wrappedRejectionKeyFor(rowId: string): Promise<{ sealed: string; rawKey: Buffer }> {
  const { seal } = await import("./envelope");
  const rawKey = randomBytes(KEY_BYTES);
  const sealed = seal(Buffer.from(kekEnv.ATLAS_KEK, "base64"), rawKey.toString("base64"), {
    table: "user_encryption_keys",
    column: "wrapped_key",
    recordId: rowId,
  });
  return { sealed, rawKey };
}

describe("lazy creation", () => {
  it("creates no key until getOrCreate is called", () => {
    service();
    expect(store.rows).toHaveLength(0);
  });

  it("creates exactly one rejection key on first getOrCreate", async () => {
    await service().getOrCreate(ALICE);

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      userId: ALICE,
      status: "active",
      kekVersion: 1,
      keyPurpose: "rejection",
    });
  });

  it("reuses the key on subsequent calls", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);
    await svc.getOrCreate(ALICE);

    expect(store.rows).toHaveLength(1);
  });

  it("gives each user their own key", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);
    await svc.getOrCreate(BOB);

    expect(store.rows).toHaveLength(2);
    expect(store.rows[0]?.wrappedDek).not.toBe(store.rows[1]?.wrappedDek);
  });

  it("stores the key only in wrapped form", async () => {
    await service().getOrCreate(ALICE);

    const row = store.rows[0]!;
    const kek = Buffer.from(KEK_V1, "base64");
    // The envelope is not the raw key; it requires unwrapping.
    expect(row.wrappedDek).not.toBeNull();
    expect(row.wrappedDek).not.toContain(kek.toString("base64"));
  });

  it("refuses to re-key a crypto-shredded user", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);
    store.destroyAllForUser(ALICE, new Date().toISOString());

    expect(await failureCodeOf(() => svc.getOrCreate(ALICE))).toBe("key_destroyed");
    // No replacement key was minted.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: "destroyed", wrappedDek: null });
  });
});

describe("race-safe creation", () => {
  it("adopts the winner's key when it loses the insert race", async () => {
    const winnerRowId = "winner-rej-row-id";
    const { sealed: winnerWrapped, rawKey: winnerKey } = await wrappedRejectionKeyFor(winnerRowId);
    store.raceWinner = { rowId: winnerRowId, wrapped: winnerWrapped };

    const svc = service();
    const key = await svc.getOrCreate(ALICE);

    // Exactly one key committed — the winner's.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.wrappedDek).toBe(winnerWrapped);
    expect(store.rows[0]?.id).toBe(winnerRowId);
    // The key the service returns decodes to the winner's material.
    expect((key as Buffer).equals(winnerKey)).toBe(true);
  });
});

describe("getRejectionKey — read-only retrieval", () => {
  it("returns the active key without creating one", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);
    const rowCount = store.rows.length;

    await svc.getRejectionKey(ALICE);
    expect(store.rows).toHaveLength(rowCount);
  });

  it("throws key_unavailable when no key exists", async () => {
    expect(await failureCodeOf(() => service().getRejectionKey(ALICE))).toBe("key_unavailable");
  });

  it("throws key_destroyed when the key was shredded", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);
    store.destroyAllForUser(ALICE, new Date().toISOString());

    expect(await failureCodeOf(() => svc.getRejectionKey(ALICE))).toBe("key_destroyed");
  });
});

describe("round-trip HMAC", () => {
  it("produces the same HMAC each time the key is retrieved", async () => {
    const { createHmac } = await import("node:crypto");
    const svc = service();

    const key1 = await svc.getOrCreate(ALICE);
    const mac = createHmac("sha256", key1).update("hibp:sha1-prefix:ABCDE").digest("base64");

    const key2 = await svc.getOrCreate(ALICE);
    const mac2 = createHmac("sha256", key2).update("hibp:sha1-prefix:ABCDE").digest("base64");

    expect(mac2).toBe(mac);
  });

  it("two users produce distinct HMACs for the same input", async () => {
    const { createHmac } = await import("node:crypto");
    const svc = service();

    const aliceKey = await svc.getOrCreate(ALICE);
    const bobKey = await svc.getOrCreate(BOB);
    const input = "hibp:sha1-prefix:ABCDE";

    const aliceMac = createHmac("sha256", aliceKey).update(input).digest("base64");
    const bobMac = createHmac("sha256", bobKey).update(input).digest("base64");

    expect(aliceMac).not.toBe(bobMac);
  });
});

describe("branded RejectionKey type", () => {
  it("returns a Buffer subtype with the rejection brand", async () => {
    const key = await service().getOrCreate(ALICE);

    // RejectionKey extends Buffer: all Buffer methods are available.
    const asBuffer: Buffer = key;
    expect(asBuffer).toHaveLength(KEY_BYTES);
  });

  it("produces a 256-bit key", async () => {
    const key = await service().getOrCreate(ALICE);
    expect((key as Buffer).length).toBe(KEY_BYTES);
  });

  // The compile-time check: Buffer is NOT assignable to RejectionKey.
  // If this stops producing a type error, the brand has been removed.
  it("is not assignable from a plain Buffer at the type level", () => {
    // @ts-expect-error — Buffer is not assignable to RejectionKey without the brand
    const _: RejectionKey = Buffer.alloc(KEY_BYTES);
    void _;
    // Reaching here means the branded assignment was accepted at runtime,
    // which is expected (brands are compile-time only). The @ts-expect-error
    // above is what actually enforces the type-safety contract.
    expect(true).toBe(true);
  });
});

describe("account deletion (crypto-shredding)", () => {
  it("destroys the rejection key as part of destroyAllForUser", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);

    const count = store.destroyAllForUser(ALICE, new Date().toISOString());

    expect(count).toBe(1);
    expect(store.rows[0]).toMatchObject({ status: "destroyed", wrappedDek: null });
    expect(store.rows[0]?.destroyedAt).toBeTruthy();
  });

  it("makes the rejection key unreadable after shredding", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);
    store.destroyAllForUser(ALICE, new Date().toISOString());

    expect(await failureCodeOf(() => svc.getRejectionKey(ALICE))).toBe("key_destroyed");
  });

  it("is idempotent across multiple destruction calls", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);

    expect(store.destroyAllForUser(ALICE, new Date().toISOString())).toBe(1);
    expect(store.destroyAllForUser(ALICE, new Date().toISOString())).toBe(0);
  });

  it("does not affect other users", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);
    await svc.getOrCreate(BOB);

    store.destroyAllForUser(ALICE, new Date().toISOString());

    // Bob's key is untouched.
    const bobKey = await svc.getRejectionKey(BOB);
    expect((bobKey as Buffer).length).toBe(KEY_BYTES);
  });
});

describe("KEK rotation", () => {
  const KEK_V2 = Buffer.alloc(KEY_BYTES, 55).toString("base64");

  function rotateEnvironmentTo(version: number, key: string) {
    kekEnv.ATLAS_KEK_PREVIOUS = kekEnv.ATLAS_KEK;
    kekEnv.ATLAS_KEK_PREVIOUS_VERSION = kekEnv.ATLAS_KEK_VERSION;
    kekEnv.ATLAS_KEK = key;
    kekEnv.ATLAS_KEK_VERSION = version;
  }

  it("re-wraps the rejection key onto the new KEK generation", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);
    expect(store.rows[0]?.kekVersion).toBe(1);

    rotateEnvironmentTo(2, KEK_V2);
    expect(await svc.rotateKek(1)).toBe(1);
    expect(store.rows[0]?.kekVersion).toBe(2);
  });

  it("rejection key remains readable after rotation (same key bytes)", async () => {
    const svc = service();
    // Capture HMAC before rotation to verify the key bytes are unchanged.
    const { createHmac } = await import("node:crypto");
    const before = await svc.getOrCreate(ALICE);
    const mac = createHmac("sha256", before).update("test-input").digest("base64");

    rotateEnvironmentTo(2, KEK_V2);
    await svc.rotateKek(1);

    const after = await svc.getRejectionKey(ALICE);
    const mac2 = createHmac("sha256", after).update("test-input").digest("base64");
    // Key material is unchanged — only the wrapping changed.
    expect(mac2).toBe(mac);
  });

  it("does nothing when fromVersion equals the current KEK version", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);
    expect(await svc.rotateKek(1)).toBe(0);
    expect(store.rows[0]?.kekVersion).toBe(1);
  });

  it("is idempotent: a resumed sweep returns 0 on the second pass", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);

    rotateEnvironmentTo(2, KEK_V2);
    expect(await svc.rotateKek(1)).toBe(1);
    expect(await svc.rotateKek(1)).toBe(0);
    expect(store.rows[0]?.kekVersion).toBe(2);
  });

  it("skips destroyed rejection keys", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);
    store.destroyAllForUser(ALICE, new Date().toISOString());

    rotateEnvironmentTo(2, KEK_V2);
    expect(await svc.rotateKek(1)).toBe(0);
    expect(store.rows[0]?.wrappedDek).toBeNull();
  });

  it("does not rotate content key rows left in the batch by accident", async () => {
    const svc = service();
    await svc.getOrCreate(ALICE);

    // Pre-seed a content key row with the same kekVersion.
    store.rows.push({
      id: "content-row",
      userId: ALICE,
      wrappedDek: "content-sentinel",
      kekVersion: 1,
      status: "active",
      destroyedAt: null,
      keyPurpose: "content",
    });

    rotateEnvironmentTo(2, KEK_V2);
    // RejectionKeyService.rotateKek must only rotate rejection rows.
    const rotated = await svc.rotateKek(1);
    expect(rotated).toBe(1); // one rejection key

    // Content row is still on version 1 — untouched by the rejection sweep.
    const contentRow = store.rows.find((r) => r.keyPurpose === "content")!;
    expect(contentRow.kekVersion).toBe(1);
    expect(contentRow.wrappedDek).toBe("content-sentinel");
  });
});

describe("purpose isolation", () => {
  it("ignores an active content key row when creating a rejection key", async () => {
    // A pre-existing content key row must not prevent creation of a rejection key.
    store.rows.push({
      id: "content-key-1",
      userId: ALICE,
      wrappedDek: "not-a-rejection-envelope",
      kekVersion: 1,
      status: "active",
      destroyedAt: null,
      keyPurpose: "content",
    });

    const svc = service();
    // getOrCreate must succeed and create a rejection key.
    const key = await svc.getOrCreate(ALICE);
    expect((key as Buffer).length).toBe(KEY_BYTES);

    const rejectionRows = store.rows.filter((r) => r.keyPurpose === "rejection");
    expect(rejectionRows).toHaveLength(1);
    expect(rejectionRows[0]?.status).toBe("active");
  });

  it("does not treat a destroyed content key as the rejection key being destroyed", async () => {
    // A destroyed content key must not cause getOrCreate to throw key_destroyed.
    store.rows.push({
      id: "content-destroyed",
      userId: ALICE,
      wrappedDek: null,
      kekVersion: 1,
      status: "destroyed",
      destroyedAt: new Date().toISOString(),
      keyPurpose: "content",
    });

    const svc = service();
    // Should create a rejection key successfully.
    const key = await svc.getOrCreate(ALICE);
    expect((key as Buffer).length).toBe(KEY_BYTES);
  });
});
