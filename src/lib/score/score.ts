/**
 * The score combiner (ATL-044, ADR-004, architecture §11.2).
 *
 * Takes the six factor values and produces the number, the breakdown, and the
 * coverage. Pure: everything that reads a record happens in
 * `PrivacyScoreService`, and everything that decides a factor's value happens in
 * `factors.ts`. This file only combines.
 *
 * ## Renormalisation
 *
 * ADR-004: "a factor with no underlying records is excluded and remaining
 * weights are renormalized." Excluded factors are dropped and the survivors'
 * weights are scaled to sum to 100 again, proportionally — so a user missing the
 * permission factor is scored out of what Atlas actually knows about them,
 * rather than being silently penalised for a gap.
 *
 * The breakdown records both the configured weight and the normalised one, and
 * every exclusion. That is what ATL-046 renders as "score coverage", and
 * ADR-004 is explicit that a high score from thin data must never be mistaken
 * for a complete assessment.
 *
 * ## Rounding happens once, here
 *
 * Factors return full precision and the weighted sum is taken at full
 * precision; the result is rounded exactly once, at the end. Rounding earlier
 * would make two implementations that agree on every constant disagree on the
 * score — and they would both call themselves `score-v1`.
 */

import { SCORE_FACTORS, SCORE_VERSION, type ScoreFactorId } from "./score-config";

/** One factor's contribution, as the breakdown records it. */
export interface ScoreFactorBreakdown {
  id: ScoreFactorId;
  label: string;
  /** The configured weight from `score-v1`, before renormalisation. */
  weight: number;
  /**
   * The weight actually applied after excluded factors were dropped. Equal to
   * `weight` when nothing was excluded; 0 for an excluded factor.
   */
  normalisedWeight: number;
  /** The factor's 0–100 value at full precision, or null when excluded. */
  value: number | null;
  excluded: boolean;
  /**
   * The countable inputs behind the value — "4 of 6 active assets reviewed".
   *
   * ADR-004 requires snapshots to store "factor-level inputs", and ATL-046 has
   * to show exact contributors. Recorded here so ATL-045 can persist the shape
   * unchanged rather than a migration being needed to add it later.
   */
  inputs: Record<string, number>;
}

/** What a calculation produced. ATL-045 persists this without transforming it. */
export type ScoreResult =
  | {
      status: "not_yet_scored";
      /** Cold start: no active or inactive non-demo asset exists yet. */
      reason: "no_assets";
      scoreVersion: string;
    }
  | {
      status: "scored";
      /** 0–100, rounded once. */
      score: number;
      scoreVersion: string;
      /** True when the calculation ran over demo records (ADR-004's demo mode). */
      isDemo: boolean;
      factors: ScoreFactorBreakdown[];
      /**
       * Share of the configured weight that was actually available, 0–100.
       *
       * ADR-004's "score coverage". Reported rather than derived by the UI so
       * every surface says the same thing about how complete an assessment is.
       */
      coverage: number;
    };

/** A factor's computed value and the inputs that produced it. */
export interface FactorOutcome {
  value: number | null;
  inputs: Record<string, number>;
}

export type FactorOutcomes = Record<ScoreFactorId, FactorOutcome>;

/**
 * Combines the six factors into a score.
 *
 * Throws if every factor is excluded rather than returning 0 or 100. That state
 * is unreachable through `PrivacyScoreService` — cold start already refuses to
 * score a user with no assets, and any user with an asset has at least hygiene
 * or freshness — so reaching it means the caller assembled outcomes the model
 * cannot produce, which is a bug and not a user's data.
 */
export function combineScore(outcomes: FactorOutcomes, isDemo: boolean): ScoreResult {
  const factors: ScoreFactorBreakdown[] = SCORE_FACTORS.map((factor) => {
    const outcome = outcomes[factor.id];
    return {
      id: factor.id,
      label: factor.label,
      weight: factor.weight,
      normalisedWeight: 0,
      value: outcome.value,
      excluded: outcome.value === null,
      inputs: outcome.inputs,
    };
  });

  const included = factors.filter((factor) => !factor.excluded);
  const availableWeight = included.reduce((sum, factor) => sum + factor.weight, 0);

  if (availableWeight === 0) {
    throw new Error("every score factor was excluded; the model cannot produce a score");
  }

  const totalWeight = SCORE_FACTORS.reduce((sum, factor) => sum + factor.weight, 0);

  for (const factor of included) {
    // Proportional: a survivor keeps its share of the weight that remains.
    factor.normalisedWeight = (factor.weight / availableWeight) * totalWeight;
  }

  const weighted = included.reduce(
    (sum, factor) => sum + (factor.value as number) * (factor.normalisedWeight / totalWeight),
    0,
  );

  return {
    status: "scored",
    score: Math.round(weighted),
    scoreVersion: SCORE_VERSION,
    isDemo,
    factors,
    coverage: (availableWeight / totalWeight) * 100,
  };
}

/** The cold-start result. No snapshot is written for it (ADR-004). */
export function notYetScored(): ScoreResult {
  return { status: "not_yet_scored", reason: "no_assets", scoreVersion: SCORE_VERSION };
}
