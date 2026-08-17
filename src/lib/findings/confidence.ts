import type { FindingConfidence, FindingSourceType } from "./findings";
import type { ConfidenceInput } from "./rules/types";

/**
 * §11.1's confidence model, as a pure function (ATL-101).
 *
 * > "Confidence is derived, not asserted. Base confidence comes from input
 * > source (`manual` recent = high, `demo` = labeled demo). Staleness degrades
 * > it: inputs older than 180 days cap confidence at medium; older than 365 days
 * > cap it at low. A rule's finding confidence is the minimum across its
 * > inputs."
 *
 * Kept out of the rules themselves on purpose. A rule that returned its own
 * confidence could claim `high` about a record nobody has confirmed in two
 * years; here the rule reports *what it read* and this decides what that is
 * worth. It is also the reason confidence cannot drift between rules — there is
 * one implementation and every rule goes through it.
 */

/** §11.1's staleness thresholds, in days. */
export const CONFIDENCE_MEDIUM_CAP_DAYS = 180;
export const CONFIDENCE_LOW_CAP_DAYS = 365;

const MS_PER_DAY = 86_400_000;

/** Ordered weakest to strongest, so `min` is an index comparison. */
const ORDER: readonly FindingConfidence[] = ["low", "medium", "high"];

const rank = (confidence: FindingConfidence): number => ORDER.indexOf(confidence);

/** The weaker of two confidences. */
export function minConfidence(a: FindingConfidence, b: FindingConfidence): FindingConfidence {
  return rank(a) <= rank(b) ? a : b;
}

/**
 * Base confidence from where a record came.
 *
 * §11.1 names two: `manual` recent is high, and `demo` is "labeled demo".
 * `demo` is treated as **low** rather than given a fourth value — the column
 * only has three, and demo findings are already labelled by `source_type`, which
 * is where the "this is illustrative" signal belongs. Marking them high instead
 * would let a demo dataset produce more confident-looking findings than a user's
 * real records.
 *
 * `connector` and `import` are not named by §11.1. They are treated as `medium`:
 * both are second-hand relative to a user typing something themselves, and
 * neither exists yet, so nothing depends on the choice today. When a connector
 * ticket lands it can raise its own source with evidence rather than inheriting
 * an optimistic default set here.
 */
export function baseConfidence(sourceType: FindingSourceType): FindingConfidence {
  if (sourceType === "manual") return "high";
  if (sourceType === "demo") return "low";
  return "medium";
}

/** Whole days between two instants, floored. Negative ages count as zero. */
export function ageInDays(from: string, now: Date): number {
  const elapsed = now.getTime() - new Date(from).getTime();
  return elapsed <= 0 ? 0 : Math.floor(elapsed / MS_PER_DAY);
}

/**
 * The staleness cap for one input.
 *
 * Age is measured from `lastVerifiedAt` when the record has been confirmed, and
 * from `createdAt` when it never has. A never-verified record is not treated as
 * fresh: the user has said it exists but has not confirmed it since, which is
 * exactly the situation the cap is for.
 *
 * The comparison is `>`, so a record verified exactly 180 days ago is still
 * `high`. §11.1 says "older than 180 days", and a boundary that degraded on the
 * threshold itself would read as 179 days of grace.
 */
export function stalenessCap(input: ConfidenceInput, now: Date): FindingConfidence {
  const age = ageInDays(input.lastVerifiedAt ?? input.createdAt, now);

  if (age > CONFIDENCE_LOW_CAP_DAYS) return "low";
  if (age > CONFIDENCE_MEDIUM_CAP_DAYS) return "medium";
  return "high";
}

/** One input's confidence: its source, capped by its age. */
export function confidenceForInput(input: ConfidenceInput, now: Date): FindingConfidence {
  return minConfidence(baseConfidence(input.sourceType), stalenessCap(input, now));
}

/**
 * A finding's confidence: the minimum across every input the rule read.
 *
 * The minimum, not the average — a conclusion drawn partly from a record nobody
 * has confirmed in a year is only as trustworthy as that record, and averaging
 * would let a pile of fresh inputs hide one stale one.
 *
 * An empty input set returns `low`. A rule that read nothing has demonstrated
 * nothing, and defaulting to `high` would make the least-evidenced findings look
 * the most certain.
 */
export function deriveConfidence(inputs: readonly ConfidenceInput[], now: Date): FindingConfidence {
  if (inputs.length === 0) return "low";

  return inputs.reduce<FindingConfidence>(
    (weakest, input) => minConfidence(weakest, confidenceForInput(input, now)),
    "high",
  );
}
