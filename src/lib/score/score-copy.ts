/**
 * The words the score explains itself in (ATL-046, frontend §12).
 *
 * In one module because several of these sentences are the *only* thing keeping
 * a true number from reading as a false claim, and three surfaces will render
 * them — the detail view now, ATL-021's card and ATL-047's chart later. Copy
 * duplicated across three components is copy that eventually disagrees.
 *
 * ## The four claims this file exists to prevent
 *
 *  1. **That dismissing a finding helped.** It does not: ADR-004 and the OQ-04
 *     amendment keep a dismissed finding's full deduction until the underlying
 *     condition clears, and `openFindingsFactor` counts `open + in_progress +
 *     dismissed`. So the row is never labelled "open findings" — the number
 *     includes dismissed ones, and the label says so.
 *  2. **That the engine's auto-resolutions earn credit.** They do not:
 *     `protectiveActionsFactor` counts only `resolved_by = 'user'`. The row says
 *     "you resolved", not "resolved".
 *  3. **That an excluded factor scored perfectly.** It has no score at all —
 *     Atlas is missing the records. Excluded rows render this sentence instead
 *     of a number.
 *  4. **That the score is a verdict.** §12 requires a disclaimer that it is a
 *     guide, not a guarantee.
 */

import type { ScoreFactorId } from "./score-config";

/**
 * What each factor counts, in the user's terms.
 *
 * `counts` is the sentence under the factor's name; `inputSummary` turns the
 * stored integer inputs into a phrase. Both are here rather than in the
 * component so a test can assert the wording directly.
 */
export interface FactorCopy {
  counts: string;
  inputSummary: (inputs: Record<string, number>) => string;
  /** An extra clarifying line, where one factor needs it and the others do not. */
  supporting?: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const FACTOR_COPY: Record<ScoreFactorId, FactorCopy> = {
  account_hygiene: {
    counts:
      "How recently you have confirmed what your active services hold, and whether the ones you have finished with are archived or removed.",
    inputSummary: (inputs) =>
      `${inputs.activeReviewed ?? 0} of ${plural(inputs.activeAssets ?? 0, "active service", "active services")} reviewed in the last 180 days` +
      ((inputs.addressableAssets ?? 0) > 0
        ? `; ${inputs.addressed ?? 0} of ${plural(inputs.addressableAssets ?? 0, "finished-with service", "finished-with services")} archived or removed`
        : ""),
  },
  open_findings: {
    /**
     * Never "open findings". The deducting population is `open + in_progress +
     * dismissed`, and a user who dismissed three findings and saw a number
     * labelled "open" would reasonably conclude dismissing had helped.
     */
    counts:
      "Findings that still count against your score. Dismissing a finding does not remove its deduction — that only clears when the situation behind it actually changes.",
    inputSummary: (inputs) =>
      `${plural(inputs.deductingFindings ?? 0, "finding", "findings")} still affecting your score, including any you dismissed.`,
  },
  data_sensitivity: {
    counts:
      "How much sensitive information — financial, health, biometric or location — your active services hold.",
    inputSummary: (inputs) =>
      `${plural(inputs.sensitivePairs ?? 0, "sensitive record", "sensitive records")} across your active services`,
  },
  permission_exposure: {
    counts: "How many of the permissions you have recorded are broad and still active.",
    inputSummary: (inputs) =>
      `${inputs.broadActive ?? 0} of ${plural(inputs.recordedPermissions ?? 0, "recorded permission", "recorded permissions")} are broad and active`,
  },
  protective_actions: {
    /**
     * "You resolved", never "resolved". The engine auto-resolves whenever a
     * predicate stops holding, including through ordinary decay, and that earns
     * nothing here.
     */
    counts: "Credit for findings you resolved yourself in the last 180 days.",
    inputSummary: (inputs) =>
      `${plural(inputs.resolvedByUser ?? 0, "finding", "findings")} you resolved in the last 180 days.`,
    /**
     * Carried separately from `counts` so the component can render it as its own
     * line and a test can assert it independently. It is the sentence that stops
     * the number reading as "resolutions", which would silently include the
     * engine's.
     */
    supporting: "Findings that cleared automatically are not counted.",
  },
  verification_freshness: {
    counts:
      "How many of the services you still hold have been confirmed in the last year. Archived and removed services are not counted.",
    inputSummary: (inputs) =>
      `${inputs.verifiedRecently ?? 0} of ${plural(inputs.verifiableAssets ?? 0, "service", "services")} confirmed in the last year`,
  },
};

/**
 * Shown in place of a value for an excluded factor.
 *
 * Deliberately not a number, and deliberately not zero. ADR-004 excludes a
 * factor when Atlas has no records for it and renormalises the rest — a factor
 * with nothing behind it has no score, and printing 100 would turn missing
 * information into a perfect result, which is exactly the false confidence the
 * score-coverage rule exists to prevent.
 */
export const EXCLUDED_FACTOR_VALUE = "Not enough information";

export const EXCLUDED_FACTOR_EXPLANATION =
  "Atlas has no records for this factor, so it is left out and the remaining factors are " +
  "weighted to make up the difference.";

/** §12: "Disclaimer that score is a guide, not a guarantee." */
export const SCORE_DISCLAIMER =
  "This score is a guide to your own records, not a guarantee of your privacy. It reflects only " +
  "what you have told Atlas — Atlas does not scan the internet or your accounts.";

/** Rendered wherever a demo score appears (§12: "throughout the detail view"). */
export const DEMO_SCORE_LABEL = "Demo score";

export const DEMO_SCORE_EXPLANATION =
  "This score is calculated from demo records only. It disappears with the demo data, and your " +
  "real records are never mixed into it.";

/** Cold start (ADR-004, frontend §5.2). */
export const NOT_YET_SCORED_TITLE = "Not yet scored";

export const NOT_YET_SCORED_EXPLANATION =
  "Atlas scores what you have recorded, so there is nothing to score yet. Add a service you use " +
  "and a score will appear.";

/**
 * Shown above history when the user has past scores but no current one.
 *
 * The distinction ATL-045 made necessary: no snapshot is written at cold start
 * and no synthetic marker closes the history, so past scores can outlive the
 * records they described. Presenting the most recent as current would be a
 * number about services that no longer exist.
 */
export const HISTORY_WITHOUT_CURRENT_SCORE =
  "These are scores Atlas recorded in the past. They are not your current score.";

/**
 * What the history is, and what it is not.
 *
 * Two properties a reader would otherwise assume wrongly: entries appear only
 * when the score *changed* (write-on-change), so gaps are stability rather than
 * missing data; and beyond 90 days only one entry per day is kept.
 */
export const HISTORY_EXPLANATION =
  "A score is recorded only when it changes, so gaps mean nothing moved. Entries older than 90 " +
  "days are kept one per day.";

/**
 * Why a historical entry names its model version.
 *
 * ADR-004: historical snapshots are never recomputed. An entry recorded under an
 * earlier version was produced by different constants, so comparing it with
 * today's number would be comparing two different measurements.
 */
export const VERSION_EXPLANATION =
  "Each entry names the model that produced it. Scores are never recalculated after the fact, so " +
  "entries from different models are not directly comparable.";
