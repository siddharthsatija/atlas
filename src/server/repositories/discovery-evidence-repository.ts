import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * Data access for `discovery_evidence` (ATL-207, ADR-008 §5, §7).
 *
 * ## Idempotency via ON CONFLICT DO NOTHING
 *
 * Migration `20260829090000_atl_207_discovery_evidence_source_identity.sql`
 * adds a unique constraint on
 * `(user_id, invocation_id, provider_class, field_id, source_identifier)`.
 * `insert` exploits this with `ignoreDuplicates: true`.  A conflict means the
 * evidence was already recorded; the caller observes a consistent outcome and
 * does not need to handle the race.
 *
 * ## Pre-generated row ID
 *
 * The caller pre-generates the row UUID before calling `insert`.  This allows
 * the encryption context AAD (`discovery_evidence.provider_evidence_json:<id>`)
 * to be bound to the row before the insert round-trip, consistent with
 * ADR-008 §7.  Pass the same UUID to both `EncryptionService.encrypt` and
 * `insert`.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * Thrown errors carry no database detail.  PostgREST error messages can include
 * row values; none must reach a log sink.
 */

export interface EvidenceInsertRow {
  userId: string;
  invocationId: string;
  providerClass: string;
  fieldId: string;
  /** Provider-normalised source key (e.g. breach_name.trim().toLowerCase()). */
  sourceIdentifier: string;
  isAggregatorAttributed: boolean;
  evidenceType: string;
  evidenceSummary: string;
  /** Encrypted provider evidence JSON (AAD = `discovery_evidence.provider_evidence_json:<id>`). */
  providerEvidenceJson: string;
}

export class DiscoveryEvidenceStoreError extends Error {
  constructor(public readonly operation: string) {
    super(`discovery evidence store failed: ${operation}`);
    this.name = "DiscoveryEvidenceStoreError";
  }
}

export class DiscoveryEvidenceRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Returns the provider identity columns for one evidence row (ATL-208).
   *
   * Used by the adjudication service to obtain the `provider_class` and
   * `source_identifier` needed to build the rejection fingerprint.
   *
   * Returns null when the evidence does not exist or does not belong to the
   * user — indistinguishable (non-oracle pattern, ADR-008 §8).
   *
   * Throws `DiscoveryEvidenceStoreError` on any genuine database error.
   */
  async findProviderIdentity(
    userId: string,
    evidenceId: string,
  ): Promise<{ providerClass: string; sourceIdentifier: string } | null> {
    const { data, error } = await this.db
      .from("discovery_evidence")
      .select("provider_class, source_identifier")
      .eq("user_id", userId)
      .eq("id", evidenceId)
      .maybeSingle();

    if (error) throw new DiscoveryEvidenceStoreError("findProviderIdentity");
    if (!data) return null;
    return {
      providerClass: data.provider_class,
      sourceIdentifier: data.source_identifier,
    };
  }

  /**
   * Inserts one evidence row, idempotent on the
   * `(user_id, invocation_id, provider_class, field_id, source_identifier)` key.
   *
   * The `id` parameter must be the same UUID used to build the encryption context
   * AAD before calling this method.  On conflict (duplicate identity key) the row
   * is silently ignored and the supplied `id` is returned as-is; the constraint
   * guarantees the existing row has the same identity.
   *
   * Throws `DiscoveryEvidenceStoreError` on any genuine database error.
   */
  async insert(id: string, row: EvidenceInsertRow): Promise<void> {
    const payload: Database["public"]["Tables"]["discovery_evidence"]["Insert"] = {
      id,
      user_id: row.userId,
      invocation_id: row.invocationId,
      provider_class: row.providerClass,
      field_id: row.fieldId,
      source_identifier: row.sourceIdentifier,
      is_aggregator_attributed: row.isAggregatorAttributed,
      evidence_type: row.evidenceType,
      evidence_summary: row.evidenceSummary,
      provider_evidence_json: row.providerEvidenceJson,
    };

    const { error } = await this.db
      .from("discovery_evidence")
      .upsert(payload, { ignoreDuplicates: true });

    if (error) throw new DiscoveryEvidenceStoreError("insert");
  }
}

/**
 * Generates a fresh UUID for a new evidence row.
 *
 * Exported so callers can pre-generate the ID and bind it into the encryption
 * context AAD before calling `DiscoveryEvidenceRepository.insert`.
 */
export function generateEvidenceId(): string {
  return randomUUID();
}
