import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * Data access for `discovery_first_disclosure_acknowledgments` (ATL-205,
 * ADR-008 §3).
 *
 * ## Idempotency via ON CONFLICT DO NOTHING
 *
 * The table carries a UNIQUE constraint on `(user_id, field_id, provider_class,
 * disclosure_contract_version)`. The `record` method exploits this: it always
 * issues an INSERT … ON CONFLICT DO NOTHING, never a SELECT-then-INSERT. This
 * means concurrent calls for the same tuple are safe — whichever insert wins,
 * both callers observe a consistent outcome and neither throws. A race that
 * causes a conflict is not an error; it means the acknowledgment was recorded
 * once, which is the desired state.
 *
 * ## Error handling
 *
 * Both methods throw on any database error. They never return a false negative
 * (claiming not-acknowledged when they could not tell). Callers treat a throw
 * as a transient failure and surface it as UNAVAILABLE.
 */
export class DisclosureAcknowledgmentRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Records that the user acknowledged first-disclosure terms for one field /
   * provider / contract-version tuple.
   *
   * Idempotent: a second call for the same tuple silently succeeds. Throws on
   * any genuine database error.
   */
  async record(
    userId: string,
    fieldId: string,
    providerClass: string,
    contractVersion: string,
  ): Promise<void> {
    // upsert with ignoreDuplicates generates INSERT … ON CONFLICT DO NOTHING.
    // A conflict (duplicate tuple) is not an error: a second call confirms the
    // acknowledgment is already present, which is the desired state.
    const { error } = await this.db.from("discovery_first_disclosure_acknowledgments").upsert(
      {
        user_id: userId,
        field_id: fieldId,
        provider_class: providerClass,
        disclosure_contract_version: contractVersion,
      },
      { ignoreDuplicates: true },
    );

    if (error) throw new DisclosureAcknowledgmentStoreError();
  }

  /**
   * Returns true if the user has previously acknowledged the given tuple.
   *
   * Throws on any database error rather than returning false silently — a query
   * failure must not be mistaken for "no acknowledgment found".
   */
  async hasAcknowledged(
    userId: string,
    fieldId: string,
    providerClass: string,
    contractVersion: string,
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from("discovery_first_disclosure_acknowledgments")
      .select("id")
      .eq("user_id", userId)
      .eq("field_id", fieldId)
      .eq("provider_class", providerClass)
      .eq("disclosure_contract_version", contractVersion)
      .limit(1);

    if (error) throw new DisclosureAcknowledgmentStoreError();
    return (data ?? []).length > 0;
  }
}

/**
 * Raised for any disclosure acknowledgment storage failure.
 *
 * Carries no database detail: PostgREST error text can include row values,
 * and ADR-008 §16 forbids those reaching a log sink.
 */
export class DisclosureAcknowledgmentStoreError extends Error {
  constructor() {
    super("disclosure acknowledgment store unavailable");
    this.name = "DisclosureAcknowledgmentStoreError";
  }
}
