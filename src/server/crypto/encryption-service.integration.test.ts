import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CryptoError, KEY_BYTES, generateDek, keysEqual, unwrapDek } from "./envelope";
import type { EncryptionContext } from "./envelope";

/**
 * ATL-084 — key lifecycle over an in-memory key store.
 *
 * The repository is replaced with a fake so lazy creation, races, rotation, and
 * shredding are exercised deterministically. The *cryptography* is real
 * throughout — nothing here stubs `seal`, `open`, `wrapDek`, or `unwrapDek` —
 * so a broken envelope fails these tests too.
 *
 * Runs in the node project because the service is `server-only`.
 */

const KEK_V1 = Buffer.alloc(KEY_BYTES, 11).toString("base64");
const KEK_V2 = Buffer.alloc(KEY_BYTES, 22).toString("base64");

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
}

/** In-memory stand-in enforcing the same invariants as the table's constraints. */
class FakeKeyStore {
  rows: FakeRow[] = [];
  private nextId = 1;
  /**
   * The wrapped DEK a concurrent first write commits just before ours.
   *
   * Set to simulate losing the insert race. Holding the winner's *actual* key
   * material is what lets the race test prove adoption: the loser must end up
   * using this key, not one of its own making.
   */
  raceWinnerWrappedDek: string | null = null;

  /** Every row for the user, unfiltered — what the repository actually exposes. */
  findForUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }

  /**
   * Mirrors the unique partial index `where status = 'active'`.
   *
   * Note what this does NOT block: a destroyed row does not occupy the active
   * slot, so the database would happily accept a replacement key for a
   * crypto-shredded user. That permissiveness is faithful to the migration, and
   * it is why refusing to re-key a shredded account has to be enforced in the
   * service rather than assumed from the schema.
   */
  private activeRow(userId: string) {
    return this.rows.find((r) => r.userId === userId && r.status === "active") ?? null;
  }

  insertActive(userId: string, wrappedDek: string, kekVersion: number) {
    if (this.raceWinnerWrappedDek !== null && !this.activeRow(userId)) {
      // A concurrent first write commits between our read and our insert. The
      // loser must both fail AND find the winner waiting on re-read; committing
      // the winner here is what makes that branch genuinely reachable.
      this.rows.push({
        id: `key-${this.nextId++}`,
        userId,
        wrappedDek: this.raceWinnerWrappedDek,
        kekVersion,
        status: "active",
        destroyedAt: null,
      });
      return null;
    }
    if (this.activeRow(userId)) return null;
    const row: FakeRow = {
      id: `key-${this.nextId++}`,
      userId,
      wrappedDek,
      kekVersion,
      status: "active",
      destroyedAt: null,
    };
    this.rows.push(row);
    return row;
  }

  listWrappedUnder(kekVersion: number, limit: number) {
    return this.rows
      .filter((r) => r.kekVersion === kekVersion && r.status !== "destroyed")
      .slice(0, limit);
  }

  rewrap(id: string, expected: number, wrappedDek: string, kekVersion: number) {
    const row = this.rows.find(
      (r) => r.id === id && r.kekVersion === expected && r.status !== "destroyed",
    );
    if (!row) return false;
    row.wrappedDek = wrappedDek;
    row.kekVersion = kekVersion;
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

let store: FakeKeyStore;

vi.mock("@/server/repositories/encryption-key-repository", () => ({
  EncryptionKeyRepository: class {
    findForUser(userId: string) {
      return Promise.resolve(store.findForUser(userId));
    }
    findById(userId: string, id: string) {
      return Promise.resolve(store.rows.find((r) => r.userId === userId && r.id === id) ?? null);
    }
    insertActive(userId: string, wrappedDek: string, kekVersion: number) {
      return Promise.resolve(store.insertActive(userId, wrappedDek, kekVersion));
    }
    listWrappedUnder(kekVersion: number, limit: number) {
      return Promise.resolve(store.listWrappedUnder(kekVersion, limit));
    }
    rewrap(id: string, expected: number, wrappedDek: string, kekVersion: number) {
      return Promise.resolve(store.rewrap(id, expected, wrappedDek, kekVersion));
    }
    destroyAllForUser(userId: string, destroyedAt: string) {
      return Promise.resolve(store.destroyAllForUser(userId, destroyedAt));
    }
  },
}));

vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));

const { EncryptionService } = await import("./encryption-service");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const CONTEXT: EncryptionContext = {
  table: "user_personal_fields",
  column: "value_encrypted",
  recordId: "aaaaaaaa-0000-4000-8000-000000000001",
};

function service() {
  return new EncryptionService({} as never);
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
  store = new FakeKeyStore();
  kekEnv.ATLAS_KEK = KEK_V1;
  kekEnv.ATLAS_KEK_VERSION = 1;
  kekEnv.ATLAS_KEK_PREVIOUS = undefined;
  kekEnv.ATLAS_KEK_PREVIOUS_VERSION = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("lazy DEK creation", () => {
  it("creates no key until the first restricted write", () => {
    service();
    expect(store.rows).toHaveLength(0);
  });

  it("creates exactly one key on first encrypt", async () => {
    await service().encrypt(ALICE, "secret", CONTEXT);

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ userId: ALICE, status: "active", kekVersion: 1 });
  });

  it("reuses the key on subsequent writes", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "one", CONTEXT);
    await svc.encrypt(ALICE, "two", CONTEXT);

    expect(store.rows).toHaveLength(1);
  });

  it("gives each user their own key", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "a", CONTEXT);
    await svc.encrypt(BOB, "b", CONTEXT);

    expect(store.rows).toHaveLength(2);
    expect(store.rows[0]?.wrappedDek).not.toBe(store.rows[1]?.wrappedDek);
  });

  it("stores the DEK only in wrapped form", async () => {
    await service().encrypt(ALICE, "secret", CONTEXT);

    const wrapped = store.rows[0]?.wrappedDek ?? "";
    const kek = Buffer.from(KEK_V1, "base64");
    // Recoverable with the KEK, and 32 bytes — but not present as plain material.
    expect(unwrapDek(kek, wrapped, ALICE, 1)).toHaveLength(KEY_BYTES);
    expect(wrapped).not.toContain(kek.toString("base64"));
  });

  it("adopts the winner's key when it loses the creation race", async () => {
    // Two concurrent first writes: the unique index lets one through. The loser
    // must adopt that key, not create a second — half a user's data would
    // otherwise survive a crypto-shred.
    const svc = service();
    // No key is pre-seeded: the loser must reach its insert believing it is the
    // first writer, which is the only way through the race branch. Seeding
    // beforehand would satisfy the initial read and skip the path entirely.
    store.raceWinnerWrappedDek = await wrappedFor(ALICE, 1);

    const envelope = await svc.encrypt(ALICE, "secret", CONTEXT);

    // One key, and it is the winner's — not a second one the loser minted.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.wrappedDek).toBe(store.raceWinnerWrappedDek);
    expect(await svc.decrypt(ALICE, envelope, CONTEXT)).toBe("secret");
  });
});

describe("encrypt and decrypt", () => {
  it("round-trips through the service", async () => {
    const svc = service();
    const envelope = await svc.encrypt(ALICE, "dana@example.com", CONTEXT);

    expect(envelope).not.toContain("dana");
    expect(await svc.decrypt(ALICE, envelope, CONTEXT)).toBe("dana@example.com");
  });

  it("cannot decrypt another user's value", async () => {
    // Separate DEKs are the blast-radius bound: one user's key never opens
    // another user's data.
    const svc = service();
    const envelope = await svc.encrypt(ALICE, "alice secret", CONTEXT);
    await svc.encrypt(BOB, "bob secret", CONTEXT);

    expect(await failureCodeOf(() => svc.decrypt(BOB, envelope, CONTEXT))).toBe(
      "integrity_failure",
    );
  });

  it("cannot decrypt a value moved to another row", async () => {
    const svc = service();
    const envelope = await svc.encrypt(ALICE, "secret", CONTEXT);

    expect(
      await failureCodeOf(() =>
        svc.decrypt(ALICE, envelope, { ...CONTEXT, recordId: "different-record" }),
      ),
    ).toBe("integrity_failure");
  });

  it("fails closed on a corrupted envelope rather than returning it", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "secret", CONTEXT);

    expect(await failureCodeOf(() => svc.decrypt(ALICE, "not-an-envelope", CONTEXT))).toBe(
      "invalid_envelope",
    );
  });
});

describe("KEK rotation", () => {
  /** Moves the environment to a new KEK generation, keeping the old one available. */
  function rotateEnvironmentTo(version: number, key: string) {
    kekEnv.ATLAS_KEK_PREVIOUS = kekEnv.ATLAS_KEK;
    kekEnv.ATLAS_KEK_PREVIOUS_VERSION = kekEnv.ATLAS_KEK_VERSION;
    kekEnv.ATLAS_KEK = key;
    kekEnv.ATLAS_KEK_VERSION = version;
  }

  it("re-wraps keys onto the new generation", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "secret", CONTEXT);
    await svc.encrypt(BOB, "secret", CONTEXT);

    rotateEnvironmentTo(2, KEK_V2);
    expect(await svc.rotateKek(1)).toBe(2);
    expect(store.rows.every((r) => r.kekVersion === 2)).toBe(true);
  });

  it("preserves the DEK, so no ciphertext is rewritten", async () => {
    // The point of envelope encryption: rotating the KEK is metadata-only.
    const svc = service();
    const envelope = await svc.encrypt(ALICE, "secret", CONTEXT);
    const before = unwrapDek(Buffer.from(KEK_V1, "base64"), store.rows[0]!.wrappedDek!, ALICE, 1);

    rotateEnvironmentTo(2, KEK_V2);
    await svc.rotateKek(1);

    const after = unwrapDek(Buffer.from(KEK_V2, "base64"), store.rows[0]!.wrappedDek!, ALICE, 2);
    expect(keysEqual(before, after)).toBe(true);
    // And the value encrypted before the rotation still reads.
    expect(await svc.decrypt(ALICE, envelope, CONTEXT)).toBe("secret");
  });

  it("keeps un-swept users readable mid-rotation", async () => {
    // Between deploy and sweep completion some rows are on the old generation.
    // Without the previous KEK in the process they would be unreadable.
    const svc = service();
    const envelope = await svc.encrypt(ALICE, "secret", CONTEXT);

    rotateEnvironmentTo(2, KEK_V2);

    expect(await svc.decrypt(ALICE, envelope, CONTEXT)).toBe("secret");
  });

  it("is idempotent and resumable", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "secret", CONTEXT);
    rotateEnvironmentTo(2, KEK_V2);

    expect(await svc.rotateKek(1)).toBe(1);
    // A resumed or duplicated sweep finds nothing left and does no harm.
    expect(await svc.rotateKek(1)).toBe(0);
    expect(store.rows[0]?.kekVersion).toBe(2);
  });

  it("does nothing when already on the target generation", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "secret", CONTEXT);
    expect(await svc.rotateKek(1)).toBe(0);
  });

  it("skips destroyed keys", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "secret", CONTEXT);
    await svc.destroyUserKeys(ALICE);

    rotateEnvironmentTo(2, KEK_V2);
    expect(await svc.rotateKek(1)).toBe(0);
    // A shredded key is not resurrected by a rotation.
    expect(store.rows[0]?.wrappedDek).toBeNull();
  });

  it("refuses an unknown KEK generation rather than guessing", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "secret", CONTEXT);
    expect(await failureCodeOf(() => svc.rotateKek(99))).toBe("invalid_key");
  });
});

describe("crypto-shredding", () => {
  it("destroys the key and reports how many", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "secret", CONTEXT);

    expect(await svc.destroyUserKeys(ALICE)).toBe(1);
    expect(store.rows[0]).toMatchObject({ status: "destroyed", wrappedDek: null });
    expect(store.rows[0]?.destroyedAt).toBeTruthy();
  });

  it("makes previously encrypted values permanently unreadable", async () => {
    // The deletion guarantee (security §16 step 5): ciphertext survives in
    // backups, but nothing can open it again.
    const svc = service();
    const envelope = await svc.encrypt(ALICE, "dana@example.com", CONTEXT);

    await svc.destroyUserKeys(ALICE);

    expect(await failureCodeOf(() => svc.decrypt(ALICE, envelope, CONTEXT))).toBe("key_destroyed");
  });

  it("refuses to re-key a shredded account on a later write", async () => {
    /**
     * The irreversibility guarantee, and the reason the read path cannot simply
     * fall through to key creation.
     *
     * The unique index is partial (`where status = 'active'`), so a destroyed
     * row leaves the active slot free and the database will happily accept a
     * replacement key. Nothing below the service enforces this. Without the
     * check, a single write after deletion silently re-arms the account with a
     * usable DEK and it starts accumulating recoverable ciphertext again —
     * turning a permanent destruction into a temporary one.
     */
    const svc = service();
    await svc.encrypt(ALICE, "dana@example.com", CONTEXT);
    await svc.destroyUserKeys(ALICE);

    expect(await failureCodeOf(() => svc.encrypt(ALICE, "new value", CONTEXT))).toBe(
      "key_destroyed",
    );
    // No replacement key was minted, so the shred still covers everything.
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: "destroyed", wrappedDek: null });
  });

  it("reports a destroyed key distinctly from a tampered envelope", async () => {
    /**
     * Why the destroyed check must precede AES-GCM rather than follow it.
     *
     * GCM cannot tell a wrong key from tampered ciphertext — both fail the tag
     * check identically. Decrypting a shredded user's envelope under any other
     * key therefore reports `integrity_failure`, which means "wrong key, wrong
     * AAD, or tampering" and reads as a security incident worth paging someone
     * over. `key_destroyed` is permanent and expected. Conflating them sends an
     * on-call engineer hunting an attack that never happened, so this pins the
     * two codes apart.
     */
    const svc = service();
    const destroyed = await svc.encrypt(ALICE, "secret", CONTEXT);
    const tampered = await svc.encrypt(BOB, "secret", CONTEXT);

    await svc.destroyUserKeys(ALICE);

    expect(await failureCodeOf(() => svc.decrypt(ALICE, destroyed, CONTEXT))).toBe("key_destroyed");
    expect(
      await failureCodeOf(() => svc.decrypt(BOB, tampered, { ...CONTEXT, recordId: "other-row" })),
    ).toBe("integrity_failure");
  });

  it("keeps the row as evidence rather than deleting it", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "secret", CONTEXT);
    await svc.destroyUserKeys(ALICE);

    expect(store.rows).toHaveLength(1);
  });

  it("is idempotent, so a resumed deletion is safe", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "secret", CONTEXT);

    expect(await svc.destroyUserKeys(ALICE)).toBe(1);
    expect(await svc.destroyUserKeys(ALICE)).toBe(0);
  });

  it("touches only the named user", async () => {
    const svc = service();
    await svc.encrypt(ALICE, "a", CONTEXT);
    const bobEnvelope = await svc.encrypt(BOB, "b", CONTEXT);

    await svc.destroyUserKeys(ALICE);

    expect(await svc.decrypt(BOB, bobEnvelope, CONTEXT)).toBe("b");
  });

  it("reports zero for a user who never held a key", async () => {
    expect(await service().destroyUserKeys(BOB)).toBe(0);
  });
});

/** Wraps a fresh DEK the way the service would, for race setup. */
async function wrappedFor(userId: string, kekVersion: number): Promise<string> {
  const { wrapDek } = await import("./envelope");
  const dek = generateDek();
  return wrapDek(Buffer.from(kekEnv.ATLAS_KEK, "base64"), dek, userId, kekVersion);
}
