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
describe("account_hygiene inputSummary", () => {
  /**
   * The account_hygiene factor has two independent components in its summary:
   * how many active services were reviewed, and — only when the user has
   * finished-with services — how many of those were archived or removed.
   * The second clause must only appear when there is something to say.
   */
  it("includes both clauses when addressableAssets is greater than zero", () => {
    const summary = FACTOR_COPY.account_hygiene.inputSummary({
      activeReviewed: 3,
      activeAssets: 5,
      addressableAssets: 2,
      addressed: 1,
    });

    expect(summary).toBe(
      "3 of 5 active services reviewed in the last 180 days" +
        "; 1 of 2 finished-with services archived or removed",
    );
  });

  it("omits the finished-with clause when addressableAssets is zero", () => {
    const summary = FACTOR_COPY.account_hygiene.inputSummary({
      activeReviewed: 2,
      activeAssets: 4,
      addressableAssets: 0,
      addressed: 0,
    });

    expect(summary).toBe("2 of 4 active services reviewed in the last 180 days");
    expect(summary).not.toMatch(/finished-with/);
  });

  it("uses the singular for a single active service", () => {
    const summary = FACTOR_COPY.account_hygiene.inputSummary({
      activeReviewed: 1,
      activeAssets: 1,
      addressableAssets: 0,
    });

    expect(summary).toContain("1 active service");
    expect(summary).not.toContain("1 active services");
  });

  it("uses the singular for a single finished-with service", () => {
    const summary = FACTOR_COPY.account_hygiene.inputSummary({
      activeReviewed: 0,
      activeAssets: 2,
      addressableAssets: 1,
      addressed: 1,
    });

    expect(summary).toContain("1 finished-with service archived");
    expect(summary).not.toContain("1 finished-with services");
  });

  it("falls back to zero for every missing input", () => {
    /**
     * All inputs are optional. When the caller supplies none — e.g. during
     * cold start before any assets exist — the summary must still be a
     * grammatically complete sentence rather than containing 'undefined'.
     */
    const summary = FACTOR_COPY.account_hygiene.inputSummary({});

    expect(summary).not.toContain("undefined");
    expect(summary).toContain("0 of 0 active services");
    // No finished-with clause: (undefined ?? 0) > 0 is false.
    expect(summary).not.toMatch(/finished-with/);
  });
});

describe("data_sensitivity inputSummary", () => {
  it("reports the number of sensitive records in the plural", () => {
    const summary = FACTOR_COPY.data_sensitivity.inputSummary({ sensitivePairs: 7 });

    expect(summary).toBe("7 sensitive records across your active services");
  });

  it("uses the singular for a single sensitive record", () => {
    const summary = FACTOR_COPY.data_sensitivity.inputSummary({ sensitivePairs: 1 });

    expect(summary).toBe("1 sensitive record across your active services");
    expect(summary).not.toContain("1 sensitive records");
  });

  it("falls back to zero when sensitivePairs is absent", () => {
    const summary = FACTOR_COPY.data_sensitivity.inputSummary({});

    expect(summary).toContain("0 sensitive records");
    expect(summary).not.toContain("undefined");
  });
});

describe("permission_exposure inputSummary", () => {
  it("reports broad active count out of total recorded permissions", () => {
    const summary = FACTOR_COPY.permission_exposure.inputSummary({
      broadActive: 3,
      recordedPermissions: 8,
    });

    expect(summary).toBe("3 of 8 recorded permissions are broad and active");
  });

  it("uses the singular for a single recorded permission", () => {
    const summary = FACTOR_COPY.permission_exposure.inputSummary({
      broadActive: 1,
      recordedPermissions: 1,
    });

    expect(summary).toContain("1 recorded permission");
    expect(summary).not.toContain("1 recorded permissions");
  });

  it("falls back to zero for missing inputs", () => {
    const summary = FACTOR_COPY.permission_exposure.inputSummary({});

    expect(summary).toContain("0 of 0 recorded permissions");
    expect(summary).not.toContain("undefined");
  });
});

describe("verification_freshness inputSummary", () => {
  it("reports verified-recently count out of total verifiable assets", () => {
    const summary = FACTOR_COPY.verification_freshness.inputSummary({
      verifiedRecently: 4,
      verifiableAssets: 6,
    });

    expect(summary).toBe("4 of 6 services confirmed in the last year");
  });

  it("uses the singular for a single verifiable service", () => {
    const summary = FACTOR_COPY.verification_freshness.inputSummary({
      verifiedRecently: 1,
      verifiableAssets: 1,
    });

    expect(summary).toContain("1 of 1 service confirmed");
    expect(summary).not.toContain("1 services");
  });

  it("falls back to zero for missing inputs", () => {
    const summary = FACTOR_COPY.verification_freshness.inputSummary({});

    expect(summary).toContain("0 of 0 services");
    expect(summary).not.toContain("undefined");
  });
});

describe("protective_actions inputSummary pluralisation", () => {
  /**
   * The existing suite already asserts the plural case (resolvedByUser: 2).
   * These cover the singular and the zero / undefined paths that exercise the
   * ?? 0 fallback — both of which are distinct from the plural for the same
   * reason the open_findings pluralisation tests are: a UI that printed
   * "1 findings you resolved" is wrong, and a UI that printed "undefined
   * findings" would be worse.
   */
  it("uses the singular for a single resolved finding", () => {
    const summary = FACTOR_COPY.protective_actions.inputSummary({ resolvedByUser: 1 });

    expect(summary).toBe("1 finding you resolved in the last 180 days.");
    expect(summary).not.toContain("1 findings");
  });

  it("falls back to zero when resolvedByUser is absent", () => {
    const summary = FACTOR_COPY.protective_actions.inputSummary({});

    expect(summary).toBe("0 findings you resolved in the last 180 days.");
    expect(summary).not.toContain("undefined");
  });
});
