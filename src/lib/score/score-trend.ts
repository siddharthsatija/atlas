/**
 * The score chart's text alternative and its geometry (ATL-047).
 *
 * Pure, and deliberately the whole of the chart's thinking. The component that
 * follows draws what this module decides, which is what lets both the summary
 * sentence and the plotted positions be tested without a DOM.
 *
 * ## The summary is not a caption — it is the accessible representation
 *
 * The SVG is `aria-hidden`, so assistive technology never reaches it. Frontend
 * §12 and §20 both require a text alternative for charts, and this is it: the
 * sentence must stand on its own, carrying direction, range, time span, how many
 * scores were recorded, demo status, and — when more than one model appears — an
 * explicit statement that the entries are not comparable. A caption that said
 * "your score over time" would leave a screen-reader user with nothing.
 *
 * ## Time is real, and the line breaks at a version change
 *
 * Two rules that come straight from how snapshots are written:
 *
 *  - **Positions come from `recorded_at`**, not from an index. ATL-045 records a
 *    snapshot only when the score changes, so equal spacing would assert that
 *    changes happened at equal intervals. A cluster of same-day entries is
 *    truthful; evenly spaced points would not be.
 *  - **The series is split at every `score_version` change**, so no stroke can
 *    ever connect two models. ADR-004 forbids recomputing historical snapshots,
 *    which means entries from different versions are different measurements —
 *    a line between them would draw a trend that does not exist. Splitting here
 *    rather than in the component makes it structurally impossible to get wrong:
 *    no segment spans a boundary, so no polyline can.
 */

import type { ScoreHistoryEntry } from "./score-history";

/** One plotted observation, in chart space. */
export interface ScorePoint {
  id: string;
  /** 0–1 along the time axis, from the earliest to the latest entry. */
  x: number;
  /** 0–1 up the score axis, from 0 to 100 — never scaled to the data range. */
  y: number;
  score: number;
  scoreVersion: string;
  isDemo: boolean;
  recordedAt: string;
}

/** A run of points sharing one `score_version`, drawable as a single line. */
export interface ScoreSegment {
  scoreVersion: string;
  points: ScorePoint[];
}

/**
 * A single instant, or a single point, has no time range to spread across.
 *
 * Placed at the midpoint rather than at 0 or 1: an edge position would read as
 * "at the start of some period", which is a claim about a period that does not
 * exist here.
 */
const DEGENERATE_X = 0.5;

/**
 * Turns history into drawable segments, oldest first.
 *
 * Input arrives newest-first (the repository's `recorded_at desc` ordering), and
 * a chart reads left to right in time, so it is reversed here — once, in the one
 * place that knows why.
 *
 * The y axis is fixed to 0–100 rather than the observed range. A range-scaled
 * axis would make a two-point movement fill the chart, which for a number the
 * user is being asked to trust would exaggerate every change.
 */
export function toSeriesSegments(history: readonly ScoreHistoryEntry[]): ScoreSegment[] {
  if (history.length === 0) return [];

  const chronological = [...history].reverse();

  const times = chronological.map((entry) => Date.parse(entry.recordedAt));
  const valid = times.filter((time) => !Number.isNaN(time));
  const earliest = valid.length > 0 ? Math.min(...valid) : 0;
  const latest = valid.length > 0 ? Math.max(...valid) : 0;
  const span = latest - earliest;

  const segments: ScoreSegment[] = [];

  for (const [index, entry] of chronological.entries()) {
    const time = times[index] ?? NaN;

    const point: ScorePoint = {
      id: entry.id,
      x: span === 0 || Number.isNaN(time) ? DEGENERATE_X : (time - earliest) / span,
      // Fixed 0–100 scale, clamped: a stored score outside it would be a
      // constraint violation, but a chart is not the place to discover that.
      y: Math.min(1, Math.max(0, entry.score / 100)),
      score: entry.score,
      scoreVersion: entry.scoreVersion,
      isDemo: entry.isDemo,
      recordedAt: entry.recordedAt,
    };

    const current = segments.at(-1);

    // A new segment whenever the model changes — this is the break.
    if (current && current.scoreVersion === entry.scoreVersion) current.points.push(point);
    else segments.push({ scoreVersion: entry.scoreVersion, points: [point] });
  }

  return segments;
}

/** Which way the score moved across the recorded history. */
export type TrendDirection = "improved" | "declined" | "unchanged" | "indeterminate";

export interface ScoreTrend {
  direction: TrendDirection;
  /** The complete sentence a screen reader is given in place of the chart. */
  summary: string;
  /** Distinct model versions present, oldest first. More than one means no trend. */
  versions: string[];
  points: number;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** UTC, so the server and the client render the same string (no hydration gap). */
function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The chart's text alternative.
 *
 * Everything the criterion names, in one sentence group: direction, the range of
 * scores, the span of time, how many were recorded, whether they are demo
 * scores, and a non-comparability statement when more than one model is present.
 *
 * **No direction is claimed across versions.** With two models in view the
 * summary reports the range and the count and says plainly that the entries came
 * from different models — subtracting the oldest from the newest would be
 * comparing two different measurements, which ADR-004 forbids.
 */
export function summariseTrend(history: readonly ScoreHistoryEntry[]): ScoreTrend {
  const chronological = [...history].reverse();
  const points = chronological.length;

  const versions = [...new Set(chronological.map((entry) => entry.scoreVersion))];
  const allDemo = points > 0 && chronological.every((entry) => entry.isDemo);
  const someDemo = chronological.some((entry) => entry.isDemo);

  const demoNote = allDemo
    ? " These are demo scores, calculated from demo records only."
    : someDemo
      ? " Some of these are demo scores, calculated from demo records only."
      : "";

  if (points === 0) {
    return {
      direction: "indeterminate",
      summary: "No scores have been recorded yet, so there is no history to chart.",
      versions,
      points,
    };
  }

  const first = chronological[0] as ScoreHistoryEntry;
  const last = chronological.at(-1) as ScoreHistoryEntry;

  if (points === 1) {
    return {
      direction: "indeterminate",
      summary:
        `One score has been recorded: ${first.score} out of 100 on ${formatDay(first.recordedAt)}. ` +
        `A trend needs at least two.${demoNote}`,
      versions,
      points,
    };
  }

  const scores = chronological.map((entry) => entry.score);
  const lowest = Math.min(...scores);
  const highest = Math.max(...scores);
  const range = `Scores ranged from ${lowest} to ${highest} out of 100`;
  const span = `between ${formatDay(first.recordedAt)} and ${formatDay(last.recordedAt)}`;
  const counted = `${points} scores recorded`;

  if (versions.length > 1) {
    return {
      direction: "indeterminate",
      summary:
        `${counted} ${span}. ${range}. These scores came from more than one version of the ` +
        `model (${versions.join(", ")}), so they are not directly comparable and no overall ` +
        `trend is shown.${demoNote}`,
      versions,
      points,
    };
  }

  const change = last.score - first.score;
  const direction: TrendDirection = change > 0 ? "improved" : change < 0 ? "declined" : "unchanged";

  const movement =
    change === 0
      ? `Your score started and ended at ${first.score} out of 100`
      : `Your score ${direction === "improved" ? "rose" : "fell"} from ${first.score} to ${last.score} out of 100`;

  return {
    direction,
    summary: `${movement} ${span}. ${range}, across ${counted}.${demoNote}`,
    versions,
    points,
  };
}
