import { describe, expect, it } from "vitest";
import {
  SEVERITIES_BY_URGENCY,
  compareByRecommendation,
  recommendedFindings,
  sortByRecommendation,
  type RankableFinding,
} from "./recommendation";

/**
 * ATL-039 — the recommendation ordering, which the ticket names as its own unit
 * test: "severity, then confidence, then age".
 *
 * The order is a claim about what the user should do next, so each tier is
 * asserted in isolation: a test that only checked the final list could pass with
 * two tiers swapped.
 */

const finding = (overrides: Partial<RankableFinding> = {}): RankableFinding => ({
  id: "f-1",
  severity: "medium",
  confidence: "medium",
  createdAt: "2026-06-01T00:00:00.000Z",
  status: "open",
  ...overrides,
});

const ids = (findings: RankableFinding[]): string[] => findings.map((entry) => entry.id);

describe("severity comes first", () => {
  it("puts the most serious finding at the top", () => {
    const sorted = sortByRecommendation([
      finding({ id: "low", severity: "low" }),
      finding({ id: "critical", severity: "critical" }),
      finding({ id: "medium", severity: "medium" }),
      finding({ id: "high", severity: "high" }),
    ]);

    expect(ids(sorted)).toEqual(["critical", "high", "medium", "low"]);
  });

  it("outranks confidence", () => {
    // A critical finding Atlas is unsure about still matters more than a
    // low-severity one it is certain of.
    const sorted = sortByRecommendation([
      finding({ id: "certain-low", severity: "low", confidence: "high" }),
      finding({ id: "unsure-critical", severity: "critical", confidence: "low" }),
    ]);

    expect(ids(sorted)).toEqual(["unsure-critical", "certain-low"]);
  });
});

describe("confidence breaks a severity tie", () => {
  it("puts the most certain finding first", () => {
    // Atlas should not send someone to act on the thing it is least sure about.
    const sorted = sortByRecommendation([
      finding({ id: "low-conf", confidence: "low" }),
      finding({ id: "high-conf", confidence: "high" }),
      finding({ id: "med-conf", confidence: "medium" }),
    ]);

    expect(ids(sorted)).toEqual(["high-conf", "med-conf", "low-conf"]);
  });

  it("outranks age", () => {
    const sorted = sortByRecommendation([
      finding({ id: "old-unsure", confidence: "low", createdAt: "2020-01-01T00:00:00.000Z" }),
      finding({ id: "new-certain", confidence: "high", createdAt: "2026-08-01T00:00:00.000Z" }),
    ]);

    expect(ids(sorted)).toEqual(["new-certain", "old-unsure"]);
  });
});

describe("age breaks the remaining tie", () => {
  it("puts the longest-unaddressed finding first", () => {
    /**
     * Oldest first. Between two equally serious, equally certain findings, the
     * one sitting longest is the more neglected — a recommendation list is a
     * backlog, not a news feed.
     */
    const sorted = sortByRecommendation([
      finding({ id: "newer", createdAt: "2026-08-01T00:00:00.000Z" }),
      finding({ id: "older", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);

    expect(ids(sorted)).toEqual(["older", "newer"]);
  });
});

describe("the order is total", () => {
  it("falls back to id, so identical findings never reshuffle", () => {
    // Without a final tiebreaker two identical findings could swap between
    // requests, and a list that reorders itself is one nobody trusts.
    const a = finding({ id: "aaa" });
    const b = finding({ id: "bbb" });

    expect(ids(sortByRecommendation([b, a]))).toEqual(["aaa", "bbb"]);
    expect(ids(sortByRecommendation([a, b]))).toEqual(["aaa", "bbb"]);
  });

  it("is stable across repeated sorts", () => {
    const input = [
      finding({ id: "c", severity: "high" }),
      finding({ id: "a", severity: "high" }),
      finding({ id: "b", severity: "low" }),
    ];

    expect(ids(sortByRecommendation(input))).toEqual(ids(sortByRecommendation(input)));
  });

  it("does not sort the caller's array in place", () => {
    const input = [finding({ id: "z", severity: "low" }), finding({ id: "a", severity: "high" })];

    sortByRecommendation(input);

    expect(ids(input)).toEqual(["z", "a"]);
  });

  it("returns zero only for findings that rank identically", () => {
    expect(compareByRecommendation(finding(), finding())).toBe(0);
    expect(compareByRecommendation(finding({ severity: "high" }), finding())).toBeLessThan(0);
  });
});

describe("the Recommended view", () => {
  it("shows what still needs attention", () => {
    const result = recommendedFindings([
      finding({ id: "open", status: "open" }),
      finding({ id: "in-progress", status: "in_progress" }),
    ]);

    expect(ids(result)).toEqual(["in-progress", "open"]);
  });

  it("excludes finished findings, which are not an answer to 'what next'", () => {
    // They remain reachable through frontend §8's All, Resolved and Dismissed
    // views — narrowed here, not hidden.
    const result = recommendedFindings([
      finding({ id: "resolved", status: "resolved" }),
      finding({ id: "dismissed", status: "dismissed" }),
      finding({ id: "open", status: "open" }),
    ]);

    expect(ids(result)).toEqual(["open"]);
  });

  it("keeps a dismissed finding out even though ADR-004 still deducts for it", () => {
    /**
     * Two different questions. The score keeps the deduction until the condition
     * clears; the Recommended view asks what the user should do next, and they
     * have already answered for this one.
     */
    expect(recommendedFindings([finding({ status: "dismissed" })])).toEqual([]);
  });

  it("is empty rather than throwing when there is nothing", () => {
    expect(recommendedFindings([])).toEqual([]);
  });
});

describe("severity ordering is exported for callers building filters", () => {
  it("runs most urgent first", () => {
    expect(SEVERITIES_BY_URGENCY).toEqual(["critical", "high", "medium", "low"]);
  });
});
