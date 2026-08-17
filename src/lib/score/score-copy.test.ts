import { describe, expect, it } from "vitest";
import {
  DEMO_SCORE_LABEL,
  EXCLUDED_FACTOR_VALUE,
  FACTOR_COPY,
  HISTORY_EXPLANATION,
  SCORE_DISCLAIMER,
  VERSION_EXPLANATION,
} from "./score-copy";
import { SCORE_FACTORS } from "./score-config";

/**
 * ATL-046 — the sentences that keep a true number from reading as a false claim.
 *
 * Each assertion here corresponds to something a user could otherwise reasonably
 * conclude and be wrong about. They live in one module precisely so they can be
 * tested once rather than re-asserted in every component that renders them.
 */

describe("every factor is explained", () => {
  it.each(SCORE_FACTORS.map((factor) => factor.id))("covers %s", (id) => {
    expect(FACTOR_COPY[id].counts.length).toBeGreaterThan(0);
  });
});

describe("dismissed findings must not look like progress", () => {
  it("says the number includes dismissed findings", () => {
    /**
     * The deducting population is `open + in_progress + dismissed`. A row
     * labelled "3 open findings" beside a deduction for 4 would let a user
     * conclude that dismissing had helped — which ADR-004 and the OQ-04
     * amendment both forbid.
     */
    const summary = FACTOR_COPY.open_findings.inputSummary({ deductingFindings: 4 });

    expect(summary).toBe("4 findings still affecting your score, including any you dismissed.");
  });

  it("never calls the deducting population 'open findings'", () => {
    const summary = FACTOR_COPY.open_findings.inputSummary({ deductingFindings: 4 });

    expect(summary).not.toMatch(/open findings/i);
  });

  it("states that dismissing does not clear the deduction", () => {
    expect(FACTOR_COPY.open_findings.counts).toMatch(/dismiss/i);
    expect(FACTOR_COPY.open_findings.counts).toMatch(/does not remove/i);
  });
});

describe("only the user's own resolutions earn credit", () => {
  it("says 'you resolved', not 'resolved'", () => {
    const summary = FACTOR_COPY.protective_actions.inputSummary({ resolvedByUser: 2 });

    expect(summary).toBe("2 findings you resolved in the last 180 days.");
  });

  it("says automatic resolutions are not counted", () => {
    expect(FACTOR_COPY.protective_actions.supporting).toBe(
      "Findings that cleared automatically are not counted.",
    );
  });
});

describe("an excluded factor is missing information, not a perfect score", () => {
  it("is a sentence, not a number", () => {
    expect(EXCLUDED_FACTOR_VALUE).toBe("Not enough information");
    expect(EXCLUDED_FACTOR_VALUE).not.toMatch(/\d/);
  });
});

describe("the score does not overclaim", () => {
  it("says it is a guide rather than a guarantee", () => {
    expect(SCORE_DISCLAIMER).toMatch(/guide/i);
    expect(SCORE_DISCLAIMER).toMatch(/not a guarantee/i);
  });

  it("repeats that Atlas does not scan anything", () => {
    // CLAUDE.md: never claim Atlas scans or deletes data.
    expect(SCORE_DISCLAIMER).toMatch(/does not scan/i);
  });
});

describe("history explains its own shape", () => {
  it("says entries appear only on change", () => {
    expect(HISTORY_EXPLANATION).toMatch(/only when it changes/i);
  });

  it("says older entries are compacted", () => {
    expect(HISTORY_EXPLANATION).toMatch(/90 days/);
  });

  it("says scores are never recalculated after the fact", () => {
    expect(VERSION_EXPLANATION).toMatch(/never recalculated/i);
  });
});

describe("demo scores are labelled", () => {
  it("uses the wording frontend §12 names", () => {
    expect(DEMO_SCORE_LABEL).toBe("Demo score");
  });
});

describe("pluralisation", () => {
  it.each([
    [1, "1 finding still affecting your score, including any you dismissed."],
    [0, "0 findings still affecting your score, including any you dismissed."],
    [2, "2 findings still affecting your score, including any you dismissed."],
  ])("reads correctly for %i", (count, expected) => {
    expect(FACTOR_COPY.open_findings.inputSummary({ deductingFindings: count })).toBe(expected);
  });
});
