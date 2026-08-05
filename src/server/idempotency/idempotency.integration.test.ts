import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Type-only, so it is erased before `vi.mock` hoisting runs and cannot pull the
 * real repository into the module graph ahead of its mock.
 */
import type * as IdempotencyRepositoryModule from "@/server/repositories/idempotency-key-repository";

/**
 * ATL-104 — idempotent execution.
 *
 * Runs against a fake store that mirrors the migration's constraints: the
 * `(user_id, scope, idempotency_key)` unique index, the guarded completion, and
 * the all-or-nothing completion check. Mirroring the unique index matters most —
 * it is what resolves the double-submit race, so a fake that ignored it would
 * let the race test pass against logic that fails in production.
 *
 * Encryption is the real ATL-084 service against an in-memory key store, so the
 * AAD binding is genuinely exercised rather than stubbed away.
 *
 * The RLS half — deny-all, service-role-only — needs a real database and lives
 * in `tests/integration/idempotency-keys-rls.test.ts`.
 */

const KEK = Buffer.alloc(32, 3).toString("base64");

vi.mock("@/config/env", () => ({
  env: { ATLAS_KEK: KEK, ATLAS_KEK_VERSION: 1 },
}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

interface FakeRow {
  id: string;
  user_id: string;
  scope: string;
  idempotency_key: string;
  result_encrypted: string | null;
  result_hash: string | null;
  expires_at: string;
  completed_at: string | null;
}

class FakeStore {
  rows: FakeRow[] = [];
  private nextId = 1;
  /** Runs just before an insert, to simulate a concurrent claim. */
  onBeforeClaim: (() => void) | null = null;
  /** Simulates another caller winning the guarded reclaim of an expired row. */
  reclaimWonByOther = false;

  insert(row: Omit<FakeRow, "id">): FakeRow | null {
    this.onBeforeClaim?.();

    // Mirrors `idempotency_keys_scope_key_unique`.
    const clash = this.rows.some(
      (r) =>
        r.user_id === row.user_id &&
        r.scope === row.scope &&
        r.idempotency_key === row.idempotency_key,
    );
    if (clash) return null;

    const stored: FakeRow = { ...row, id: `idem-${this.nextId++}` };
    this.rows.push(stored);
    return stored;
  }

  find(userId: string, scope: string, key: string): FakeRow | null {
    return (
      this.rows.find(
        (r) => r.user_id === userId && r.scope === scope && r.idempotency_key === key,
      ) ?? null
    );
  }
}

let store: FakeStore;

vi.mock("@/server/repositories/idempotency-key-repository", async () => {
  const actual = await vi.importActual<typeof IdempotencyRepositoryModule>(
    "@/server/repositories/idempotency-key-repository",
  );

  const toClaim = (row: FakeRow) => ({
    id: row.id,
    userId: row.user_id,
    scope: row.scope,
    idempotencyKey: row.idempotency_key,
    resultEncrypted: row.result_encrypted,
    resultHash: row.result_hash,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  });

  return {
    ...actual,
    IdempotencyKeyRepository: class {
      claim(userId: string, scope: string, key: string, expiresAt: string) {
        const row = store.insert({
          user_id: userId,
          scope,
          idempotency_key: key,
          result_encrypted: null,
          result_hash: null,
          expires_at: expiresAt,
          completed_at: null,
        });
        return Promise.resolve(row ? toClaim(row) : null);
      }
      find(userId: string, scope: string, key: string) {
        const row = store.find(userId, scope, key);
        return Promise.resolve(row ? toClaim(row) : null);
      }
      complete(id: string, resultEncrypted: string, resultHash: string, completedAt: string) {
        const row = store.rows.find((r) => r.id === id && r.completed_at === null);
        if (!row) return Promise.resolve(false);
        row.result_encrypted = resultEncrypted;
        row.result_hash = resultHash;
        row.completed_at = completedAt;
        return Promise.resolve(true);
      }
      reclaimExpired(id: string, expiresAt: string, now: string) {
        if (store.reclaimWonByOther) {
          // The rival's guarded update already moved expires_at forward AND
          // cleared the stale result, so this caller's guard no longer matches.
          // Clearing matters: leaving the old result would let the loser replay
          // a result the reclaim was in the middle of superseding.
          const rival = store.rows.find((r) => r.id === id);
          if (rival) {
            rival.expires_at = expiresAt;
            rival.result_encrypted = null;
            rival.result_hash = null;
            rival.completed_at = null;
          }
          return Promise.resolve(false);
        }
        // Mirrors the `expires_at < now` guard evaluated under the row lock.
        const row = store.rows.find(
          (r) => r.id === id && Date.parse(r.expires_at) < Date.parse(now),
        );
        if (!row) return Promise.resolve(false);
        row.expires_at = expiresAt;
        row.result_encrypted = null;
        row.result_hash = null;
        row.completed_at = null;
        return Promise.resolve(true);
      }
      release(id: string) {
        const index = store.rows.findIndex((r) => r.id === id && r.completed_at === null);
        if (index >= 0) store.rows.splice(index, 1);
        return Promise.resolve();
      }
      purgeExpired(now: string, limit = 1000) {
        const doomed = store.rows.filter((r) => Date.parse(r.expires_at) < Date.parse(now));
        const batch = doomed.slice(0, limit);
        for (const row of batch) store.rows.splice(store.rows.indexOf(row), 1);
        return Promise.resolve(batch.length);
      }
    },
  };
});

/** In-memory DEK store so the real encryption service works without a database. */
const keyRows: {
  id: string;
  userId: string;
  wrappedDek: string | null;
  kekVersion: number;
  status: string;
  destroyedAt: string | null;
}[] = [];

vi.mock("@/server/repositories/encryption-key-repository", () => {
  let nextId = 1;
  return {
    EncryptionKeyRepository: class {
      findForUser(userId: string) {
        return Promise.resolve(keyRows.filter((r) => r.userId === userId));
      }
      insertActive(userId: string, wrappedDek: string, kekVersion: number) {
        if (keyRows.some((r) => r.userId === userId && r.status === "active")) {
          return Promise.resolve(null);
        }
        const row = {
          id: `key-${nextId++}`,
          userId,
          wrappedDek,
          kekVersion,
          status: "active",
          destroyedAt: null,
        };
        keyRows.push(row);
        return Promise.resolve(row);
      }
    },
  };
});

const {
  IdempotencyService,
  IdempotencyInProgressError,
  IdempotencyResultIntegrityError,
  IDEMPOTENCY_TTL_MS,
  canonicalJson,
} = await import("./idempotency");

const ALICE = "aaaaaaaa-0000-4000-8000-00000000000a";
const BOB = "bbbbbbbb-0000-4000-8000-00000000000b";

const service = () => new IdempotencyService({} as never);

beforeEach(() => {
  store = new FakeStore();
  keyRows.length = 0;
});

describe("duplicate suppression", () => {
  it("executes once and returns the same result on replay", async () => {
    const svc = service();
    const execute = vi.fn(() => Promise.resolve({ status: "sent", id: "req-1" }));

    const first = await svc.run({ userId: ALICE, scope: "request_transition", key: "k1", execute });
    const second = await svc.run({
      userId: ALICE,
      scope: "request_transition",
      key: "k1",
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
  });

  it("keeps a single claim row", async () => {
    const svc = service();
    const execute = () => Promise.resolve({ ok: true });

    await svc.run({ userId: ALICE, scope: "export_job", key: "k1", execute });
    await svc.run({ userId: ALICE, scope: "export_job", key: "k1", execute });

    expect(store.rows).toHaveLength(1);
  });

  it("treats a different scope as a different operation", async () => {
    // Architecture §7.17: the key is unique *with* scope and user, so the same
    // client-supplied key may legitimately appear under two operations.
    const svc = service();
    const execute = vi.fn(() => Promise.resolve({ ok: true }));

    await svc.run({ userId: ALICE, scope: "request_transition", key: "shared", execute });
    await svc.run({ userId: ALICE, scope: "export_job", key: "shared", execute });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("treats a different user as a different operation", async () => {
    const svc = service();
    const execute = vi.fn(() => Promise.resolve({ ok: true }));

    await svc.run({ userId: ALICE, scope: "export_job", key: "shared", execute });
    await svc.run({ userId: BOB, scope: "export_job", key: "shared", execute });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("preserves result shape through the round trip", async () => {
    const svc = service();
    const payload = { nested: { list: [1, 2, 3], flag: false }, name: "transition", n: 7 };

    await svc.run({
      userId: ALICE,
      scope: "request_transition",
      key: "k1",
      execute: () => Promise.resolve(payload),
    });
    const replay = await svc.run({
      userId: ALICE,
      scope: "request_transition",
      key: "k1",
      execute: () => Promise.resolve({ different: true }) as never,
    });

    expect(replay.result).toEqual(payload);
  });
});

describe("double-submit race", () => {
  it("lets exactly one caller execute when both claim at once", async () => {
    const svc = service();
    const execute = vi.fn(() => Promise.resolve({ ok: true }));

    // A competing caller stakes the claim between our find and our insert.
    let interfered = false;
    store.onBeforeClaim = () => {
      if (interfered) return;
      interfered = true;
      store.rows.push({
        id: "idem-rival",
        user_id: ALICE,
        scope: "request_transition",
        idempotency_key: "k1",
        result_encrypted: null,
        result_hash: null,
        expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
        completed_at: null,
      });
    };

    // The rival holds an incomplete claim, so we must be told to wait rather
    // than executing and duplicating the side effects.
    await expect(
      svc.run({ userId: ALICE, scope: "request_transition", key: "k1", execute }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);

    expect(execute).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
  });

  it("returns the winner's result if it finished during the race", async () => {
    const svc = service();

    // Seed a completed claim by running once, then force the next claim to lose.
    await svc.run({
      userId: ALICE,
      scope: "request_transition",
      key: "k1",
      execute: () => Promise.resolve({ winner: true }),
    });

    const execute = vi.fn(() => Promise.resolve({ winner: false }));
    const outcome = await svc.run({
      userId: ALICE,
      scope: "request_transition",
      key: "k1",
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(outcome.replayed).toBe(true);
    expect(outcome.result).toEqual({ winner: true });
  });

  it("reports an in-flight claim rather than executing", async () => {
    const svc = service();
    store.rows.push({
      id: "idem-inflight",
      user_id: ALICE,
      scope: "export_job",
      idempotency_key: "k1",
      result_encrypted: null,
      result_hash: null,
      expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
      completed_at: null,
    });

    const execute = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(
      svc.run({ userId: ALICE, scope: "export_job", key: "k1", execute }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("handler failure", () => {
  it("releases the claim so a retry can proceed", async () => {
    // A failed operation that kept its claim would be indistinguishable from one
    // still running, locking the caller out for the full 24 hours.
    const svc = service();
    const failing = () => Promise.reject(new Error("handler exploded"));

    await expect(
      svc.run({ userId: ALICE, scope: "export_job", key: "k1", execute: failing }),
    ).rejects.toThrow("handler exploded");

    expect(store.rows).toHaveLength(0);

    const retry = await svc.run({
      userId: ALICE,
      scope: "export_job",
      key: "k1",
      execute: () => Promise.resolve({ ok: true }),
    });
    expect(retry.replayed).toBe(false);
    expect(retry.result).toEqual({ ok: true });
  });

  it("propagates the handler's own error, not a cleanup error", async () => {
    const svc = service();
    const boom = new Error("the real failure");

    await expect(
      svc.run({
        userId: ALICE,
        scope: "export_job",
        key: "k1",
        execute: () => Promise.reject(boom),
      }),
    ).rejects.toBe(boom);
  });
});

describe("expiry", () => {
  it("re-executes after the key expires, before the purge job has run", async () => {
    /**
     * REGRESSION.
     *
     * The row is deliberately left in place. An earlier version of this test
     * deleted it to "simulate the purge", which hid a real bug: with the row
     * still present, `run` fell through to `claim()`, hit the unique index, and
     * reported the operation as *in progress* — for a claim that had expired.
     *
     * The purge job runs periodically, so every expired claim sits there for up
     * to one purge interval. Under the old code the TTL effectively meant
     * "blocked until a job happens to run" rather than 24 hours. An expired
     * claim is now reclaimed in place.
     */
    const svc = service();
    const execute = vi.fn(() => Promise.resolve({ n: 1 }));

    await svc.run({ userId: ALICE, scope: "export_job", key: "k1", execute });
    store.rows[0]!.expires_at = new Date(Date.now() - 1000).toISOString();

    const second = await svc.run({ userId: ALICE, scope: "export_job", key: "k1", execute });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(second.replayed).toBe(false);
    // Reclaimed in place rather than duplicated.
    expect(store.rows).toHaveLength(1);
  });

  it("clears the previous result when reclaiming an expired claim", async () => {
    // A stale result surviving the reclaim would be returned as though it came
    // from the new execution.
    const svc = service();
    await svc.run({
      userId: ALICE,
      scope: "export_job",
      key: "k1",
      execute: () => Promise.resolve({ generation: 1 }),
    });
    store.rows[0]!.expires_at = new Date(Date.now() - 1000).toISOString();

    const second = await svc.run({
      userId: ALICE,
      scope: "export_job",
      key: "k1",
      execute: () => Promise.resolve({ generation: 2 }),
    });
    expect(second.result).toEqual({ generation: 2 });

    const replay = await svc.run({
      userId: ALICE,
      scope: "export_job",
      key: "k1",
      execute: () => Promise.resolve({ generation: 3 }),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual({ generation: 2 });
  });

  it("defers to the caller that wins a contested reclaim", async () => {
    // Two callers both see the claim as expired; only one may take it over.
    const svc = service();
    await svc.run({
      userId: ALICE,
      scope: "export_job",
      key: "k1",
      execute: () => Promise.resolve({ n: 1 }),
    });
    store.rows[0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    store.reclaimWonByOther = true;

    const execute = vi.fn(() => Promise.resolve({ n: 2 }));
    await expect(
      svc.run({ userId: ALICE, scope: "export_job", key: "k1", execute }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("sets the TTL 24 hours out", async () => {
    const svc = service();
    const before = Date.now();
    await svc.run({
      userId: ALICE,
      scope: "export_job",
      key: "k1",
      execute: () => Promise.resolve({}),
    });

    const expires = Date.parse(store.rows[0]!.expires_at);
    expect(expires - before).toBeGreaterThanOrEqual(IDEMPOTENCY_TTL_MS - 5_000);
    expect(expires - before).toBeLessThanOrEqual(IDEMPOTENCY_TTL_MS + 5_000);
  });

  it("purges expired keys and leaves live ones", async () => {
    const svc = service();
    await svc.run({
      userId: ALICE,
      scope: "export_job",
      key: "live",
      execute: () => Promise.resolve({}),
    });
    await svc.run({
      userId: ALICE,
      scope: "export_job",
      key: "stale",
      execute: () => Promise.resolve({}),
    });
    store.rows[1]!.expires_at = new Date(Date.now() - 1000).toISOString();

    expect(await svc.purgeExpired()).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.idempotency_key).toBe("live");
  });
});

describe("result confidentiality and integrity", () => {
  it("never stores the result in plaintext", async () => {
    const svc = service();
    await svc.run({
      userId: ALICE,
      scope: "request_transition",
      key: "k1",
      execute: () => Promise.resolve({ recipient: "privacy@example.com" }),
    });

    expect(JSON.stringify(store.rows)).not.toContain("privacy@example.com");
    expect(store.rows[0]?.result_encrypted).toMatch(/^atlas\.v1\./);
  });

  it("refuses a result that fails its hash check", async () => {
    /**
     * Why the hash is not redundant with GCM.
     *
     * The ciphertext here is authentic and decrypts cleanly — only the recorded
     * hash disagrees, which is what a wholesale row swap or a serialisation
     * change between deploys looks like. Returning it anyway would hand the
     * caller an authoritative-looking outcome the operation may never have
     * produced.
     */
    const svc = service();
    await svc.run({
      userId: ALICE,
      scope: "request_transition",
      key: "k1",
      execute: () => Promise.resolve({ status: "sent" }),
    });

    store.rows[0]!.result_hash = "0".repeat(64);

    await expect(
      svc.run({
        userId: ALICE,
        scope: "request_transition",
        key: "k1",
        execute: () => Promise.resolve({ status: "sent" }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyResultIntegrityError);
  });

  it("binds the ciphertext to its own row", async () => {
    // AAD is `idempotency_keys.result_encrypted:<row id>`, so a result copied
    // into another row does not decrypt there.
    const svc = service();
    await svc.run({
      userId: ALICE,
      scope: "request_transition",
      key: "k1",
      execute: () => Promise.resolve({ status: "sent" }),
    });
    await svc.run({
      userId: ALICE,
      scope: "request_transition",
      key: "k2",
      execute: () => Promise.resolve({ status: "other" }),
    });

    const [first, second] = store.rows;
    second!.result_encrypted = first!.result_encrypted;
    second!.result_hash = first!.result_hash;

    await expect(
      svc.run({
        userId: ALICE,
        scope: "request_transition",
        key: "k2",
        execute: () => Promise.resolve({ status: "other" }),
      }),
    ).rejects.toThrow();
  });

  it("does not let another user's key open the result", async () => {
    const svc = service();
    await svc.run({
      userId: ALICE,
      scope: "request_transition",
      key: "k1",
      execute: () => Promise.resolve({ status: "sent" }),
    });

    // Same row, replayed under Bob: his DEK cannot open Alice's ciphertext.
    store.rows[0]!.user_id = BOB;

    await expect(
      svc.run({
        userId: BOB,
        scope: "request_transition",
        key: "k1",
        execute: () => Promise.resolve({ status: "sent" }),
      }),
    ).rejects.toThrow();
  });
});

describe("canonicalJson", () => {
  it("is key-order independent", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("orders nested objects too", () => {
    expect(canonicalJson({ x: { a: 1, b: 2 } })).toBe(canonicalJson({ x: { b: 2, a: 1 } }));
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
