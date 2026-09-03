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

/**
 * Full candidate detail needed by the adjudication service (ATL-208).
 *
 * `assetId` is null for pending/dismissed/not_sure candidates; non-null for
 * confirmed (and remains non-null after deconfirm — the asset is soft-deleted
 * rather than unlinked so the bidirectional FK is preserved).
 */
export interface CandidateDetail {
  readonly id: string;
  readonly evidenceId: string;
  readonly status: string;
  readonly assetId: string | null;
}

/** Parameters forwarded verbatim to the `confirm_discovery_candidate` RPC (ATL-208). */
export interface ConfirmCandidateParams {
  assetId: string;
  serviceName: string;
  category: string;
  serviceDomain: string | null;
  /** Pre-encrypted ciphertext — the service layer encrypts before calling. */
  accountIdentifierEncrypted: string | null;
  sourceLabel: string | null;
  confidence: string;
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
   * Fetches one candidate's adjudication-relevant columns.
   *
   * Returns null when the candidate does not exist or does not belong to the
   * user — indistinguishable (non-oracle pattern, ADR-008 §8).
   *
   * Throws `DiscoveryCandidateStoreError` on any genuine database error.
   */
  async findById(userId: string, candidateId: string): Promise<CandidateDetail | null> {
    const { data, error } = await this.db
      .from("discovery_candidates")
      .select("id, evidence_id, status, asset_id")
      .eq("user_id", userId)
      .eq("id", candidateId)
      .maybeSingle();

    if (error) throw new DiscoveryCandidateStoreError("findById");
    if (!data) return null;
    return {
      id: data.id,
      evidenceId: data.evidence_id,
      status: data.status,
      assetId: data.asset_id ?? null,
    };
  }

  /**
   * Moves a candidate to a new status, optionally requiring a current one.
   *
   * The `expectedStatus` guard is evaluated in SQL rather than in the service —
   * no read-then-write window, and no partial failure if two callers race.
   *
   * Returns true when a row was actually updated; false when nothing matched
   * (candidate not found, not yours, or wrong status).
   *
   * Throws `DiscoveryCandidateStoreError` on any genuine database error.
   */
  async updateStatus(
    userId: string,
    candidateId: string,
    toStatus: string,
    expectedStatus?: string,
  ): Promise<boolean> {
    let builder = this.db
      .from("discovery_candidates")
      .update({ status: toStatus })
      .eq("user_id", userId)
      .eq("id", candidateId);

    if (expectedStatus !== undefined) {
      builder = builder.eq("status", expectedStatus);
    }

    const { data, error } = await builder.select("id");

    if (error) throw new DiscoveryCandidateStoreError("updateStatus");
    return (data ?? []).length > 0;
  }

  /**
   * Atomically confirms a pending candidate and creates its linked digital
   * asset via the `confirm_discovery_candidate` Postgres RPC (ATL-208).
   *
   * Idempotent: if the candidate is already confirmed the RPC returns the
   * existing asset_id without writing anything.
   *
   * Throws `DiscoveryCandidateStoreError` on any database error.
   */
  async confirmViaRpc(
    userId: string,
    candidateId: string,
    params: ConfirmCandidateParams,
  ): Promise<{ assetId: string; alreadyConfirmed: boolean }> {
    const { data, error } = await this.db.rpc("confirm_discovery_candidate", {
      p_user_id: userId,
      p_candidate_id: candidateId,
      p_asset_id: params.assetId,
      p_service_name: params.serviceName,
      p_category: params.category,
      p_service_domain: params.serviceDomain,
      p_account_identifier_encrypted: params.accountIdentifierEncrypted,
      p_source_label: params.sourceLabel,
      p_confidence: params.confidence,
    });

    if (error) throw new DiscoveryCandidateStoreError("confirmViaRpc");
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) throw new DiscoveryCandidateStoreError("confirmViaRpc_result");
    return { assetId: row.asset_id, alreadyConfirmed: row.already_confirmed };
  }

  /**
   * Atomically deconfirms a confirmed candidate via the
   * `deconfirm_discovery_candidate` Postgres RPC (ATL-208).
   *
   * The RPC soft-deletes the linked asset, transitions the candidate to
   * rejected, and inserts the rejection fingerprint — all in one transaction.
   * The fingerprint is computed application-side and passed in as p_fingerprint.
   *
   * Throws `DiscoveryCandidateStoreError` on any database error.
   */
  async deconfirmViaRpc(
    userId: string,
    candidateId: string,
    fingerprint: string,
    providerClass: string,
  ): Promise<void> {
    const { error } = await this.db.rpc("deconfirm_discovery_candidate", {
      p_user_id: userId,
      p_candidate_id: candidateId,
      p_fingerprint: fingerprint,
      p_provider_class: providerClass,
    });

    if (error) throw new DiscoveryCandidateStoreError("deconfirmViaRpc");
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
