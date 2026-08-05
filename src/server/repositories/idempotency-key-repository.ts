import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * Data access for `idempotency_keys` (ATL-104, architecture §7.17).
 *
 * Requires the service-role client: the table has RLS enabled with no policies,
 * so no other role can reach it at all.
 *
 * This layer deals only in ciphertext. The plaintext result is encrypted before
 * it arrives here and decrypted after it leaves, so a bug in data access cannot
 * put a readable result anywhere it does not belong — the same rule
 * `encryption-key-repository.ts` follows for wrapped keys.
 */

export type IdempotencyRow = Database["public"]["Tables"]["idempotency_keys"]["Row"];

/** A claim row as this layer exposes it. */
export interface IdempotencyClaim {
  id: string;
  userId: string;
  scope: string;
  idempotencyKey: string;
  /** Null while the operation is claimed but still running. */
  resultEncrypted: string | null;
  resultHash: string | null;
  expiresAt: string;
  completedAt: string | null;
}

function toClaim(row: IdempotencyRow): IdempotencyClaim {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope,
    idempotencyKey: row.idempotency_key,
    resultEncrypted: row.result_encrypted,
    resultHash: row.result_hash,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}

/** Raised for any idempotency storage failure. Carries no database detail. */
export class IdempotencyStoreError extends Error {
  constructor() {
    super("idempotency store unavailable");
    this.name = "IdempotencyStoreError";
  }
}

/** Postgres unique-violation — another caller already staked this claim. */
const UNIQUE_VIOLATION = "23505";

export class IdempotencyKeyRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Stakes a claim.
   *
   * Returns `null` when another caller already holds it, rather than throwing:
   * losing this race is an expected, routine outcome on the duplicate-submission
   * path, not an error condition. Every other failure still throws.
   */
  async claim(
    userId: string,
    scope: string,
    idempotencyKey: string,
    expiresAt: string,
  ): Promise<IdempotencyClaim | null> {
    const { data, error } = await this.db
      .from("idempotency_keys")
      .insert({
        user_id: userId,
        scope,
        idempotency_key: idempotencyKey,
        expires_at: expiresAt,
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION) return null;
      throw new IdempotencyStoreError();
    }
    if (!data) throw new IdempotencyStoreError();

    return toClaim(data);
  }

  async find(
    userId: string,
    scope: string,
    idempotencyKey: string,
  ): Promise<IdempotencyClaim | null> {
    const { data, error } = await this.db
      .from("idempotency_keys")
      .select("*")
      // Scoped by user as well as key: this client bypasses RLS, so ownership is
      // filtered here or not at all.
      .eq("user_id", userId)
      .eq("scope", scope)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (error) throw new IdempotencyStoreError();
    return data ? toClaim(data) : null;
  }

  /**
   * Records the result against a claim.
   *
   * Guarded on `completed_at is null` so a late write cannot overwrite a result
   * that another caller already recorded — the replay path would then return
   * something different depending on when it was asked. Returns false when the
   * guard rejected the update.
   */
  async complete(
    id: string,
    resultEncrypted: string,
    resultHash: string,
    completedAt: string,
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from("idempotency_keys")
      .update({
        result_encrypted: resultEncrypted,
        result_hash: resultHash,
        completed_at: completedAt,
      })
      .eq("id", id)
      .is("completed_at", null)
      .select("id");

    if (error) throw new IdempotencyStoreError();
    return (data ?? []).length > 0;
  }

  /**
   * Takes over a claim whose TTL has passed, resetting it to in-flight.
   *
   * Reclaiming in place rather than deleting and re-inserting is what keeps the
   * expiry path atomic. The guard `expires_at < now` is re-evaluated under the
   * row lock, so of two callers that both saw the row as expired exactly one
   * update matches; the other affects no rows and learns it lost. A
   * delete-then-insert pair would leave a window between the two statements in
   * which both callers could insert.
   *
   * The row id is preserved deliberately: the AAD binding of any future result
   * ciphertext uses it, and reusing the row keeps that binding stable.
   *
   * Returns false when another caller reclaimed it first.
   */
  async reclaimExpired(id: string, expiresAt: string, now: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("idempotency_keys")
      .update({
        expires_at: expiresAt,
        result_encrypted: null,
        result_hash: null,
        completed_at: null,
      })
      .eq("id", id)
      .lt("expires_at", now)
      .select("id");

    if (error) throw new IdempotencyStoreError();
    return (data ?? []).length > 0;
  }

  /**
   * Releases a claim whose handler failed.
   *
   * Guarded on `completed_at is null` so a release can never remove a recorded
   * result. Without the guard, a handler that failed *after* completing — during
   * cleanup, say — would delete the very result a concurrent replay is about to
   * return.
   */
  async release(id: string): Promise<void> {
    const { error } = await this.db
      .from("idempotency_keys")
      .delete()
      .eq("id", id)
      .is("completed_at", null);

    if (error) throw new IdempotencyStoreError();
  }

  /**
   * Purges expired keys (security §retention: 24 hours).
   *
   * Bounded per call so the job cannot issue an unbounded delete against a table
   * that has grown unexpectedly; the caller loops until it returns zero.
   */
  async purgeExpired(now: string, limit = 1000): Promise<number> {
    const { data: expired, error: findError } = await this.db
      .from("idempotency_keys")
      .select("id")
      .lt("expires_at", now)
      .limit(limit);

    if (findError) throw new IdempotencyStoreError();

    const ids = (expired ?? []).map((row) => row.id);
    if (ids.length === 0) return 0;

    const { data, error } = await this.db
      .from("idempotency_keys")
      .delete()
      .in("id", ids)
      .select("id");

    if (error) throw new IdempotencyStoreError();
    return (data ?? []).length;
  }
}
