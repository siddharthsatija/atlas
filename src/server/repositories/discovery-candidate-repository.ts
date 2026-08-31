import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * Data access for `discovery_candidates` (ATL-207, ADR-008 §5).
 *
 * ## Idempotency
 *
 * `discovery_candidates` carries a partial unique index:
 * `UNIQUE (user_id, evidence_id) WHERE status = 'pending'`.  A second insert
 * for the same evidence while the first is still pending conflicts and is
 * ignored (`ignoreDuplicates: true`), covering the re-delivery case without a
 * SELECT-then-INSERT.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * Thrown errors carry no database detail.  PostgREST messages can include row
 * values; none must reach a log sink.
 */
export class DiscoveryCandidateStoreError extends Error {
  constructor(public readonly operation: string) {
    super(`discovery candidate store failed: ${operation}`);
    this.name = "DiscoveryCandidateStoreError";
  }
}

export class DiscoveryCandidateRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Inserts a candidate row in `pending` status for the given evidence.
   *
   * Idempotent on `(user_id, evidence_id)` while status is `pending`.  A
   * second call for the same pair before adjudication silently succeeds.
   *
   * Throws `DiscoveryCandidateStoreError` on any genuine database error.
   */
  async insert(userId: string, evidenceId: string): Promise<void> {
    const { error } = await this.db.from("discovery_candidates").upsert(
      {
        user_id: userId,
        evidence_id: evidenceId,
        status: "pending",
      },
      { ignoreDuplicates: true },
    );

    if (error) throw new DiscoveryCandidateStoreError("insert");
  }
}
