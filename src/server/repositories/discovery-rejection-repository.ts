import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * Data access for `discovery_rejections` (ATL-207, ADR-008 §5, §8).
 *
 * A rejection fingerprint is an HMAC-SHA256 over the provider class and the
 * normalised source identifier, encoded as a JSON envelope:
 * `{"v":1,"alg":"hmac-sha256","value":"<base64url>"}`.  The fingerprint is
 * stored with the provider class so queries can scope to one provider without
 * decoding the envelope.
 *
 * ## Fail-closed reads
 *
 * `exists` throws on any database error rather than returning `false` silently.
 * A query failure must never be treated as "no rejection found"; that would
 * allow a rejected source to surface as a candidate the next time the query
 * fails.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * Fingerprint values must never appear in logs.  Thrown errors carry no
 * database detail; PostgREST messages can include row values.
 */
export class DiscoveryRejectionStoreError extends Error {
  constructor(public readonly operation: string) {
    super(`discovery rejection store failed: ${operation}`);
    this.name = "DiscoveryRejectionStoreError";
  }
}

export class DiscoveryRejectionRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Records a rejection fingerprint for this user.
   *
   * Idempotent on `(user_id, fingerprint)`: a second insert for the same
   * fingerprint silently succeeds (ON CONFLICT DO NOTHING via `ignoreDuplicates`).
   * The adjudication service inserts the fingerprint BEFORE transitioning the
   * candidate status so that a partial failure on the status update leaves the
   * fingerprint in place — a retry will re-insert (ignored) and re-attempt the
   * transition.
   *
   * Throws `DiscoveryRejectionStoreError` on any genuine database error.
   */
  async insert(userId: string, providerClass: string, fingerprint: string): Promise<void> {
    const { error } = await this.db
      .from("discovery_rejections")
      .upsert(
        { user_id: userId, provider_class: providerClass, fingerprint },
        { ignoreDuplicates: true },
      );

    if (error) throw new DiscoveryRejectionStoreError("insert");
  }

  /**
   * Returns `true` when a rejection with the given fingerprint and provider
   * class already exists for this user.
   *
   * Fail-closed: throws `DiscoveryRejectionStoreError` on any database error
   * rather than returning `false`.  The caller must not insert a candidate when
   * the rejection check could not be completed.
   */
  async exists(userId: string, providerClass: string, fingerprint: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("discovery_rejections")
      .select("id")
      .eq("user_id", userId)
      .eq("provider_class", providerClass)
      .eq("fingerprint", fingerprint)
      .limit(1);

    if (error) throw new DiscoveryRejectionStoreError("exists");
    return (data ?? []).length > 0;
  }
}
