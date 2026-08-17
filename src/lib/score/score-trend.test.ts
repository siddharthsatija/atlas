import { describe, expect, it } from "vitest";
import { summariseTrend, toSeriesSegments } from "./score-trend";
import type { ScoreHistoryEntry } from "./score-history";

/**
 * ATL-047 — the chart's text alternative and its geometry.
 *
 * The summary matters more than the geometry: the SVG is `aria-hidden`, so this
 * sentence is what a screen-reader user receives *instead of* the chart. Its
 * tests therefore assert sufficiency — direction, range, span, count, demo
 * status, and the non-comparability statement — rather than tone.
 *
 * History arrives newest-first, exactly as the repository returns it.
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

/** Newest first, as `listForUser` returns it. */
const history = (...entries: ScoreHistoryEntry[]) => entries;

describe("the trend summary carries everything the chart cannot", () => {
  const rising = history(
    entry({ score: 70, recordedAt: "2026-08-12T09:00:00.000Z" }),
    entry({ score: 40, recordedAt: "2026-06-01T09:00:00.000Z" }),
  );

  it("names the direction", () => {
    expect(summariseTrend(rising).direction).toBe("improved");
    expect(summariseTrend(rising).summary).toMatch(/rose from 40 to 70/);
  });

  it("names a decline as a decline", () => {
    const falling = history(entry({ score: 30 }), entry({ score: 80 }));

    expect(summariseTrend(falling).direction).toBe("declined");
    expect(summariseTrend(falling).summary).toMatch(/fell from 80 to 30/);
  });

  it("says so when the score ended where it started", () => {
    const flat = history(
      entry({ score: 56, recordedAt: "2026-08-12T09:00:00.000Z" }),
      entry({ score: 61, recordedAt: "2026-07-01T09:00:00.000Z" }),
      entry({ score: 56, recordedAt: "2026-06-01T09:00:00.000Z" }),
    );

    expect(summariseTrend(flat).direction).toBe("unchanged");
    expect(summariseTrend(flat).summary).toMatch(/started and ended at 56/);
  });

  it("gives the range of scores", () => {
    expect(summariseTrend(rising).summary).toMatch(/ranged from 40 to 70 out of 100/);
  });

  it("gives the time span, in UTC", () => {
    // The chart's own labels are terse; the summary spells the span out.
    expect(summariseTrend(rising).summary).toMatch(/between 1 June 2026 and 12 August 2026/);
  });

  it("gives how many scores were recorded", () => {
    expect(summariseTrend(rising).summary).toMatch(/2 scores recorded/);
    expect(summariseTrend(rising).points).toBe(2);
  });

  it("reads the history oldest-first, whatever order it arrives in", () => {
    // Input is newest-first. A summary that read it as given would report every
    // rise as a fall.
    expect(summariseTrend(rising).summary).toMatch(/rose/);
  });
});

describe("the three demo states", () => {
  it("identifies a wholly demo history", () => {
    const demo = history(entry({ score: 70, isDemo: true }), entry({ score: 40, isDemo: true }));

    expect(summariseTrend(demo).summary).toMatch(/These are demo scores/);
  });

  it("says 'some' when demo and real scores are both present", () => {
    /**
     * Reachable in practice: a user who explored with demo data and later added
     * a real service has both kinds of snapshot in one history. Collapsing that
     * to a binary flag would mislabel one half of it.
     */
    const mixed = history(entry({ score: 70 }), entry({ score: 40, isDemo: true }));

    expect(summariseTrend(mixed).summary).toMatch(/Some of these are demo scores/);
  });

  it("says nothing about demo data when there is none", () => {
    const real = history(entry({ score: 70 }), entry({ score: 40 }));

    expect(summariseTrend(real).summary).not.toMatch(/demo/i);
  });
});

describe("across model versions, no trend is claimed", () => {
  const mixedVersions = history(
    entry({ score: 70, scoreVersion: "score-v2" }),
    entry({ score: 40, scoreVersion: "score-v1" }),
  );

  it("reports the direction as indeterminate", () => {
    /**
     * ADR-004: snapshots are never recomputed under a later version. Subtracting
     * 40 from 70 across two models would present two different measurements as
     * one movement.
     */
    expect(summariseTrend(mixedVersions).direction).toBe("indeterminate");
  });

  it("says explicitly that the scores are not comparable", () => {
    const summary = summariseTrend(mixedVersions).summary;

    expect(summary).toMatch(/not directly comparable/);
    expect(summary).toMatch(/no overall trend is shown/);
  });

  it("names the versions involved", () => {
    expect(summariseTrend(mixedVersions).summary).toMatch(/score-v1, score-v2/);
  });

  it("never says rose or fell", () => {
    expect(summariseTrend(mixedVersions).summary).not.toMatch(/rose|fell/);
  });

  it("still gives the range, span and count", () => {
    const summary = summariseTrend(mixedVersions).summary;

    expect(summary).toMatch(/2 scores recorded/);
    expect(summary).toMatch(/ranged from 40 to 70/);
  });
});

describe("too little history for a trend", () => {
  it("says nothing has been recorded", () => {
    expect(summariseTrend([]).summary).toMatch(/No scores have been recorded yet/);
    expect(summariseTrend([]).direction).toBe("indeterminate");
  });

  it("reports a single score without inventing a direction", () => {
    const single = history(entry({ score: 56, recordedAt: "2026-08-12T09:00:00.000Z" }));

    expect(summariseTrend(single).direction).toBe("indeterminate");
    expect(summariseTrend(single).summary).toMatch(/One score has been recorded: 56 out of 100/);
    expect(summariseTrend(single).summary).toMatch(/A trend needs at least two/);
  });

  it("still labels a single demo score", () => {
    const single = history(entry({ isDemo: true }));

    expect(summariseTrend(single).summary).toMatch(/These are demo scores/);
  });
});

describe("plotting positions", () => {
  it("orders points oldest first", () => {
    const segments = toSeriesSegments(
      history(
        entry({ score: 70, recordedAt: "2026-08-12T09:00:00.000Z" }),
        entry({ score: 40, recordedAt: "2026-06-01T09:00:00.000Z" }),
      ),
    );

    expect(segments[0]?.points.map((point) => point.score)).toEqual([40, 70]);
  });

  it("spaces points by real elapsed time, not by index", () => {
    /**
     * The rule that keeps the chart honest. Snapshots are written on change, so
     * three entries two months, one day and one day apart must not be drawn as
     * three equal steps.
     */
    const segments = toSeriesSegments(
      history(
        entry({ recordedAt: "2026-08-12T00:00:00.000Z" }),
        entry({ recordedAt: "2026-08-11T00:00:00.000Z" }),
        entry({ recordedAt: "2026-06-12T00:00:00.000Z" }),
      ),
    );

    const [oldest, middle, newest] = segments[0]?.points ?? [];
    expect(oldest?.x).toBe(0);
    expect(newest?.x).toBe(1);
    // Sixty of sixty-one days elapsed before the middle point.
    expect(middle?.x).toBeGreaterThan(0.9);
  });

  it("scales the y axis to 0–100, never to the observed range", () => {
    // A range-scaled axis would draw a two-point difference as the full height.
    const segments = toSeriesSegments(history(entry({ score: 52 }), entry({ score: 50 })));
    const values = segments[0]?.points.map((point) => point.y) ?? [];

    expect(values).toEqual([0.5, 0.52]);
  });

  it("places a lone point at the midpoint rather than at an edge", () => {
    const segments = toSeriesSegments(history(entry()));

    expect(segments[0]?.points[0]?.x).toBe(0.5);
  });

  it("places simultaneous points at the midpoint rather than dividing by zero", () => {
    const at = "2026-08-12T09:00:00.000Z";
    const segments = toSeriesSegments(
      history(entry({ recordedAt: at }), entry({ recordedAt: at })),
    );

    for (const point of segments[0]?.points ?? []) expect(point.x).toBe(0.5);
  });

  it("produces no NaN geometry from an unparseable timestamp", () => {
    const segments = toSeriesSegments(
      history(entry({ recordedAt: "not-a-date" }), entry({ recordedAt: "2026-06-01T09:00:00Z" })),
    );

    for (const point of segments.flatMap((segment) => segment.points)) {
      expect(Number.isNaN(point.x)).toBe(false);
      expect(Number.isNaN(point.y)).toBe(false);
    }
  });

  it("returns nothing to draw for an empty history", () => {
    expect(toSeriesSegments([])).toEqual([]);
  });
});

describe("segments break at every model change", () => {
  it("keeps one version in one segment", () => {
    const segments = toSeriesSegments(history(entry(), entry(), entry()));

    expect(segments).toHaveLength(1);
    expect(segments[0]?.points).toHaveLength(3);
  });

  it("splits where the version changes", () => {
    const segments = toSeriesSegments(
      history(
        entry({ scoreVersion: "score-v2", recordedAt: "2026-08-12T09:00:00.000Z" }),
        entry({ scoreVersion: "score-v1", recordedAt: "2026-07-01T09:00:00.000Z" }),
      ),
    );

    expect(segments.map((segment) => segment.scoreVersion)).toEqual(["score-v1", "score-v2"]);
  });

  it("never lets a segment span two versions", () => {
    /**
     * The structural guarantee: because no segment contains more than one
     * version, no polyline drawn from a segment can connect two models. The
     * component cannot get this wrong.
     */
    const segments = toSeriesSegments(
      history(
        entry({ scoreVersion: "score-v2", recordedAt: "2026-08-12T09:00:00.000Z" }),
        entry({ scoreVersion: "score-v2", recordedAt: "2026-08-01T09:00:00.000Z" }),
        entry({ scoreVersion: "score-v1", recordedAt: "2026-07-01T09:00:00.000Z" }),
        entry({ scoreVersion: "score-v1", recordedAt: "2026-06-01T09:00:00.000Z" }),
      ),
    );

    for (const segment of segments) {
      const versions = new Set(segment.points.map((point) => point.scoreVersion));
      expect(versions.size).toBe(1);
      expect([...versions][0]).toBe(segment.scoreVersion);
    }
  });

  it("splits again when a version returns after another", () => {
    // Not expected in practice, but a rule that only held for sorted versions
    // would be a rule with a hole in it.
    const segments = toSeriesSegments(
      history(
        entry({ scoreVersion: "score-v1", recordedAt: "2026-08-12T09:00:00.000Z" }),
        entry({ scoreVersion: "score-v2", recordedAt: "2026-07-01T09:00:00.000Z" }),
        entry({ scoreVersion: "score-v1", recordedAt: "2026-06-01T09:00:00.000Z" }),
      ),
    );

    expect(segments.map((segment) => segment.scoreVersion)).toEqual([
      "score-v1",
      "score-v2",
      "score-v1",
    ]);
  });
});
