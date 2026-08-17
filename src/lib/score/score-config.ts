/**
 * `score-v1` configuration (ATL-044, ADR-004, architecture §11.2).
 *
 * Every weight, deduction and threshold the privacy score uses, in one module
 * and nowhere else.
 *
 * ## Why they are all here
 *
 * ADR-004: "weights, deduction values, and thresholds live in a versioned
 * configuration (`score-v1`) ... Changing any constant requires a new version;
 * historical snapshots are never recomputed." A constant inlined in a factor
 * function could be changed without anyone noticing the version had to move,
 * and a snapshot written under `score-v1` would then be uncomparable with
 * another snapshot written under the same name. Collecting them makes that
 * failure a visible diff: a change in this file that does not also change
 * `SCORE_VERSION` is the thing a reviewer is looking for.
 *
 * Each value is quoted from the ADR rather than reasoned about here. This module
 * decides nothing.
 */

import type { FindingSeverity } from "@/lib/findings/findings";

/**
 * The version recorded on every calculation.
 *
 * ATL-044's criterion is "version recorded on every calculation" — not every
 * snapshot, which is ATL-045's. A calculation that could not name the constants
 * that produced it cannot be explained later, which is the whole reason
 * historical snapshots are never recomputed.
 */
export const SCORE_VERSION = "score-v1";

/**
 * The six factors and their weights, in ADR-004's order.
 *
 * The order is the ADR's and is preserved deliberately: ATL-046 renders the
 * breakdown, and a factor list that reordered itself between the document and
 * the UI would make the two harder to check against each other.
 *
 * Weights sum to 100. That is asserted in the tests rather than computed here,
 * because a weight table that silently renormalised itself would hide exactly
 * the typo the assertion catches.
 */
export const SCORE_FACTORS = [
  { id: "account_hygiene", label: "Account hygiene", weight: 25 },
  { id: "open_findings", label: "Open findings", weight: 25 },
  { id: "data_sensitivity", label: "Data sensitivity footprint", weight: 20 },
  { id: "permission_exposure", label: "Permission exposure", weight: 15 },
  { id: "protective_actions", label: "Protective actions", weight: 10 },
  { id: "verification_freshness", label: "Verification freshness", weight: 5 },
] as const;

export type ScoreFactorId = (typeof SCORE_FACTORS)[number]["id"];

const WEIGHTS = new Map<string, number>(SCORE_FACTORS.map((f) => [f.id, f.weight]));

/** The weight for a factor id. Throws for an unknown one — that is a bug, not data. */
export function factorWeight(id: ScoreFactorId): number {
  const weight = WEIGHTS.get(id);
  if (weight === undefined) throw new Error(`unknown score factor: ${id}`);
  return weight;
}

/**
 * Account hygiene's internal split (ADR-004, and its "internal renormalisation"
 * amendment).
 *
 * Applied only when **both** populations exist. When one is empty the other
 * carries the whole factor — an absent sub-factor is never scored as zero,
 * because that would deduct from a user who simply has nothing to tidy up.
 */
export const HYGIENE_SPLIT = {
  /** Share of active assets reviewed within `REVIEW_WINDOW_DAYS`. */
  activeReview: 0.6,
  /** Share of inactive assets addressed — archived or removed. */
  inactiveAddressed: 0.4,
} as const;

/** "Reviewed within 180 days" — account hygiene's active-review sub-factor. */
export const REVIEW_WINDOW_DAYS = 180;

/** "`last_verified_at` within 365 days" — the verification-freshness factor. */
export const VERIFICATION_WINDOW_DAYS = 365;

/**
 * Severity deductions for the open-findings factor.
 *
 * Applied per finding, subtracted from 100, floored at 0. The population is
 * `open + in_progress + dismissed` (ADR-004's edge-case amendment): a dismissed
 * finding keeps its full deduction until the underlying condition clears, which
 * is the OQ-04 rule expressed as a population rather than a special case.
 */
export const SEVERITY_DEDUCTIONS: Record<FindingSeverity, number> = {
  critical: 40,
  high: 25,
  medium: 10,
  low: 4,
};

/** The open-findings factor cannot go below this, however many findings there are. */
export const FINDINGS_FLOOR = 0;

/** Data sensitivity: −10 per (active asset × high-sensitivity category) pair. */
export const SENSITIVITY_PAIR_DEDUCTION = 10;

/**
 * Data sensitivity's floor.
 *
 * Deliberately not 0: holding sensitive data is not by itself a failure, and a
 * user with a large but well-managed footprint should not be driven to the
 * bottom of a factor they cannot fix without deleting their life.
 */
export const SENSITIVITY_FLOOR = 40;

/** Protective actions: credit per action, within the trailing window, capped. */
export const PROTECTIVE_CREDITS = {
  resolvedFinding: 10,
  /**
   * Requests do not exist in the MVP — §7.7 specifies `data_requests` and no
   * migration creates it. The constant is recorded because ADR-004 specifies
   * it and the factor must not be re-derived when M8 lands; nothing can supply
   * a completed request today, so the term contributes nothing.
   */
  completedRequest: 20,
} as const;

export const PROTECTIVE_WINDOW_DAYS = 180;

export const PROTECTIVE_CAP = 100;

/** Every factor is a 0–100 value before weighting. */
export const FACTOR_MIN = 0;
export const FACTOR_MAX = 100;
