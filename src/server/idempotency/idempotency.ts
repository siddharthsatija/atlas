import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { EncryptionService } from "@/server/crypto/encryption-service";
import { logger } from "@/lib/telemetry/logger";
import {
  IdempotencyKeyRepository,
  type IdempotencyClaim,
} from "@/server/repositories/idempotency-key-repository";

/**
 * Idempotent execution for transitions and jobs (ATL-104, architecture §7.17,
 * §14).
 *
 * Wraps a handler so that submitting the same `(user, scope, key)` twice runs it
 * once and returns the same result both times.
 *
 * ## Claim before execute
 *
 * The row is inserted *before* the handler runs, not after. That ordering is the
 * whole design:
 *
 *  - Writing the row afterwards would leave a window in which two concurrent
 *    submissions both find nothing, both execute, and only then discover the
 *    collision — with the side effects already applied twice.
 *  - Inserting first makes the unique index the arbiter. Exactly one caller wins
 *    the insert; the loser gets a unique violation and knows, without any
 *    application-level coordination, that someone else owns the operation.
 *
 * A claim with no result yet means "in flight". That is why the result column is
 * nullable rather than there being a separate status column: the two would have
 * to be kept consistent, and a row asserting `completed` with no result is a
 * state the replay path could not act on.
 *
 * ## Why the result is encrypted
 *
 * Architecture §7.17 listed only `result_hash`, which cannot return a result.
 * Storing the payload makes this table a second copy of data that already lives
 * somewhere better-guarded, so it is encrypted with the ADR-003 envelope scheme
 * and bound by AAD to this table, column, and row. A result copied into another
 * row will not decrypt there.
 *
 * `result_hash` is kept as well, and is not redundant: GCM detects tampering
 * with *these bytes*, while the hash detects a result that decrypts cleanly but
 * is not what was recorded.
 */

/** Security §retention and architecture §7.17. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const AAD_TABLE = "idempotency_keys";
const AAD_COLUMN = "result_encrypted";

/** Raised when another caller holds the claim and has not finished. */
export class IdempotencyInProgressError extends Error {
  readonly scope: string;

  constructor(scope: string) {
    super("an operation with this idempotency key is already in progress");
    this.name = "IdempotencyInProgressError";
    this.scope = scope;
  }
}

/**
 * Raised when a stored result decrypts but does not match its recorded hash.
 *
 * Fail closed: returning a result we cannot vouch for is worse than failing,
 * because the caller would treat it as the authoritative outcome of an operation
 * that may never have produced it.
 */
export class IdempotencyResultIntegrityError extends Error {
  constructor() {
    super("recorded idempotency result failed its integrity check");
    this.name = "IdempotencyResultIntegrityError";
  }
}

export interface IdempotentOutcome<T> {
  result: T;
  /** True when the result came from a previous execution. */
  replayed: boolean;
}

export interface RunIdempotentInput<T> {
  userId: string;
  /** Operation family, e.g. `request_transition`. */
  scope: string;
  /** Caller-supplied key. Opaque. */
  key: string;
  execute: () => Promise<T>;
}

/**
 * Stable JSON serialisation, so the hash of a result does not depend on key
 * order.
 *
 * `JSON.stringify` follows insertion order, so two structurally identical
 * results built by different code paths would hash differently and a replay
 * would fail its integrity check for no reason.
 *
 * NOTE: `audit-event.ts` (ATL-103) contains an equivalent ordering helper. They
 * are deliberately not shared yet — consolidating would mean editing a module
 * from a different ticket. Converging them is a follow-up.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortValue(v)]),
    );
  }
  return value;
}

function hashResult(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export class IdempotencyService {
  private readonly claims: IdempotencyKeyRepository;
  private readonly crypto: EncryptionService;

  constructor(db: SupabaseClient<Database>, crypto?: EncryptionService) {
    this.claims = new IdempotencyKeyRepository(db);
    this.crypto = crypto ?? new EncryptionService(db);
  }

  /** Uses the service-role client — the only role that can reach the table. */
  static create(): IdempotencyService {
    const db = createServiceRoleClient();
    return new IdempotencyService(db, new EncryptionService(db));
  }

  /**
   * Runs `execute` at most once per `(user, scope, key)` within the TTL.
   *
   * Returns the recorded result on replay without re-executing.
   */
  async run<T>({
    userId,
    scope,
    key,
    execute,
  }: RunIdempotentInput<T>): Promise<IdempotentOutcome<T>> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString();
    const existing = await this.claims.find(userId, scope, key);

    if (existing) {
      const replay = await this.replay<T>(userId, existing, now);
      if (replay) return replay;

      /**
       * Expired, and the row is still here.
       *
       * The purge job runs periodically, so an expired claim outlives its TTL by
       * up to one purge interval. Falling through to `claim()` in that window
       * hits the unique index, and the caller would be told the operation is "in
       * progress" — for a claim that expired hours ago. The TTL would then mean
       * "blocked until a job happens to run" rather than 24 hours.
       *
       * Reclaiming the row in place resets it to in-flight under a guard that
       * only one caller can satisfy.
       */
      const reclaimed = await this.claims.reclaimExpired(existing.id, expiresAt, now.toISOString());
      if (reclaimed) {
        const fresh: IdempotencyClaim = {
          ...existing,
          expiresAt,
          resultEncrypted: null,
          resultHash: null,
          completedAt: null,
        };
        return { result: await this.executeAndRecord(userId, fresh, execute), replayed: false };
      }

      // Another caller reclaimed it first; defer to whatever they recorded.
      return this.deferToWinner<T>(userId, scope, key, now);
    }

    const claim = await this.claims.claim(userId, scope, key, expiresAt);

    // Lost the insert race. The winner either finished between our insert and
    // this read — in which case its result is authoritative — or is still
    // running, which the caller must be told rather than guessing.
    if (!claim) return this.deferToWinner<T>(userId, scope, key, now);

    return { result: await this.executeAndRecord(userId, claim, execute), replayed: false };
  }

  /**
   * Reads whatever the caller that beat us recorded.
   *
   * Throws rather than executing when there is no usable result: the whole point
   * of losing the race is that somebody else owns the side effects.
   */
  private async deferToWinner<T>(
    userId: string,
    scope: string,
    key: string,
    now: Date,
  ): Promise<IdempotentOutcome<T>> {
    const winner = await this.claims.find(userId, scope, key);
    if (winner) {
      const replay = await this.replay<T>(userId, winner, now);
      if (replay) return replay;
    }
    throw new IdempotencyInProgressError(scope);
  }

  /**
   * Returns the recorded result, or null when the claim is expired.
   *
   * Throws `IdempotencyInProgressError` for a live claim that has not completed:
   * that is not a "no result yet, go ahead" — executing would duplicate the
   * side effects the claim exists to prevent.
   */
  private async replay<T>(
    userId: string,
    claim: IdempotencyClaim,
    now: Date,
  ): Promise<IdempotentOutcome<T> | null> {
    if (Date.parse(claim.expiresAt) <= now.getTime()) return null;

    if (claim.resultEncrypted === null || claim.resultHash === null) {
      throw new IdempotencyInProgressError(claim.scope);
    }

    const canonical = await this.crypto.decrypt(userId, claim.resultEncrypted, {
      table: AAD_TABLE,
      column: AAD_COLUMN,
      recordId: claim.id,
    });

    if (hashResult(canonical) !== claim.resultHash) {
      throw new IdempotencyResultIntegrityError();
    }

    return { result: JSON.parse(canonical) as T, replayed: true };
  }

  /**
   * Runs the handler and records its result against the claim.
   *
   * On failure the claim is released so a retry can proceed. A failed operation
   * that kept its claim would be indistinguishable from one still running, and
   * the caller would be locked out for the full 24 hours over a transient error.
   */
  private async executeAndRecord<T>(
    userId: string,
    claim: IdempotencyClaim,
    execute: () => Promise<T>,
  ): Promise<T> {
    let result: T;
    try {
      result = await execute();
    } catch (error) {
      await this.releaseQuietly(claim.id);
      throw error;
    }

    const canonical = canonicalJson(result);

    // Encrypted after the claim exists, because the AAD binds the ciphertext to
    // this row's id — which only exists once the row does.
    const encrypted = await this.crypto.encrypt(userId, canonical, {
      table: AAD_TABLE,
      column: AAD_COLUMN,
      recordId: claim.id,
    });

    await this.claims.complete(
      claim.id,
      encrypted,
      hashResult(canonical),
      new Date().toISOString(),
    );

    return result;
  }

  /**
   * Releasing is best effort.
   *
   * The handler's own error is what the caller needs; a failure to clean up
   * would otherwise replace it, and the claim expires on its own regardless.
   */
  private async releaseQuietly(id: string): Promise<void> {
    try {
      await this.claims.release(id);
    } catch {
      logger.warn("idempotency.release_failed", { operation: "idempotency.release" });
    }
  }

  /**
   * Purges expired keys (architecture §14, security §retention).
   *
   * Loops in bounded batches until the table is clear, so one run drains a
   * backlog without ever issuing an unbounded delete.
   */
  async purgeExpired(now: Date = new Date(), batchSize = 1000): Promise<number> {
    let total = 0;

    for (;;) {
      const removed = await this.claims.purgeExpired(now.toISOString(), batchSize);
      total += removed;
      if (removed < batchSize) break;
    }

    logger.info("idempotency.purged", {
      jobName: "idempotency-purge",
      jobStatus: "succeeded",
      count: total,
    });

    return total;
  }
}

/**
 * Convenience wrapper over `IdempotencyService.run`.
 *
 * The service is injectable so tests and callers that already hold one do not
 * construct a second service-role client per operation.
 */
export async function runIdempotent<T>(
  input: RunIdempotentInput<T>,
  service: IdempotencyService = IdempotencyService.create(),
): Promise<IdempotentOutcome<T>> {
  return service.run(input);
}
