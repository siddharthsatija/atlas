import { Badge } from "@/components/ui/badge";
import {
  DEMO_SCORE_LABEL,
  HISTORY_EXPLANATION,
  HISTORY_WITHOUT_CURRENT_SCORE,
  VERSION_EXPLANATION,
} from "@/lib/score/score-copy";
import type { ScoreHistoryEntry } from "@/lib/score/score-history";

/**
 * Past recorded scores (ATL-046, frontend §12's "change history").
 *
 * A dated list, not a chart — ATL-047 owns the visualisation, and shipping a
 * chart here would mean building it twice.
 *
 * ## Every row names its own model
 *
 * ADR-004: historical snapshots are never recomputed, and the migration
 * withholds `update` from every role so they cannot be. An entry recorded under
 * an earlier version was produced by different constants, so showing the numbers
 * without their versions would present two different measurements as one series.
 *
 * ## What the gaps mean
 *
 * Snapshots are written only when the score changes, so this is a list of
 * changes rather than a time series — a month with no entry is a month where
 * nothing moved, not missing data. Beyond 90 days compaction keeps one entry per
 * day. Both are stated rather than left for the reader to infer from uneven
 * spacing.
 *
 * ## When there is no current score
 *
 * A user who was scored and then removed every service still has history, and
 * ATL-045 writes no marker to close it off. The heading says plainly that these
 * are past scores and not the current one — otherwise the most recent number
 * reads as today's.
 */

export interface ScoreHistoryProps {
  entries: ScoreHistoryEntry[];
  /** True when there is no current score, so the list must not imply one. */
  withoutCurrentScore: boolean;
}

/** Stable, locale-independent formatting — the server and client must agree. */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function ScoreHistory({ entries, withoutCurrentScore }: ScoreHistoryProps) {
  return (
    <section aria-labelledby="score-history-heading" className="flex flex-col gap-3">
      <h2 id="score-history-heading" className="text-heading-md text-text-primary">
        Recorded scores
      </h2>

      {withoutCurrentScore && entries.length > 0 && (
        <p data-slot="history-not-current" className="text-body-sm text-text-secondary">
          {HISTORY_WITHOUT_CURRENT_SCORE}
        </p>
      )}

      {entries.length === 0 ? (
        <p data-slot="history-empty" className="text-body-sm text-text-muted">
          No scores have been recorded yet.
        </p>
      ) : (
        <>
          <ol data-slot="score-history" className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                data-slot="history-entry"
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-control border border-border-default p-3 text-body-sm"
              >
                <span data-slot="history-score" className="font-medium text-text-primary">
                  {entry.score} out of 100
                </span>
                <span className="text-text-secondary">{formatDay(entry.recordedAt)}</span>
                {/*
                  On every row, not only where versions differ: a reader cannot
                  tell that two rows are comparable unless both say so.
                */}
                <span data-slot="history-version" className="text-text-muted">
                  {entry.scoreVersion}
                </span>
                {entry.isDemo && (
                  <Badge tone="accent" data-slot="history-demo-label">
                    {DEMO_SCORE_LABEL}
                  </Badge>
                )}
              </li>
            ))}
          </ol>

          <p data-slot="history-explanation" className="text-body-sm text-text-muted">
            {HISTORY_EXPLANATION}
          </p>
          <p data-slot="history-version-explanation" className="text-body-sm text-text-muted">
            {VERSION_EXPLANATION}
          </p>
        </>
      )}
    </section>
  );
}
