import { ChartContainer } from "@/components/ui/chart-container";
import { summariseTrend, toSeriesSegments, type ScoreSegment } from "@/lib/score/score-trend";
import { VERSION_EXPLANATION } from "@/lib/score/score-copy";
import type { ScoreHistoryEntry } from "@/lib/score/score-history";

/**
 * The score history chart (ATL-047, frontend §12, design system §13).
 *
 * Hand-written inline SVG. A server component with no state, no handlers and no
 * client boundary — for one series of at most twenty points, a charting library
 * would add a dependency, a bundle and a hydration step to draw a polyline.
 *
 * ## The graphic is hidden from assistive technology, on purpose
 *
 * `aria-hidden` on the `<svg>`, and the reason is that the same information is
 * already available as text twice over: `ChartContainer` renders the trend
 * summary as the region's description, and ATL-046's history list below gives
 * every entry with its date and model version. Exposing the SVG as well would
 * mean maintaining a second, worse accessibility model for identical data —
 * a graphic that announces "chart" and then a pile of unlabelled points.
 *
 * The summary is therefore not decoration: it is the representation. It carries
 * direction, range, span, count, demo status and the non-comparability
 * statement, and its test asserts it stands alone.
 *
 * ## Nothing here depends on colour
 *
 * Every point gets an explicit circle marker, so observations are locatable by
 * shape rather than by the line's hue (§13: "use accessible patterns, labels, or
 * markers"). Version boundaries are labelled in text under the chart, not
 * signalled by a colour change. The axis is labelled with its units.
 *
 * ## No motion at all
 *
 * No animation, no transition, no transform. ATL-047 requires reduced motion to
 * be respected, and the honest way to respect it is to introduce none — the
 * global `prefers-reduced-motion` rule then has nothing to suppress, and a test
 * asserts the markup contains no animation of any kind.
 */

/** Chart-space geometry. Unitless: the `viewBox` scales it to any width. */
const VIEW = { width: 720, height: 220, padding: { top: 16, right: 16, bottom: 28, left: 36 } };

const PLOT = {
  width: VIEW.width - VIEW.padding.left - VIEW.padding.right,
  height: VIEW.height - VIEW.padding.top - VIEW.padding.bottom,
};

/** Normalised 0–1 chart space to `viewBox` coordinates. y is inverted: SVG grows down. */
const toX = (x: number) => VIEW.padding.left + x * PLOT.width;
const toY = (y: number) => VIEW.padding.top + (1 - y) * PLOT.height;

const GRID_LINES = [0, 50, 100] as const;

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

/** UTC, matching the history list, so the server and client agree. */
function formatShortDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export interface ScoreChartProps {
  entries: ScoreHistoryEntry[];
}

export function ScoreChart({ entries }: ScoreChartProps) {
  const trend = summariseTrend(entries);
  const segments = toSeriesSegments(entries);
  const points = segments.flatMap((segment) => segment.points);

  /**
   * Nothing to draw. The container still renders, so the summary — "No scores
   * have been recorded yet" — is present rather than the section vanishing.
   */
  if (points.length === 0) {
    return (
      <ChartContainer id="score-chart" title="Score over time" summary={trend.summary}>
        <p data-slot="chart-empty" className="text-body-sm text-text-muted">
          A chart will appear once Atlas has recorded more than one score.
        </p>
      </ChartContainer>
    );
  }

  const first = points[0];
  const last = points.at(-1);

  return (
    <ChartContainer id="score-chart" title="Score over time" summary={trend.summary}>
      <svg
        /*
          Hidden from assistive technology: the container's description and the
          history list below already carry this information as text.
        */
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        preserveAspectRatio="xMidYMid meet"
        /*
          `data-testid` rather than `data-slot` on the graphic's internals: the
          SVG is `aria-hidden`, so no semantic query can reach it, and this is
          the case Testing Library's escape hatch exists for. The surrounding
          text keeps `data-slot`, because it is reachable by role and text.
        */
        data-testid="score-chart"
        data-points={points.length}
        data-segments={segments.length}
        className="h-auto w-full"
      >
        {/* Gridlines and the y scale in its units (§13: label axes and units). */}
        {GRID_LINES.map((value) => (
          <g key={value}>
            <line
              x1={VIEW.padding.left}
              x2={VIEW.width - VIEW.padding.right}
              y1={toY(value / 100)}
              y2={toY(value / 100)}
              className="stroke-border-default"
              strokeWidth={1}
            />
            <text
              x={VIEW.padding.left - 8}
              y={toY(value / 100) + 4}
              textAnchor="end"
              className="fill-text-muted text-[12px]"
            >
              {value}
            </text>
          </g>
        ))}

        {/*
          One polyline per segment. A segment never spans a `score_version`
          change — `toSeriesSegments` guarantees it — so no stroke can imply
          that two models are comparable.
        */}
        {segments.map((segment: ScoreSegment, index) => (
          <g key={`${segment.scoreVersion}-${index}`} data-testid="chart-segment">
            {segment.points.length > 1 && (
              <polyline
                data-testid="chart-line"
                fill="none"
                points={segment.points.map((point) => `${toX(point.x)},${toY(point.y)}`).join(" ")}
                className="stroke-accent"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}

            {/*
              A marker for every observation. This is what makes individual
              points identifiable without relying on the line's colour.
            */}
            {segment.points.map((point) => (
              <circle
                key={point.id}
                cx={toX(point.x)}
                cy={toY(point.y)}
                r={4}
                data-testid="chart-point"
                className="stroke-surface-default fill-accent"
                strokeWidth={2}
              />
            ))}
          </g>
        ))}

        {/* Sparse date labels: the first and last only, so 320px stays readable. */}
        {first && (
          <text
            x={VIEW.padding.left}
            y={VIEW.height - 8}
            textAnchor="start"
            className="fill-text-muted text-[12px]"
          >
            {formatShortDay(first.recordedAt)}
          </text>
        )}
        {last && points.length > 1 && (
          <text
            x={VIEW.width - VIEW.padding.right}
            y={VIEW.height - 8}
            textAnchor="end"
            className="fill-text-muted text-[12px]"
          >
            {formatShortDay(last.recordedAt)}
          </text>
        )}
      </svg>

      {/*
        Why the line breaks, in words. A discontinuity nobody explained reads as
        a rendering fault; explained, it is the point being made.
      */}
      {segments.length > 1 && (
        <p data-slot="chart-version-break" className="mt-2 text-body-sm text-text-muted">
          The line breaks where the scoring model changed ({trend.versions.join(" → ")}).{" "}
          {VERSION_EXPLANATION}
        </p>
      )}

      <p data-slot="chart-scale-note" className="mt-2 text-body-sm text-text-muted">
        Scores are plotted from 0 to 100 against the date each was recorded. Exact values and dates
        are listed below.
      </p>
    </ChartContainer>
  );
}
