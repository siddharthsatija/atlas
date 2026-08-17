import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  describeScoreChange,
  latestScoreChange,
  type ScoreHistoryEntry,
} from "./score-history";

/**
 * ATL-046 — the recorded-change read model.
 *
 * The delta compares the two most recent snapshots rather than "now" against the
 * latest one, because ATL-045 records a snapshot on every change: `current` and
 * `history[0]` are normally the same number, so that subtraction would be an
 * arithmetic identity permanently reading "no change".
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

describe("the most recent recorded change", () => {
  it("compares the two newest entries", () => {
    const delta = latestScoreChange([
      entry({ score: 56, recordedAt: "2026-08-12T09:00:00.000Z" }),
      entry({ score: 52, recordedAt: "2026-08-01T09:00:00.000Z" }),
    ]);

    expect(delta).toMatchObject({ from: 52, to: 56, change: 4 });
  });

  it("reports a decline as a negative change", () => {
    const delta = latestScoreChange([entry({ score: 40 }), entry({ score: 61 })]);

    expect(delta?.change).toBe(-21);
  });

  it("dates the change by the newer entry", () => {
    const delta = latestScoreChange([
      entry({ score: 56, recordedAt: "2026-08-12T09:00:00.000Z" }),
      entry({ score: 52, recordedAt: "2026-08-01T09:00:00.000Z" }),
    ]);

    expect(delta?.recordedAt).toBe("2026-08-12T09:00:00.000Z");
  });

  it("ignores everything older than the two newest", () => {
    // The question is "what changed most recently", not "what changed overall".
    const delta = latestScoreChange([
      entry({ score: 56 }),
      entry({ score: 52 }),
      entry({ score: 10 }),
    ]);

    expect(delta).toMatchObject({ from: 52, to: 56 });
  });
});

describe("when no change can be shown", () => {
  it("shows none for an empty history", () => {
    expect(latestScoreChange([])).toBeNull();
  });

  it("shows none for a single recorded score", () => {
    // One score is not a change.
    expect(latestScoreChange([entry()])).toBeNull();
  });

  it("shows none across model versions", () => {
    /**
     * ADR-004: snapshots are never recomputed under a later version, so two
     * entries from different models are two different measurements. Subtracting
     * them would present that as one movement.
     */
    const delta = latestScoreChange([
      entry({ score: 70, scoreVersion: "score-v2" }),
      entry({ score: 56, scoreVersion: "score-v1" }),
    ]);

    expect(delta).toBeNull();
  });

  it("still compares two entries from the same later version", () => {
    // The guard is about mismatch, not about which version is current.
    const delta = latestScoreChange([
      entry({ score: 70, scoreVersion: "score-v2" }),
      entry({ score: 60, scoreVersion: "score-v2" }),
    ]);

    expect(delta?.change).toBe(10);
  });
});

describe("describing the change", () => {
  it("names both scores and the day", () => {
    expect(
      describeScoreChange({
        from: 52,
        to: 56,
        change: 4,
        recordedAt: "2026-08-12T09:00:00.000Z",
      }),
    ).toBe("Changed from 52 to 56 on 12 August");
  });

  it("does not call it a period", () => {
    // Snapshots are event-driven; "previous period" would imply an interval the
    // persistence layer does not have.
    const sentence = describeScoreChange({
      from: 52,
      to: 56,
      change: 4,
      recordedAt: "2026-08-12T09:00:00.000Z",
    });

    expect(sentence).not.toMatch(/period|week|month/i);
  });

  it("formats in UTC, so the server and client agree", () => {
    /**
     * A locale- or timezone-dependent format would render differently on the
     * server and the client and produce a hydration mismatch. Late-evening UTC
     * is where a local-time formatter would slip to the next day.
     */
    expect(
      describeScoreChange({ from: 1, to: 2, change: 1, recordedAt: "2026-08-12T23:59:00.000Z" }),
    ).toContain("12 August");
  });

  it("falls back to the raw value rather than printing Invalid Date", () => {
    expect(describeScoreChange({ from: 1, to: 2, change: 1, recordedAt: "not-a-date" })).toContain(
      "not-a-date",
    );
  });
});

describe("the history bound", () => {
  it("is 20 — bounded and readable, with no paging in this ticket", () => {
    expect(HISTORY_LIMIT).toBe(20);
  });
});
