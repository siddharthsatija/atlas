import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * Data access for `discovery_candidate_evidence` (ATL-215, ADR-008 §5).
 *
 * The join table records every evidence→candidate association for canonical
 * external-profile candidates.  The founding evidence appears here (in
 * addition to `discovery_candidates.evidence_id`) so the join table
 * represents the complete evidence set for a canonical candidate.
 *
 * ## Idempotency
 *
 * The table carries `UNIQUE (user_id, evidence_id)` so a second call for the
 * same pair silently succeeds (`ignoreDuplicates: true`).  One evidence
 * record may associate with at most one candidate; the constraint prevents
 * accidental duplication across candidates.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * Thrown errors carry no database detail.  PostgREST messages can include
 * row values; none must reach a log sink.
 */
export class DiscoveryCandidateEvidenceStoreError extends Error {
  constructor(public readonly operation: string) {
    super(`discovery candidate evidence store failed: ${operation}`);
    this.name = "DiscoveryCandidateEvidenceStoreError";
  }
}

export class DiscoveryCandidateEvidenceRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Associates an evidence record with a canonical candidate.
   *
   * Idempotent on `(user_id, evidence_id)`.  A second call for the same pair
   * — e.g. from a retry after a transient failure — silently succeeds without
   * changing database state.
   *
   * Throws `DiscoveryCandidateEvidenceStoreError` on any genuine database
   * error.
   */
  async insert(userId: string, candidateId: string, evidenceId: string): Promise<void> {
    const payload: Database["public"]["Tables"]["discovery_candidate_evidence"]["Insert"] = {
      user_id: userId,
      candidate_id: candidateId,
      evidence_id: evidenceId,
    };

    const { error } = await this.db
      .from("discovery_candidate_evidence")
      .upsert(payload, { ignoreDuplicates: true });

    if (error) throw new DiscoveryCandidateEvidenceStoreError("insert");
  }
}

/**
 * Generates a fresh UUID for a new join row.
 *
 * Exported for callers that need to pre-generate the id (e.g. for testing).
 */
export function generateCandidateEvidenceId(): string {
  return randomUUID();
}
