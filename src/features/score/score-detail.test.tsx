import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { ScoreBreakdown, contributors, type ScoreFactorView } from "./score-breakdown";
import { ScoreHistory } from "./score-history";
import { ScoreLimitations } from "./score-limitations";
import { ScoreSummary } from "./score-summary";
import type { ScoreHistoryEntry } from "@/lib/score/score-history";

/**
 * ATL-046 — the score detail surfaces.
 *
 * Frontend §12's content list is covered here, but the assertions that matter
 * most are the four things the UI must never imply, each of which is a true
 * number one careless label away from becoming a false claim:
 *
 *   1. that dismissing a finding helped
 *   2. that findings which cleared on their own earned credit
 *   3. that an excluded factor scored perfectly
 *   4. that an older recorded score is comparable with today's
 */

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const factor = (overrides: Partial<ScoreFactorView> = {}): ScoreFactorView => ({
  id: "open_findings",
  label: "Open findings",
  weight: 25,
  normalisedWeight: 25,
  value: 55,
  excluded: false,
  inputs: { deductingFindings: 3 },
  ...overrides,
});

const hygiene = factor({
  id: "account_hygiene",
  label: "Account hygiene",
  value: 40,
  inputs: { activeAssets: 6, activeReviewed: 4, addressableAssets: 1, addressed: 0 },
});

const protective = factor({
  id: "protective_actions",
  label: "Protective actions",
  weight: 10,
  value: 10,
  inputs: { resolvedByUser: 1, completedRequests: 0 },
});

const entry = (overrides: Partial<ScoreHistoryEntry> = {}): ScoreHistoryEntry => ({
  id: crypto.randomUUID(),
  score: 56,
  scoreVersion: "score-v1",
  isDemo: false,
  reason: "asset.updated",
  recordedAt: "2026-08-12T09:00:00.000Z",
  ...overrides,
});

describe("the score summary", () => {
  it("shows the number and its scale", () => {
    render(<ScoreSummary score={56} scoreVersion="score-v1" isDemo={false} delta={null} />);

    expect(screen.getByText(/56/)).toBeInTheDocument();
    expect(screen.getByText(/out of 100/)).toBeInTheDocument();
  });

  it("describes the most recent recorded change by date", () => {
    render(
      <ScoreSummary
        score={56}
        scoreVersion="score-v1"
        isDemo={false}
        delta={{ from: 52, to: 56, change: 4, recordedAt: "2026-08-12T09:00:00.000Z" }}
      />,
    );

    expect(screen.getByText("Changed from 52 to 56 on 12 August")).toBeVisible();
  });

  it("says so plainly when there is no change to compare", () => {
    // Silence would read as "nothing has changed", which is a different claim
    // from "nothing has been recorded to compare against".
    render(<ScoreSummary score={56} scoreVersion="score-v1" isDemo={false} delta={null} />);

    expect(screen.getByText(/No recorded change to compare yet/)).toBeVisible();
  });

  it("shows no number at all before the first score", () => {
    /**
     * Not zero, not a dash. ADR-004: no score exists until the user has an
     * active or inactive non-demo asset, and any placeholder digit reads as one.
     */
    render(<ScoreSummary score={null} scoreVersion="score-v1" isDemo={false} delta={null} />);

    expect(screen.getByText("Not yet scored")).toBeVisible();
    // No scale means no number: the score value is the only thing that renders it.
    expect(screen.queryByText(/out of 100/)).not.toBeInTheDocument();
  });

  it("offers the add-asset action at cold start", () => {
    render(<ScoreSummary score={null} scoreVersion="score-v1" isDemo={false} delta={null} />);

    expect(screen.getByRole("link", { name: /add a service/i })).toHaveAttribute(
      "href",
      "/assets/new",
    );
  });

  it("labels a demo score", () => {
    render(<ScoreSummary score={80} scoreVersion="score-v1" isDemo delta={null} />);

    expect(screen.getByText("Demo score")).toBeVisible();
    expect(screen.getByText(/calculated from demo records only/i)).toBeVisible();
  });

  it("names the model that produced the number", () => {
    render(<ScoreSummary score={56} scoreVersion="score-v1" isDemo={false} delta={null} />);

    expect(screen.getByText(/score-v1/)).toBeInTheDocument();
  });
});

describe("the four things the breakdown must never imply", () => {
  it("says the findings count includes dismissed ones", () => {
    render(<ScoreBreakdown factors={[factor()]} coverage={100} />);

    expect(
      screen.getByText("3 findings still affecting your score, including any you dismissed."),
    ).toBeVisible();
  });

  it("never labels the deducting population 'open findings'", () => {
    render(<ScoreBreakdown factors={[factor()]} coverage={100} />);

    const inputs = screen.getByText(/still affecting your score/);
    expect(inputs.textContent).not.toMatch(/open findings/i);
  });

  it("credits only the findings the user resolved", () => {
    render(<ScoreBreakdown factors={[protective]} coverage={100} />);

    expect(screen.getByText("1 finding you resolved in the last 180 days.")).toBeVisible();
    expect(screen.getByText("Findings that cleared automatically are not counted.")).toBeVisible();
  });

  it("shows an excluded factor as missing information, never as a number", () => {
    const excluded = factor({
      id: "permission_exposure",
      label: "Permission exposure",
      weight: 15,
      normalisedWeight: 0,
      value: null,
      excluded: true,
      inputs: {},
    });

    render(<ScoreBreakdown factors={[excluded]} coverage={85} />);

    expect(screen.getByText("Not enough information")).toBeVisible();
    // The only factor rendered is the excluded one, so no score may appear at
    // all — not 100, not 0, not a dash.
    expect(screen.queryByText(/out of 100/)).not.toBeInTheDocument();
  });
});

describe("coverage and contributors", () => {
  it("states when everything was included", () => {
    render(<ScoreBreakdown factors={[factor(), hygiene]} coverage={100} />);

    expect(screen.getByText(/Every factor had enough information/)).toBeVisible();
  });

  it("reports the share available when a factor was excluded", () => {
    const excluded = factor({ id: "permission_exposure", value: null, excluded: true, inputs: {} });

    render(<ScoreBreakdown factors={[factor(), excluded]} coverage={85} />);

    expect(screen.getByText(/85% of the score's factors/)).toBeVisible();
  });

  it("names the strongest and weakest included factors", () => {
    render(<ScoreBreakdown factors={[factor(), hygiene]} coverage={100} />);

    const sentence = screen.getByText(/strongest factor is/i);
    expect(sentence.textContent).toContain("Open findings");
    expect(sentence.textContent).toContain("Account hygiene");
  });

  it("ranks by value, ignoring excluded factors", () => {
    const excluded = factor({ id: "permission_exposure", value: null, excluded: true, inputs: {} });

    const { strongest, weakest } = contributors([factor(), hygiene, excluded]);

    expect(strongest?.id).toBe("open_findings");
    expect(weakest?.id).toBe("account_hygiene");
  });

  it("has no contributors when nothing is included", () => {
    const excluded = factor({ value: null, excluded: true, inputs: {} });

    expect(contributors([excluded])).toEqual({ strongest: null, weakest: null });
  });
});

describe("improvement actions", () => {
  it("links each factor to a real flow", () => {
    render(<ScoreBreakdown factors={[factor(), hygiene]} coverage={100} />);

    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^\/(assets|insights)/);
    }
  });

  it("offers no request link, because requests do not exist yet", () => {
    render(<ScoreBreakdown factors={[protective]} coverage={100} />);

    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/request/i);
    }
  });
});

describe("the history", () => {
  it("shows each recorded score with its own model version", () => {
    /**
     * ADR-004: snapshots are never recomputed. Without the version on every row,
     * two numbers from different models would read as one series.
     */
    render(
      <ScoreHistory
        entries={[entry({ score: 70, scoreVersion: "score-v2" }), entry({ score: 56 })]}
        withoutCurrentScore={false}
      />,
    );

    expect(screen.getByText("score-v2")).toBeVisible();
    expect(screen.getByText("score-v1")).toBeVisible();
  });

  it("formats dates in UTC so the server and client agree", () => {
    render(
      <ScoreHistory
        entries={[entry({ recordedAt: "2026-08-12T23:59:00.000Z" })]}
        withoutCurrentScore={false}
      />,
    );

    expect(screen.getByText("12 Aug 2026")).toBeVisible();
  });

  it("explains that entries appear only when the score changed", () => {
    render(<ScoreHistory entries={[entry()]} withoutCurrentScore={false} />);

    expect(screen.getByText(/only when it changes/i)).toBeVisible();
  });

  it("says scores are never recalculated after the fact", () => {
    render(<ScoreHistory entries={[entry()]} withoutCurrentScore={false} />);

    expect(screen.getByText(/never recalculated/i)).toBeVisible();
  });

  it("says past scores are not the current one when there is no current score", () => {
    /**
     * The case ATL-045 made possible: a scored user who removed every service
     * keeps their history, and no marker closes it off.
     */
    render(<ScoreHistory entries={[entry()]} withoutCurrentScore />);

    expect(screen.getByText(/not your current score/i)).toBeVisible();
  });

  it("does not claim that when a current score exists", () => {
    render(<ScoreHistory entries={[entry()]} withoutCurrentScore={false} />);

    expect(screen.queryByText(/not your current score/i)).not.toBeInTheDocument();
  });

  it("labels demo entries", () => {
    render(<ScoreHistory entries={[entry({ isDemo: true })]} withoutCurrentScore={false} />);

    expect(screen.getByText("Demo score")).toBeVisible();
  });

  it("says so when nothing has been recorded", () => {
    render(<ScoreHistory entries={[]} withoutCurrentScore={false} />);

    expect(screen.getByText(/No scores have been recorded yet/)).toBeVisible();
  });
});

describe("the disclaimer", () => {
  it("says the score is a guide rather than a guarantee", () => {
    render(<ScoreLimitations />);

    expect(screen.getByText(/guide/)).toBeVisible();
    expect(screen.getByText(/not a guarantee/)).toBeVisible();
  });

  it("repeats that Atlas scans nothing", () => {
    render(<ScoreLimitations />);

    expect(screen.getByText(/does not scan the internet/i)).toBeVisible();
  });
});

describe("accessibility", () => {
  it("has no violations when scored", async () => {
    const { container } = render(
      <>
        <ScoreSummary
          score={56}
          scoreVersion="score-v1"
          isDemo={false}
          delta={{ from: 52, to: 56, change: 4, recordedAt: "2026-08-12T09:00:00.000Z" }}
        />
        <ScoreBreakdown factors={[factor(), hygiene, protective]} coverage={100} />
        <ScoreHistory entries={[entry()]} withoutCurrentScore={false} />
        <ScoreLimitations />
      </>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations at cold start", async () => {
    const { container } = render(
      <>
        <ScoreSummary score={null} scoreVersion="score-v1" isDemo={false} delta={null} />
        <ScoreHistory entries={[]} withoutCurrentScore />
        <ScoreLimitations />
      </>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations in the demo state", async () => {
    const { container } = render(
      <>
        <ScoreSummary score={80} scoreVersion="score-v1" isDemo delta={null} />
        <ScoreBreakdown factors={[factor()]} coverage={100} />
        <ScoreHistory entries={[entry({ isDemo: true })]} withoutCurrentScore={false} />
      </>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });

  it("conveys the score without relying on colour", () => {
    // Frontend §12: charts and indicators include text summaries. The number and
    // its scale are text, so a user who cannot see colour loses nothing.
    render(<ScoreSummary score={56} scoreVersion="score-v1" isDemo={false} delta={null} />);

    expect(screen.getByText(/out of 100/)).toBeVisible();
  });
});
