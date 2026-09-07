/**
 * View models for candidate adjudication (ATL-211).
 *
 * These types mirror the repository-layer types but are explicitly safe for
 * serialisation across the RSC boundary — no Date objects, no Buffers, only
 * plain JSON-compatible values.
 */

/**
 * One candidate surfaced for user review.
 *
 * Populated server-side from discovery_candidates joined with discovery_evidence.
 * Never carries raw evidence JSON, account identifiers, or user/candidate ids in
 * error paths (ADR-008 §8).
 */
export interface CandidateReviewItem {
  /** discovery_candidates.id */
  readonly id: string;
  /** Provider-normalised source key. Shown as the service name on the card. */
  readonly sourceIdentifier: string;
  /** Evidence classification (e.g. 'breach', 'public_record'). */
  readonly evidenceType: string;
  /** Human-readable summary of the evidence. */
  readonly evidenceSummary: string;
  /** Provider class that produced this evidence. */
  readonly providerClass: string;
  /**
   * Persisted adjudication status.
   *
   * Only `pending`, `dismissed`, and `not_sure` candidates are returned by
   * `listForReview` (ATL-211). `confirmed` and `rejected` are excluded.
   */
  readonly status: "pending" | "dismissed" | "not_sure";
}

/**
 * Aggregator-attributed evidence row shown without action buttons (ATL-211).
 *
 * Informational only — no candidate row exists, so no adjudication action is
 * available for these findings. The user sees them as context.
 */
export interface AggregatorEvidenceItem {
  /** discovery_evidence.id */
  readonly id: string;
  readonly sourceIdentifier: string;
  readonly evidenceType: string;
  readonly evidenceSummary: string;
  readonly providerClass: string;
  readonly createdAt: string;
}

/**
 * The client-side outcome of a candidate adjudication action.
 *
 * - `idle`      No action has been taken yet (initial state).
 * - `confirmed` Candidate confirmed; an asset was created.
 * - `rejected`  Candidate rejected; removal fingerprint recorded.
 * - `dismissed` Candidate deferred to the Deferred section.
 * - `not_sure`  Candidate marked uncertain; stays in Not sure section.
 */
export type AdjudicationOutcome = "idle" | "confirmed" | "rejected" | "dismissed" | "not_sure";

/**
 * Return type shared by all four candidate adjudication Server Actions.
 *
 * `failure` is null on success. On failure, the value describes the reason:
 * - `not_found`: the candidate does not exist or does not belong to this user.
 * - `not_pending`: the action requires a pending candidate; it is in another state.
 * - `unavailable`: a downstream error occurred (details withheld per ADR-008 §8).
 *
 * `outcome` is `"idle"` until an action succeeds, then records what succeeded.
 * `assetId` is non-null only after a successful `confirm`.
 */
export interface AdjudicationActionState {
  readonly failure: "not_found" | "not_pending" | "unavailable" | null;
  readonly attempt: number;
  readonly outcome: AdjudicationOutcome;
  readonly assetId: string | null;
}

export const INITIAL_ADJUDICATION_ACTION_STATE: AdjudicationActionState = {
  failure: null,
  attempt: 0,
  outcome: "idle",
  assetId: null,
};
