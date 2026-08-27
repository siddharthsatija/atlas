import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import {
  EncryptionKeyRepository,
  type EncryptionKeyRecord,
} from "@/server/repositories/encryption-key-repository";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { currentKek, kekForVersion } from "./kek";
import {
  CryptoError,
  generateDek,
  open,
  seal,
  unwrapDek,
  wrapDek,
  zeroize,
  type EncryptionContext,
} from "./envelope";

/**
 * The application-facing encryption API (ATL-084, ADR-003).
 *
 * Repositories call this; services deal in plaintext domain objects and never
 * see a key, a nonce, or an envelope. UI and AI layers never reach it at all —
 * it is `server-only` and sits behind the ESLint layer boundaries.
 *
 * ## What this ticket deliberately does not do
 *
 * No product column is encrypted here. The ADR-003 inventory —
 * `user_personal_fields.value_encrypted`, `digital_assets.
 * account_identifier_encrypted`, the `data_requests` columns,
 * `ai_messages.content_encrypted` — belongs to the tickets that create those
 * tables. This module is the capability they will use, complete and tested,
 * with no caller yet.
 *
 * Reveal auditing (security §8) is **ATL-103**: the audit writer does not exist,
 * and a half-written hash chain is worse than none. The seam is marked below.
 */

export class EncryptionService {
  private readonly keys: EncryptionKeyRepository;

  constructor(db: SupabaseClient<Database>) {
    this.keys = new EncryptionKeyRepository(db);
  }

  /** Uses the service-role client, which is the only role that can reach the key table. */
  static create(): EncryptionService {
    return new EncryptionService(createServiceRoleClient());
  }

  /**
   * Encrypts one value for one user, creating their DEK if this is the first
   * restricted write.
   *
   * Lazy creation per ADR-003: a user who never stores a restricted value never
   * gets a key, so there is nothing to rotate, shred, or leak for the majority
   * of accounts.
   */
  async encrypt(userId: string, plaintext: string, context: EncryptionContext): Promise<string> {
    const dek = await this.writeDek(userId);
    try {
      return seal(dek, plaintext, context);
    } finally {
      // Narrows the window in which a heap dump yields the key. Best effort —
      // see `zeroize`. Never treated as a control.
      zeroize(dek);
    }
  }

  /**
   * Decrypts one value.
   *
   * Fail-closed: every failure throws. There is no "return the ciphertext" or
   * "return a placeholder" path, because a caller that silently rendered either
   * would show a user someone else's data or leak an envelope into a UI.
   *
   * AUDIT SEAM (ATL-103): security §8 requires sensitive-value *reveal* actions
   * to be recorded. That belongs with the audit writer, and the reveal action
   * itself is ATL-035 — not every decrypt is a reveal, so instrumenting here
   * would over-record and still miss the user-facing event.
   */
  async decrypt(userId: string, envelope: string, context: EncryptionContext): Promise<string> {
    const dek = await this.readDek(userId);
    try {
      return open(dek, envelope, context);
    } finally {
      zeroize(dek);
    }
  }

  /**
   * Classifies the user's content-key state from a single unfiltered read.
   *
   * Filters to `key_purpose = 'content'` before classification so that a
   * rejection key (ATL-203) row — active or destroyed — cannot interfere with
   * content-key operations. A destroyed rejection key must not read as the
   * content key being destroyed, and an active rejection key must not satisfy
   * the "is there already an active key?" check.
   *
   * `destroyed` is checked independently of `active` rather than as an `else`:
   * the unique partial index only covers `status = 'active'`, so a destroyed row
   * and an active row can coexist. If that ever happens the account has been
   * re-keyed after a shred, and the destroyed verdict must win.
   */
  private async keyState(userId: string): Promise<{
    active: EncryptionKeyRecord | null;
    destroyed: boolean;
  }> {
    const rows = await this.keys.findForUser(userId);
    const contentRows = rows.filter((r) => r.keyPurpose === "content");
    return {
      active: contentRows.find((row) => row.status === "active") ?? null,
      destroyed: contentRows.some((row) => row.status === "destroyed"),
    };
  }

  /**
   * Resolves the DEK for a **read**. Never creates one.
   *
   * A read has nothing to lazily create: if no usable key exists, the ciphertext
   * the caller is holding cannot have been produced by this user's key, so
   * minting a fresh one would only produce a key guaranteed not to open it.
   *
   * The destroyed check must happen *before* AES-GCM is attempted. GCM cannot
   * distinguish a wrong key from tampered ciphertext — both surface as a failed
   * tag check — so decrypting under a replacement key reports
   * `integrity_failure`, which means "wrong key, wrong AAD, or tampering" and
   * reads as a security incident. After a crypto-shred the truth is
   * `key_destroyed`: permanent, expected, and not an incident. Ordering the
   * check first is what keeps those two signals apart.
   */
  private async readDek(userId: string): Promise<Buffer> {
    const { active, destroyed } = await this.keyState(userId);
    if (destroyed) throw new CryptoError("key_destroyed");
    if (!active) throw new CryptoError("key_unavailable");
    return this.unwrap(active.wrappedDek, userId, active.kekVersion);
  }

  /**
   * Resolves the user's active DEK for a **write**, creating one if this is
   * their first restricted value.
   *
   * A crypto-shredded user is refused rather than re-keyed. Nothing in the
   * schema stops the insert — the unique index is partial (`where status =
   * 'active'`), so a destroyed row leaves the active slot free — which means
   * irreversibility is this method's responsibility, not the database's.
   * Without the check, shredding is undone by the next write: the account
   * silently regains a usable key and starts accumulating recoverable
   * ciphertext, contradicting the ADR-003 guarantee that destruction is final.
   *
   * The insert can lose a race with a concurrent first write. Losing is handled
   * by re-reading rather than retrying the insert: the unique partial index has
   * already guaranteed the winner's key is the only active one, and a second
   * active key would leave half the user's data outside a future crypto-shred.
   */
  private async writeDek(userId: string): Promise<Buffer> {
    const existing = await this.keyState(userId);
    if (existing.destroyed) throw new CryptoError("key_destroyed");
    if (existing.active) {
      return this.unwrap(existing.active.wrappedDek, userId, existing.active.kekVersion);
    }

    const kek = currentKek();
    const dek = generateDek();
    const wrapped = wrapDek(kek.key, dek, userId, kek.version);
    const created = await this.keys.insertActive(userId, wrapped, kek.version);

    // Deliberately not wrapped in try/finally: on the winning path this buffer
    // is the return value, so zeroizing it would hand the caller a zeroed key.
    if (created) return dek;

    // Lost the race — discard our key and adopt the winner's.
    zeroize(dek);
    const winner = await this.keyState(userId);
    if (winner.destroyed) throw new CryptoError("key_destroyed");
    if (!winner.active) throw new CryptoError("key_unavailable");
    return this.unwrap(winner.active.wrappedDek, userId, winner.active.kekVersion);
  }

  private unwrap(wrapped: string | null, userId: string, kekVersion: number): Buffer {
    // Defence in depth. `keyState` already routes a destroyed key away from
    // here, so reaching this with a null wrapping means an active row lost its
    // material — a state the check constraint forbids. Unreadable either way.
    if (wrapped === null) throw new CryptoError("key_destroyed");
    return unwrapDek(kekForVersion(kekVersion), wrapped, userId, kekVersion);
  }

  /**
   * Re-wraps DEKs from an older KEK generation to the current one.
   *
   * Metadata only: the DEK itself is unchanged, so **no data row is touched** and
   * no ciphertext is rewritten. That is the whole reason for envelope encryption
   * — rotating the KEK across a million users costs a million tiny updates, not a
   * re-encryption of the database.
   *
   * Idempotent and resumable. Each update is guarded on the row's expected
   * version, so an interrupted sweep is restarted by calling again, and two
   * sweeps running at once cannot double-wrap.
   *
   * @returns how many keys this batch re-wrapped.
   */
  async rotateKek(fromVersion: number, batchSize = 100): Promise<number> {
    const target = currentKek();
    if (fromVersion === target.version) return 0;

    const sourceKek = kekForVersion(fromVersion);
    // Purpose-scoped: content and rejection keys use different wrapping AADs.
    // Passing a rejection key row to `unwrapDek` would fail authentication
    // (wrong AAD) and break the rotation sweep. Rejection keys are rotated
    // by `RejectionKeyService.rotateKek`, which uses `seal`/`open` with the
    // correct `wrapContext(record.id)` AAD. (ATL-203, ADR-008 §5.)
    const batch = await this.keys.listWrappedUnderByPurpose("content", fromVersion, batchSize);

    let rewrapped = 0;
    for (const record of batch) {
      if (record.wrappedDek === null) continue;

      const dek = unwrapDek(sourceKek, record.wrappedDek, record.userId, record.kekVersion);
      try {
        const wrapped = wrapDek(target.key, dek, record.userId, target.version);
        if (await this.keys.rewrap(record.id, fromVersion, wrapped, target.version)) rewrapped += 1;
      } finally {
        zeroize(dek);
      }
    }

    return rewrapped;
  }

  /**
   * Crypto-shredding — the first data-destruction step of account deletion
   * (security §16 step 5).
   *
   * Destroys every DEK the user holds. Once the wrapped material is gone, every
   * value encrypted under it is unrecoverable by anyone, including from provider
   * backups, because the backups contain only ciphertext and a destroyed
   * wrapping.
   *
   * Irreversible, and deliberately so. The row survives as evidence that a key
   * existed and was destroyed; only the material is removed.
   *
   * Idempotent: shredding an already-shredded account reports zero keys
   * destroyed rather than failing, so a resumed deletion workflow is safe.
   *
   * ATL-082 owns the surrounding deletion workflow. This is the primitive it
   * calls first.
   */
  async destroyUserKeys(userId: string, now: Date = new Date()): Promise<number> {
    return this.keys.destroyAllForUser(userId, now.toISOString());
  }
}
