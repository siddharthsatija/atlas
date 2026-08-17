import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { ScoreChart } from "./score-chart";
import { summariseTrend } from "@/lib/score/score-trend";
import type { ScoreHistoryEntry } from "@/lib/score/score-history";

/**
 * ATL-047 — the score history chart.
 *
 * The chart's graphic is `aria-hidden`, so most of what is asserted here is
 * about the *text* around it: that the summary is present, complete and
 * sufficient on its own. A chart whose visual is hidden and whose description is
 * thin would be worse than no chart at all.
 *
 * The geometry itself is covered purely in `lib/score/score-trend.test.ts`.
 * What the component owes is that it draws what that module decided — one line
 * per segment, one marker per point — and nothing more.
 */

const entry = (overrides: Partial<ScoreHistoryEntry> = {}): ScoreHistoryEntry => ({
  id: crypto.randomUUID(),
  score: 56,
  scoreVersion: "score-v1",
  isDemo: false,
  reason: "asset.updated",
  recordedAt: "2026-08-12T09:00:00.000Z",
  ...overrides,
});

/** Two real scores, two months apart, newest first. */
const twoScores = [
  entry({ score: 70, recordedAt: "2026-08-12T09:00:00.000Z" }),
  entry({ score: 40, recordedAt: "2026-06-01T09:00:00.000Z" }),
];

/**
 * The graphic is `aria-hidden`, so it is unreachable by role or text — which is
 * exactly the case `data-testid` exists for. `queryByTestId` rather than a
 * container query keeps every lookup going through Testing Library.
 */
const chart = () => screen.queryByTestId("score-chart");

describe("the text alternative", () => {
  it("renders the summary as the region's description", () => {
    /**
     * `aria-describedby` rather than mere adjacency: a sentence sitting near a
     * chart is not connected to it, and the connection is the whole point when
     * the graphic itself is hidden.
     */
    render(<ScoreChart entries={twoScores} />);

    const region = screen.getByRole("region", { name: "Score over time" });
    const summary = screen.getByText(summariseTrend(twoScores).summary);

    // The description the region points at IS the summary element, rather than
    // merely a paragraph that happens to sit beside it.
    expect(region.getAttribute("aria-describedby")).toBe(summary.id);
    expect(summary.id).toBeTruthy();
  });

  it("is sufficient on its own", () => {
    // Direction, range, span and count — everything the hidden graphic shows.
    render(<ScoreChart entries={twoScores} />);

    const summary = screen.getByText(/rose from 40 to 70/);
    expect(summary.textContent).toMatch(/ranged from 40 to 70 out of 100/);
    expect(summary.textContent).toMatch(/between 1 June 2026 and 12 August 2026/);
    expect(summary.textContent).toMatch(/2 scores recorded/);
  });

  it("is visible, not hidden away for screen readers alone", () => {
    // A sentence good enough to replace the chart is worth showing to everyone.
    render(<ScoreChart entries={twoScores} />);

    expect(screen.getByText(/rose from 40 to 70/)).toBeVisible();
  });
});

describe("the graphic", () => {
  it("is hidden from assistive technology", () => {
    /**
     * Deliberate: the summary above and ATL-046's history list below already
     * carry this information as text. Exposing the SVG too would mean a second,
     * worse accessibility model for identical data.
     */
    render(<ScoreChart entries={twoScores} />);

    expect(chart()).toHaveAttribute("aria-hidden", "true");
    expect(chart()).toHaveAttribute("focusable", "false");
  });

  it("draws a marker for every recorded score", () => {
    // Markers, not colour, make individual observations identifiable.
    render(<ScoreChart entries={twoScores} />);

    expect(screen.getAllByTestId("chart-point")).toHaveLength(2);
  });

  it("labels the score axis with its units", () => {
    render(<ScoreChart entries={twoScores} />);

    expect(chart()?.textContent).toContain("100");
    expect(screen.getByText(/plotted from 0 to 100/)).toBeVisible();
  });

  it("scales to its container rather than to a fixed pixel size", () => {
    // What lets it stay readable at 320px without JavaScript.
    render(<ScoreChart entries={twoScores} />);

    expect(chart()).toHaveAttribute("viewBox", expect.stringContaining("0 0"));
    expect(chart()).toHaveClass("w-full");
  });
});

describe("model versions are never connected", () => {
  const acrossVersions = [
    entry({ score: 70, scoreVersion: "score-v2", recordedAt: "2026-08-12T09:00:00.000Z" }),
    entry({ score: 40, scoreVersion: "score-v1", recordedAt: "2026-06-01T09:00:00.000Z" }),
  ];

  it("draws separate segments rather than one line", () => {
    render(<ScoreChart entries={acrossVersions} />);

    expect(screen.getAllByTestId("chart-segment")).toHaveLength(2);
  });

  it("draws no connecting stroke at all when each version has one point", () => {
    /**
     * The sharpest case: two points, two models. A single polyline between them
     * would assert a trend ADR-004 says does not exist.
     */
    render(<ScoreChart entries={acrossVersions} />);

    expect(screen.queryAllByTestId("chart-line")).toHaveLength(0);
  });

  it("explains the break in words", () => {
    // An unexplained discontinuity reads as a rendering fault.
    render(<ScoreChart entries={acrossVersions} />);

    expect(screen.getByText(/line breaks where the scoring model changed/)).toBeVisible();
    expect(screen.getByText(/never recalculated/)).toBeVisible();
  });

  it("claims no trend in the summary either", () => {
    /**
     * Matched on the phrase unique to the summary. "Not directly comparable"
     * appears twice on purpose — once in the summary and once in the standing
     * explanation beneath the chart — so asserting on it alone is ambiguous
     * rather than wrong.
     */
    render(<ScoreChart entries={acrossVersions} />);

    expect(screen.getByText(/no overall trend is shown/)).toBeVisible();
  });

  it("draws one line when every entry shares a version", () => {
    render(<ScoreChart entries={twoScores} />);

    expect(screen.queryAllByTestId("chart-line")).toHaveLength(1);
    expect(screen.queryByText(/line breaks where/)).not.toBeInTheDocument();
  });
});

describe("demo history", () => {
  it("says so when every score is a demo score", () => {
    const demo = twoScores.map((score) => ({ ...score, isDemo: true }));

    render(<ScoreChart entries={demo} />);

    expect(screen.getByText(/These are demo scores/)).toBeVisible();
  });

  it("says 'some' when demo and real scores are mixed", () => {
    const mixed = [twoScores[0] as ScoreHistoryEntry, { ...twoScores[1], isDemo: true }];

    render(<ScoreChart entries={mixed as ScoreHistoryEntry[]} />);

    expect(screen.getByText(/Some of these are demo scores/)).toBeVisible();
  });
});

describe("too little to chart", () => {
  it("says nothing has been recorded rather than disappearing", () => {
    render(<ScoreChart entries={[]} />);

    expect(screen.getByText(/No scores have been recorded yet/)).toBeVisible();
    expect(chart()).toBeNull();
  });

  it("renders a single score without drawing a line", () => {
    render(<ScoreChart entries={[entry()]} />);

    expect(screen.getAllByTestId("chart-point")).toHaveLength(1);
    expect(screen.queryAllByTestId("chart-line")).toHaveLength(0);
    expect(screen.getByText(/A trend needs at least two/)).toBeVisible();
  });
});

describe("no motion is introduced", () => {
  /**
   * ATL-047 requires reduced motion to be respected. The smallest honest way to
   * respect it is to introduce none, so these assert the *absence* of motion
   * rather than the presence of a suppression rule — a chart that animated and
   * then disabled the animation would be motion invented in order to turn it
   * off. The global `prefers-reduced-motion` rule in `globals.css` remains as
   * defence in depth for anything that ever does animate.
   */

  it("contains no SVG animation elements", () => {
    const { container } = render(<ScoreChart entries={twoScores} />);

    expect(container.innerHTML).not.toMatch(/<animate|<animateTransform|<animateMotion|<set\b/);
  });

  it("applies no animation or transition classes", () => {
    const { container } = render(<ScoreChart entries={twoScores} />);

    expect(container.innerHTML).not.toMatch(/\banimate-|\btransition\b|\bduration-/);
  });

  it("sets no inline transition or transform styles", () => {
    const { container } = render(<ScoreChart entries={twoScores} />);

    expect(container.innerHTML).not.toMatch(/transition:|animation:|transform:/);
  });
});

describe("accessibility", () => {
  it("has no violations with a full history", async () => {
    const { container } = render(<ScoreChart entries={twoScores} />);

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations across model versions", async () => {
    const { container } = render(
      <ScoreChart
        entries={[
          entry({ scoreVersion: "score-v2", recordedAt: "2026-08-12T09:00:00.000Z" }),
          entry({ scoreVersion: "score-v1", recordedAt: "2026-06-01T09:00:00.000Z" }),
        ]}
      />,
    );

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations with a single score", async () => {
    const { container } = render(<ScoreChart entries={[entry()]} />);

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations with no history at all", async () => {
    const { container } = render(<ScoreChart entries={[]} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
