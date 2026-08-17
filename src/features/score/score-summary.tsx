import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import {
  DEMO_SCORE_EXPLANATION,
  DEMO_SCORE_LABEL,
  NOT_YET_SCORED_EXPLANATION,
  NOT_YET_SCORED_TITLE,
} from "@/lib/score/score-copy";
import { describeScoreChange, type ScoreDelta } from "@/lib/score/score-history";

/**
 * The score itself, and what has most recently happened to it (ATL-046).
 *
 * ## Three states, and the number is only in one of them
 *
 * Cold start renders no number at all — not a zero, not a dash. ADR-004 says no
 * score exists until the user has an active or inactive non-demo asset, and any
 * placeholder digit would be read as a score.
 *
 * ## Why the change is dated rather than "this period"
 *
 * Snapshots are written on change, not on a schedule, so there is no period to
 * compare across. What exists is the most recent recorded change, and it has a
 * date — so the sentence names it: "Changed from 52 to 56 on 12 August". The
 * delta is computed in `lib/score/score-history.ts`, which withholds it when
 * there is only one recorded score or when the two carry different model
 * versions.
 *
 * The score is conveyed as a number and a sentence, never by colour alone
 * (frontend §12, §20).
 */

export interface ScoreSummaryProps {
  /** The current score, or null at cold start. */
  score: number | null;
  scoreVersion: string;
  isDemo: boolean;
  delta: ScoreDelta | null;
}

export function ScoreSummary({ score, scoreVersion, isDemo, delta }: ScoreSummaryProps) {
  if (score === null) {
    return (
      <section
        aria-labelledby="score-summary-heading"
        data-slot="score-summary"
        data-state="not-yet-scored"
        className="flex flex-col gap-3 rounded-control border border-border-default p-6"
      >
        <h2 id="score-summary-heading" className="text-heading-md text-text-primary">
          {NOT_YET_SCORED_TITLE}
        </h2>
        <p className="text-body-sm text-text-secondary">{NOT_YET_SCORED_EXPLANATION}</p>
        <div>
          <Button asChild variant="primary">
            <Link href="/assets/new" data-slot="score-add-asset">
              Add a service
            </Link>
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="score-summary-heading"
      data-slot="score-summary"
      data-state={isDemo ? "demo" : "scored"}
      className="flex flex-col gap-3 rounded-control border border-border-default p-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="score-summary-heading" className="text-heading-md text-text-primary">
          Privacy score
        </h2>
        {isDemo && (
          <Badge tone="accent" data-slot="score-demo-label">
            {DEMO_SCORE_LABEL}
          </Badge>
        )}
      </div>

      {/*
        The number and its range together: "56" alone invites the reader to guess
        the scale, and a score out of 100 is not obvious from the digits.
      */}
      <p data-slot="score-value" className="text-display text-text-primary">
        {score}
        <span className="text-body-md text-text-muted"> out of 100</span>
      </p>

      {delta ? (
        <p data-slot="score-change" className="text-body-sm text-text-secondary">
          {describeScoreChange(delta)}
        </p>
      ) : (
        /*
          Silence would read as "no change". Saying nothing is recorded yet is
          the honest alternative, and it is true in both cases the delta is
          withheld: too little history, or two entries from different models.
        */
        <p data-slot="score-no-change" className="text-body-sm text-text-muted">
          No recorded change to compare yet.
        </p>
      )}

      {isDemo && (
        <p data-slot="score-demo-explanation" className="text-body-sm text-text-secondary">
          {DEMO_SCORE_EXPLANATION}
        </p>
      )}

      <p className="text-body-sm text-text-muted">Calculated with {scoreVersion}.</p>
    </section>
  );
}
