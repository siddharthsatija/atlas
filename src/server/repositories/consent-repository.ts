import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { ConsentType, DiscoveryConsentType } from "@/lib/consent";

/**
 * Data access for `consents` (ATL-078, architecture §7.10).
 *
 * Append-only by design: this class exposes `append`, `latestFor`, and
 * `history`, and deliberately **no** update or delete method. Revocation is an
 * insert, not an edit, so there is no code path to mutate a consent record
 * because there is no method to call.
 */

export type ConsentRow = Database["public"]["Tables"]["consents"]["Row"];

/** One recorded decision. */
export interface ConsentRecord {
  id: string;
  userId: string;
  consentType: ConsentType | DiscoveryConsentType;
  policyVersion: string;
  granted: boolean;
  recordedAt: string;
}

function toRecord(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    consentType: row.consent_type as ConsentType | DiscoveryConsentType,
    policyVersion: row.policy_version,
    granted: row.granted,
    recordedAt: row.recorded_at,
  };
}

/**
 * Raised for any consent storage failure. Carries no database detail.
 *
 * The caller learns that the consent operation failed and nothing more — which
 * is all it can act on, and PostgREST error text can quote column values.
 */
export class ConsentStoreError extends Error {
  constructor() {
    super("consent store unavailable");
    this.name = "ConsentStoreError";
  }
}

export class ConsentRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /** Records one decision. Grants and revocations are both inserts. */
  async append(
    userId: string,
    consentType: ConsentType | DiscoveryConsentType,
    policyVersion: string,
    granted: boolean,
  ): Promise<ConsentRecord> {
    const { data, error } = await this.db
      .from("consents")
      .insert({
        user_id: userId,
        consent_type: consentType,
        policy_version: policyVersion,
        granted,
      })
      .select("*")
      .single();

    if (error || !data) throw new ConsentStoreError();
    return toRecord(data);
  }

  /**
   * The newest decision for one consent type, or null if never recorded.
   *
   * Ordered by `recorded_at` then `id` so the result is total rather than merely
   * usually-deterministic: two decisions can share a timestamp at millisecond
   * resolution, and an unstable tiebreak would make the gate's answer depend on
   * which row the planner happened to return first.
   */
  async latestFor(
    userId: string,
    consentType: ConsentType | DiscoveryConsentType,
  ): Promise<ConsentRecord | null> {
    const { data, error } = await this.db
      .from("consents")
      .select("*")
      // Scoped by user explicitly: the service-role client bypasses RLS, so
      // ownership is filtered here or not at all.
      .eq("user_id", userId)
      .eq("consent_type", consentType)
      .order("recorded_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1);

    if (error) throw new ConsentStoreError();
    const row = (data ?? [])[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Full history, newest first — what Settings renders (ATL-076).
   *
   * Every decision is returned, including superseded ones. The point of the
   * history is that a user can see they granted, revoked, and re-granted; a view
   * that collapsed to current state would answer a different question.
   */
  async history(userId: string, limit = 500): Promise<ConsentRecord[]> {
    const { data, error } = await this.db
      .from("consents")
      .select("*")
      .eq("user_id", userId)
      .order("recorded_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);

    if (error) throw new ConsentStoreError();
    return (data ?? []).map(toRecord);
  }
}
