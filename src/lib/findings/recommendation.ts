import { FINDING_SEVERITIES, isOpenFinding } from "./findings";
import type { FindingConfidence, FindingSeverity } from "./findings";

/**
 * Recommendation ordering (ATL-039, frontend §8's "Recommended" view).
 *
 * > list supports status/severity filters and recommended ordering (severity,
 * > then confidence, then age).
 *
 * Pure, and deliberately in `lib/` rather than inside the service: ATL-044/045
 * render this list, and an ordering reimplemented in a component is an ordering
 * that will disagree with the one the service tested. The service sorts; the UI
 * imports the same comparator if it ever needs to re-sort a subset.
 *
 * ## What "recommended" means
 *
 * The order in which a person should work through their findings. Severity
 * first, because it is the size of the problem. Confidence second, because
 * Atlas should not send someone to act on the thing it is least sure about.
 * Age third — between two equally serious, equally certain findings, the one
 * that has been sitting longest is the more neglected.
 *
 * `id` is the final tiebreaker. Not meaningful to a user, but it makes the order
 * total: without it two identical findings could swap places between requests,
 * and a list that reshuffles itself is one nobody trusts.
 */

/** The minimum a comparator needs. Both the record and any projection satisfy it. */
export interface RankableFinding {
  id: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  createdAt: string;
  status: string;
}

/** Most serious first, so a higher rank sorts earlier. */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/** Most certain first, matching §11.1's three-value scale. */
const CONFIDENCE_RANK: Record<FindingConfidence, number> = { high: 2, medium: 1, low: 0 };

/**
 * The comparator, exported so a caller can sort a projection without copying the
 * rule. Returns a negative number when `a` should be shown first.
 */
export function compareByRecommendation(a: RankableFinding, b: RankableFinding): number {
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) return bySeverity;

  const byConfidence = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
  if (byConfidence !== 0) return byConfidence;

  // Oldest first: the longest-unaddressed finding is the most neglected.
  const byAge = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byAge !== 0) return byAge;

  return a.id.localeCompare(b.id);
}

/** A copy in recommended order. Never sorts in place — callers may hold the input. */
export function sortByRecommendation<T extends RankableFinding>(findings: readonly T[]): T[] {
  return [...findings].sort(compareByRecommendation);
}

/**
 * The "Recommended" view: what still needs attention, most urgent first.
 *
 * Resolved and dismissed findings are excluded because the view answers "what
 * should I do next", and a finished finding is not an answer to that. They
 * remain reachable through the All, Resolved and Dismissed views (frontend §8),
 * so nothing is hidden — only this one question is answered narrowly.
 */
export function recommendedFindings<T extends RankableFinding>(findings: readonly T[]): T[] {
  return sortByRecommendation(findings.filter((finding) => isOpenFinding(finding.status)));
}

/** Severity values ordered as this module ranks them, for callers building filters. */
export const SEVERITIES_BY_URGENCY: readonly FindingSeverity[] = [...FINDING_SEVERITIES].sort(
  (a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a],
);
