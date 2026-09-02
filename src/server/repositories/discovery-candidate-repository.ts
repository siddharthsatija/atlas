import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * Data access for `discovery_candidates` (ATL-207, ATL-215, ADR-008 §5).
 *
 * ## Idempotency
 *
 * `discovery_candidates` carries a partial unique index:
 * `UNIQUE (user_id, evidence_id) WHERE status = 'pending'`.  A second insert
 * for the same evidence while the first is still pending conflicts and is
 * ignored (`ignoreDuplicates: true`), covering the re-delivery case without a
 * SELECT-then-INSERT.
 *
 * ## Canonical candidates (ATL-215)
 *
 * When `canonical_profile_uri` is provided a second partial unique index
 * `UNIQUE (user_id, canonical_profile_uri) WHERE canonical_profile_uri IS NOT NULL`
 * enforces at most one candidate per user per external-profile URI across all
 * statuses.  `createCanonical` wraps a Postgres function that atomically
 * creates the candidate row and its founding evidence join row; concurrent
 * callers for the same URI converge on a single candidate via the conflict
 * target in that function.
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

/** Subset of candidate columns returned by canonical-URI lookups. */
export interface CandidateSummary {
  readonly id: string;
  readonly status: string;
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

  /**
   * Returns the existing candidate for the given `(userId, canonicalUri)` pair,
   * or `null` if no such candidate exists.
   *
   * The partial unique index `discovery_candidates_canonical_uri_key` ensures
   * at most one row matches; the query uses `.limit(1)` for defence in depth.
   *
   * Throws `DiscoveryCandidateStoreError` on any genuine database error.
   */
  async findByCanonicalUri(userId: string, canonicalUri: string): Promise<CandidateSummary | null> {
    const { data, error } = await this.db
      .from("discovery_candidates")
      .select("id, status")
      .eq("user_id", userId)
      .eq("canonical_profile_uri", canonicalUri)
      .limit(1);

    if (error) throw new DiscoveryCandidateStoreError("findByCanonicalUri");
    if (!data || data.length === 0) return null;
    const row = data.at(0);
    if (!row) return null;
    return { id: row.id, status: row.status };
  }

  /**
   * Atomically creates a canonical candidate and records the founding evidence
   * in `discovery_candidate_evidence`.
   *
   * Delegates to the `create_canonical_candidate` Postgres function which
   * runs both inserts in a single transaction.  Concurrent callers for the
   * same `(userId, canonicalProfileUri)` converge on exactly one candidate via
   * `ON CONFLICT DO NOTHING` inside the function; the returned UUID is the
   * winning candidate's id regardless of which caller created it.
   *
   * @param userId             Authenticated user id.
   * @param evidenceId         Pre-generated, already-written evidence UUID.
   * @param canonicalProfileUri Atlas-normalised canonical profile URI.
   * @returns The candidate id (new or existing winner).
   *
   * Throws `DiscoveryCandidateStoreError` on any genuine database error.
   */
  async createCanonical(
    userId: string,
    evidenceId: string,
    canonicalProfileUri: string,
  ): Promise<string> {
    const candidateId = randomUUID();

    const { data, error } = await this.db.rpc("create_canonical_candidate", {
      p_user_id: userId,
      p_candidate_id: candidateId,
      p_evidence_id: evidenceId,
      p_canonical_profile_uri: canonicalProfileUri,
    });

    if (error) throw new DiscoveryCandidateStoreError("createCanonical");
    if (typeof data !== "string") {
      throw new DiscoveryCandidateStoreError("createCanonical_result");
    }
    return data;
  }

  /**
   * Transitions a `dismissed` candidate back to `pending` status when new
   * credible evidence resolves to its canonical URI.
   *
   * The transition is unconditional on the current status; callers must
   * verify that the candidate is `dismissed` before calling (the canonical
   * resolver does this via `findByCanonicalUri`).
   *
   * Throws `DiscoveryCandidateStoreError` on any genuine database error.
   */
  async transitionDismissedToPending(userId: string, candidateId: string): Promise<void> {
    const { error } = await this.db
      .from("discovery_candidates")
      .update({ status: "pending" })
      .eq("user_id", userId)
      .eq("id", candidateId)
      .eq("status", "dismissed");

    if (error) throw new DiscoveryCandidateStoreError("transitionDismissedToPending");
  }
}
