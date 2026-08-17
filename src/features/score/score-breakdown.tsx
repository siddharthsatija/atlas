import Link from "next/link";
import {
  EXCLUDED_FACTOR_EXPLANATION,
  EXCLUDED_FACTOR_VALUE,
  FACTOR_COPY,
} from "@/lib/score/score-copy";
import { improvementActionFor } from "@/lib/score/improvement-actions";
import type { ScoreFactorId } from "@/lib/score/score-config";

/**
 * The factor breakdown, coverage, and what to do about each one (ATL-046).
 *
 * Frontend §12 asks for weights, per-factor scores, coverage, contributors and
 * improvement actions. They are one component because they are one table: every
 * row already carries its weight, its value, its inputs and its exclusion, and
 * splitting them across components would mean reading the same array four times
 * and keeping four orders in step.
 *
 * ## An excluded factor shows no number
 *
 * Not 100, not 0, not a dash — the sentence "Not enough information". ADR-004
 * excludes a factor when Atlas has no records for it and renormalises the rest,
 * so the factor has no score at all. Printing any digit would turn missing
 * information into a result, which is the exact confusion the coverage rule
 * exists to prevent.
 *
 * ## Contributors are factor-level
 *
 * The strongest and weakest *included* factors, derived from the same array. No
 * record-level ranking: choosing which of a user's services to name would be a
 * second prioritisation order competing with ATL-039's, and Privacy Insights
 * already answers "what next".
 *
 * ## Values are rounded here and nowhere else
 *
 * `value` and `normalisedWeight` arrive at full precision because ADR-004 rounds
 * once, at the end of the calculation. Rounding for display is presentation; the
 * score above was not computed from these rounded numbers, and the copy never
 * claims the parts sum to the whole.
 */

export interface ScoreFactorView {
  id: ScoreFactorId;
  label: string;
  weight: number;
  normalisedWeight: number;
  value: number | null;
  excluded: boolean;
  inputs: Record<string, number>;
}

export interface ScoreBreakdownProps {
  factors: ScoreFactorView[];
  /** Share of the model's weight that was available, 0–100. */
  coverage: number;
}

/** Strongest and weakest included factors. Null when nothing is included. */
export function contributors(factors: readonly ScoreFactorView[]): {
  strongest: ScoreFactorView | null;
  weakest: ScoreFactorView | null;
} {
  const included = factors.filter(
    (factor): factor is ScoreFactorView & { value: number } =>
      !factor.excluded && factor.value !== null,
  );

  if (included.length === 0) return { strongest: null, weakest: null };

  const sorted = [...included].sort((a, b) => b.value - a.value);
  return { strongest: sorted[0] ?? null, weakest: sorted.at(-1) ?? null };
}

export function ScoreBreakdown({ factors, coverage }: ScoreBreakdownProps) {
  const { strongest, weakest } = contributors(factors);
  const excluded = factors.filter((factor) => factor.excluded);

  return (
    <section aria-labelledby="score-breakdown-heading" className="flex flex-col gap-4">
      <h2 id="score-breakdown-heading" className="text-heading-md text-text-primary">
        How this score is calculated
      </h2>

      <p data-slot="score-coverage" className="text-body-sm text-text-secondary">
        {coverage >= 100
          ? "Every factor had enough information to be included."
          : `${Math.round(coverage)}% of the score's factors had enough information to be included. ${EXCLUDED_FACTOR_EXPLANATION}`}
      </p>

      {(strongest || weakest) && (
        <p data-slot="score-contributors" className="text-body-sm text-text-secondary">
          {strongest && weakest && strongest.id !== weakest.id ? (
            <>
              Your strongest factor is <strong>{strongest.label}</strong>; the one holding your
              score back most is <strong>{weakest.label}</strong>.
            </>
          ) : (
            <>
              Only one factor is included right now:{" "}
              <strong>{(strongest ?? weakest)?.label}</strong>.
            </>
          )}
        </p>
      )}

      <ul data-slot="score-factors" className="flex flex-col gap-4">
        {factors.map((factor) => {
          const copy = FACTOR_COPY[factor.id];
          const action = improvementActionFor(factor.id);

          return (
            <li
              key={factor.id}
              data-slot="score-factor"
              data-factor={factor.id}
              data-excluded={factor.excluded ? "true" : "false"}
              className="flex flex-col gap-1 rounded-control border border-border-default p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-label font-medium text-text-primary">{factor.label}</h3>
                <p data-slot="factor-value" className="text-body-sm text-text-secondary">
                  {factor.excluded || factor.value === null ? (
                    <span data-slot="factor-excluded">{EXCLUDED_FACTOR_VALUE}</span>
                  ) : (
                    <>
                      {Math.round(factor.value)} out of 100
                      <span className="text-text-muted"> · weight {factor.weight}</span>
                    </>
                  )}
                </p>
              </div>

              <p className="text-body-sm text-text-secondary">{copy.counts}</p>

              {factor.excluded ? (
                <p data-slot="factor-excluded-note" className="text-body-sm text-text-muted">
                  {EXCLUDED_FACTOR_EXPLANATION}
                </p>
              ) : (
                <p data-slot="factor-inputs" className="text-body-sm text-text-muted">
                  {copy.inputSummary(factor.inputs)}
                </p>
              )}

              {copy.supporting && (
                <p data-slot="factor-supporting" className="text-body-sm text-text-muted">
                  {copy.supporting}
                </p>
              )}

              <p className="mt-1 text-body-sm">
                <Link
                  href={action.href}
                  data-slot="factor-action"
                  className="text-accent underline underline-offset-2"
                >
                  {action.label}
                </Link>
                <span className="block text-text-muted">{action.description}</span>
              </p>
            </li>
          );
        })}
      </ul>

      {excluded.length > 0 && (
        <p data-slot="score-excluded-summary" className="text-body-sm text-text-muted">
          {excluded.length === 1
            ? `${excluded[0]?.label} is not included, because Atlas has no records for it.`
            : `${excluded.length} factors are not included, because Atlas has no records for them.`}
        </p>
      )}
    </section>
  );
}
