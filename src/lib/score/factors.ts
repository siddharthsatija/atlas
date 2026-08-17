/**
 * The score factors (ATL-044, ADR-004, architecture §11.2).
 *
 * Pure functions over plain inputs. No database, no ambient clock — `now` is
 * passed in, the same contract the rule catalog uses — which is what lets
 * ADR-004's worked example be written as a literal test rather than a fixture.
 *
 * ## `null` means excluded, not zero
 *
 * A factor returns `null` when ADR-004 excludes it, and the combiner
 * renormalises the remaining weights. A perfect score for having recorded
 * nothing is exactly the false confidence the score-coverage rule exists to
 * prevent.
 *
 * But "no records" does not mean the same thing for every factor, and the
 * edge-case amendment fixes which is which:
 *
 *   - **Zero findings scores 100**, not excluded. Nothing wrong is a result.
 *   - **Zero sensitive pairs scores 100**, for the same reason.
 *   - **No permissions is excluded** — Atlas does not know what any service can
 *     do, which is missing information rather than a clean footprint.
 *   - **Hygiene and freshness are excluded** only when no asset is eligible.
 *
 * ## Nothing here rounds
 *
 * ADR-004's precision rule: full precision is carried through every factor and
 * the weighted sum, and the result is rounded once at the end. A factor
 * returning 71.428… is correct, and rounding it here would make this module
 * quietly decide something the score version owns.
 */

import type { AssetStatus } from "@/lib/assets/asset-fields";
import { isHighSensitivity } from "@/lib/assets/data-categories";
import { isBroadExposure, type ClassifiablePermission } from "@/lib/assets/permissions";
import type { FindingSeverity, FindingStatus } from "@/lib/findings/findings";
import {
  FINDINGS_FLOOR,
  HYGIENE_SPLIT,
  PROTECTIVE_CAP,
  PROTECTIVE_CREDITS,
  PROTECTIVE_WINDOW_DAYS,
  REVIEW_WINDOW_DAYS,
  SENSITIVITY_FLOOR,
  SENSITIVITY_PAIR_DEDUCTION,
  SEVERITY_DEDUCTIONS,
  VERIFICATION_WINDOW_DAYS,
} from "./score-config";

/** The asset fields the score reads. A projection, not the record. */
export interface ScoreAsset {
  id: string;
  status: AssetStatus;
  lastVerifiedAt: string | null;
}

/** One recorded data category, and the asset holding it. */
export interface ScoreDataCategory {
  assetId: string;
  category: string;
}

/** The finding fields the score reads. */
export interface ScoreFinding {
  severity: FindingSeverity;
  status: FindingStatus;
  /**
   * Who closed it, and when. Read only by the protective-actions factor, which
   * credits the user's own resolutions and not the engine's (ADR-004's
   * edge-case amendment).
   */
  resolvedBy: "user" | "system" | null;
  resolvedAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether `timestamp` falls within `days` before `now`. Null is never within. */
function withinDays(timestamp: string | null, now: Date, days: number): boolean {
  if (!timestamp) return false;
  const value = Date.parse(timestamp);
  if (Number.isNaN(value)) return false;
  return now.getTime() - value <= days * DAY_MS;
}

/**
 * Account hygiene (weight 25).
 *
 * Two sub-factors: the share of active assets reviewed within 180 days, and the
 * share of finished-with assets actually addressed.
 *
 * ## The addressed population
 *
 * Numerator `archived + removed`, denominator `inactive + archived + removed`
 * (ADR-004's edge-case amendment). Read the original wording literally —
 * denominator `inactive`, numerator "archived or request started" — and
 * archiving an asset moves it *out* of the denominator rather than into the
 * numerator, so the sub-factor would be permanently 0 with no action able to
 * move it. Addressing an asset has to be able to improve the score.
 *
 * ## Internal renormalisation
 *
 * An absent sub-factor is **never scored as zero**: the surviving one carries
 * the whole factor. Scoring it zero would deduct 40% of hygiene from a user who
 * simply has nothing to tidy up. When both populations exist the documented
 * 60/40 split applies unchanged.
 */
export function accountHygieneFactor(assets: readonly ScoreAsset[], now: Date): number | null {
  const active = assets.filter((asset) => asset.status === "active");
  const addressable = assets.filter(
    (asset) =>
      asset.status === "inactive" || asset.status === "archived" || asset.status === "removed",
  );

  const reviewShare =
    active.length === 0
      ? null
      : active.filter((asset) => withinDays(asset.lastVerifiedAt, now, REVIEW_WINDOW_DAYS)).length /
        active.length;

  const addressedShare =
    addressable.length === 0
      ? null
      : addressable.filter((asset) => asset.status === "archived" || asset.status === "removed")
          .length / addressable.length;

  if (reviewShare === null && addressedShare === null) return null;
  if (addressedShare === null) return (reviewShare as number) * 100;
  if (reviewShare === null) return addressedShare * 100;

  return (
    (HYGIENE_SPLIT.activeReview * reviewShare + HYGIENE_SPLIT.inactiveAddressed * addressedShare) *
    100
  );
}

/**
 * Open findings (weight 25). Never excluded.
 *
 * ## The deduction population
 *
 * `open + in_progress + dismissed`. Resolved findings contribute nothing — the
 * condition is gone. **Dismissed findings keep their full deduction**, which is
 * ADR-004's integrity rule and OQ-04's sign-off expressed as a population
 * rather than as a special case: a dismissal states an intention, and an
 * intention is not a change to the user's exposure.
 *
 * This is deliberately *not* `listOpenForUser`'s population, which is
 * `open + in_progress` and correct for its own purpose.
 *
 * Zero findings scores 100 rather than being excluded: a user with assets and
 * nothing wrong has a real result, and hiding it behind an exclusion would make
 * the best outcome look like missing data.
 */
export function openFindingsFactor(findings: readonly ScoreFinding[]): number {
  const deducting = findings.filter(
    (finding) =>
      finding.status === "open" ||
      finding.status === "in_progress" ||
      finding.status === "dismissed",
  );

  const total = deducting.reduce((sum, finding) => sum + SEVERITY_DEDUCTIONS[finding.severity], 0);

  return Math.max(FINDINGS_FLOOR, 100 - total);
}

/**
 * Data sensitivity footprint (weight 20). Never excluded.
 *
 * −10 per (active asset × high-sensitivity category) pair, floored at 40. The
 * floor is deliberate: holding sensitive data is not by itself a failure, and a
 * user with a large but well-managed footprint should not be driven to the
 * bottom of a factor they cannot fix without deleting their life.
 *
 * Only **active** assets count. A category recorded against an archived service
 * is not current exposure, and counting it would mean archiving never helped.
 *
 * Zero pairs scores 100 rather than being excluded — no sensitive exposure is a
 * result, not an absence.
 */
export function dataSensitivityFactor(
  assets: readonly ScoreAsset[],
  categories: readonly ScoreDataCategory[],
): number {
  const activeIds = new Set(
    assets.filter((asset) => asset.status === "active").map((asset) => asset.id),
  );

  const pairs = categories.filter(
    (entry) => activeIds.has(entry.assetId) && isHighSensitivity(entry.category),
  ).length;

  return Math.max(SENSITIVITY_FLOOR, 100 - SENSITIVITY_PAIR_DEDUCTION * pairs);
}

/**
 * Permission exposure (weight 15). Excluded when nothing is recorded.
 *
 * `100 × (1 − broad active permissions ÷ total recorded permissions)`. The
 * asymmetry is ADR-004's and is easy to get wrong: the numerator counts only
 * *active* broad permissions — revoking one has to improve the score, or the
 * number is useless as feedback — while the denominator counts **every**
 * recorded permission regardless of status.
 *
 * `isBroadExposure` is imported rather than restated, because that predicate is
 * the vocabulary's property and lives with the vocabulary. The division is done
 * here, unrounded: `permissionExposureScore()` in that module rounds, which is
 * right for a caller that wants a displayable number and wrong inside a score
 * that rounds once at the end.
 *
 * Excluded rather than 100 when empty: no permissions recorded means Atlas does
 * not know what any service can do, which is missing information rather than a
 * clean footprint.
 */
export function permissionExposureFactor(
  permissions: readonly ClassifiablePermission[],
): number | null {
  if (permissions.length === 0) return null;

  const broad = permissions.filter(isBroadExposure).length;
  return 100 * (1 - broad / permissions.length);
}

/**
 * Protective actions (weight 10). **Always included**, starting at 0.
 *
 * `+10` per finding the user resolved in the trailing 180 days, `+20` per
 * completed request, capped at 100.
 *
 * ## Only the user's own resolutions
 *
 * ADR-004's "+10 per resolved finding" is elliptical, and its edge-case
 * amendment settles it: `resolved_by = 'user'` only. The engine auto-resolves
 * whenever a predicate stops holding, which happens through ordinary decay as
 * well as through fixes — crediting that would pay a user for doing nothing,
 * and the `resolved_by` split exists to keep the two apart. A condition that
 * clears on its own still improves the score through the open-findings factor;
 * it earns no second, effort-based credit.
 *
 * ## Always included, never excluded
 *
 * Excluding it while empty and including it at 10 after one resolution would
 * let a user's **first** resolution lower their total score, because the factor
 * would enter the weighted average below it. A new user starts at 0 here, which
 * is a true statement about a trailing window in which they have done nothing
 * yet.
 *
 * `completedRequests` is a parameter rather than a hard zero: §7.7 specifies
 * `data_requests` and no migration creates it, so nothing can supply one today.
 * Passing it keeps M8 a call-site change rather than a re-derivation of the
 * factor.
 */
export function protectiveActionsFactor(
  findings: readonly ScoreFinding[],
  now: Date,
  completedRequests = 0,
): number {
  const resolvedByUser = findings.filter(
    (finding) =>
      finding.status === "resolved" &&
      finding.resolvedBy === "user" &&
      withinDays(finding.resolvedAt, now, PROTECTIVE_WINDOW_DAYS),
  ).length;

  const credit =
    resolvedByUser * PROTECTIVE_CREDITS.resolvedFinding +
    completedRequests * PROTECTIVE_CREDITS.completedRequest;

  return Math.min(PROTECTIVE_CAP, credit);
}

/**
 * Verification freshness (weight 5).
 *
 * Share of assets whose `last_verified_at` falls within 365 days. The
 * denominator is `active + inactive` only: Atlas does not ask a user to keep
 * reviewing a service they have archived or removed, so counting those would
 * deduct for not doing something the product never requests.
 *
 * Excluded when no asset is eligible — with nothing to verify there is no share
 * to take, and 0 would report a failure that did not happen.
 */
export function verificationFreshnessFactor(
  assets: readonly ScoreAsset[],
  now: Date,
): number | null {
  const eligible = assets.filter(
    (asset) => asset.status === "active" || asset.status === "inactive",
  );

  if (eligible.length === 0) return null;

  const fresh = eligible.filter((asset) =>
    withinDays(asset.lastVerifiedAt, now, VERIFICATION_WINDOW_DAYS),
  ).length;

  return (fresh / eligible.length) * 100;
}
