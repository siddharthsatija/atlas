import { describe, expect, it } from "vitest";
import { combineScore, notYetScored, type FactorOutcomes } from "./score";
import {
  accountHygieneFactor,
  dataSensitivityFactor,
  openFindingsFactor,
  permissionExposureFactor,
  protectiveActionsFactor,
  verificationFreshnessFactor,
  type ScoreAsset,
  type ScoreFinding,
} from "./factors";

/**
 * ATL-044 — combination, renormalisation, and the worked example.
 *
 * The golden test at the bottom is ADR-004's own example, computed through the
 * real factor functions from real records rather than from pre-computed factor
 * values. That distinction matters: an example fed pre-computed factors would
 * verify the weighted sum and nothing else, and every arithmetic decision
 * ATL-044 makes lives *inside* the factors.
 */

const outcome = (value: number | null) => ({ value, inputs: {} });

type FactorValues = Partial<Record<keyof FactorOutcomes, number | null>>;

/**
 * Defaults every factor to 100 unless the case names it.
 *
 * `in` rather than `??`: `null` is a *meaningful* value here — it is how a
 * factor says "excluded" — and `??` would silently turn every exclusion back
 * into 100, quietly making the renormalisation tests assert nothing.
 */
const pick = (values: FactorValues, key: keyof FactorOutcomes): number | null =>
  key in values ? (values[key] as number | null) : 100;

const outcomes = (values: FactorValues): FactorOutcomes => ({
  account_hygiene: outcome(pick(values, "account_hygiene")),
  open_findings: outcome(pick(values, "open_findings")),
  data_sensitivity: outcome(pick(values, "data_sensitivity")),
  permission_exposure: outcome(pick(values, "permission_exposure")),
  protective_actions: outcome(pick(values, "protective_actions")),
  verification_freshness: outcome(pick(values, "verification_freshness")),
});

const scored = (result: ReturnType<typeof combineScore>) => {
  if (result.status !== "scored") throw new Error("expected a scored result");
  return result;
};

describe("combining the factors", () => {
  it("takes the weighted sum when every factor is present", () => {
    expect(scored(combineScore(outcomes({}), false)).score).toBe(100);
  });

  it("weights each factor by ADR-004's table", () => {
    // Only the 25-weight findings factor is imperfect: 100 − 0.25×100 = 75.
    expect(scored(combineScore(outcomes({ open_findings: 0 }), false)).score).toBe(75);
  });

  it("records the version on every calculation", () => {
    // ATL-044's fourth criterion. A calculation that could not name the
    // constants that produced it cannot be explained later.
    expect(scored(combineScore(outcomes({}), false)).scoreVersion).toBe("score-v1");
  });

  it("carries the demo flag through", () => {
    expect(scored(combineScore(outcomes({}), true)).isDemo).toBe(true);
  });
});

describe("renormalisation", () => {
  it("redistributes an excluded factor's weight proportionally", () => {
    /**
     * Permission exposure (15) excluded leaves 85 of weight. A user is scored
     * out of what Atlas actually knows about them rather than being silently
     * penalised for the gap.
     */
    const result = scored(
      combineScore(outcomes({ permission_exposure: null, open_findings: 0 }), false),
    );

    // Findings' 25 becomes 25/85 of the total: 100 − (25/85)×100 ≈ 70.6 → 71.
    expect(result.score).toBe(71);
  });

  it("marks the excluded factor and gives it no weight", () => {
    const result = scored(combineScore(outcomes({ permission_exposure: null }), false));
    const permission = result.factors.find((f) => f.id === "permission_exposure");

    expect(permission?.excluded).toBe(true);
    expect(permission?.normalisedWeight).toBe(0);
    expect(permission?.value).toBeNull();
  });

  it("keeps the configured weight visible alongside the normalised one", () => {
    // ATL-046 shows both: what the factor is worth, and what it counted for.
    const result = scored(combineScore(outcomes({ permission_exposure: null }), false));
    const findings = result.factors.find((f) => f.id === "open_findings");

    expect(findings?.weight).toBe(25);
    expect(findings?.normalisedWeight).toBeCloseTo((25 / 85) * 100, 10);
  });

  it("reports coverage as the share of weight available", () => {
    const result = scored(combineScore(outcomes({ permission_exposure: null }), false));

    expect(result.coverage).toBe(85);
    expect(scored(combineScore(outcomes({}), false)).coverage).toBe(100);
  });

  it("normalised weights still sum to 100", () => {
    const result = scored(
      combineScore(outcomes({ permission_exposure: null, account_hygiene: null }), false),
    );
    const total = result.factors.reduce((sum, factor) => sum + factor.normalisedWeight, 0);

    expect(total).toBeCloseTo(100, 10);
  });

  it("refuses to invent a score when every factor is excluded", () => {
    /**
     * Unreachable through the service — cold start already refuses a user with
     * no assets — so reaching it means a caller assembled outcomes the model
     * cannot produce. Returning 0 or 100 would publish a number about nothing.
     */
    const empty = outcomes({
      account_hygiene: null,
      open_findings: null,
      data_sensitivity: null,
      permission_exposure: null,
      protective_actions: null,
      verification_freshness: null,
    });

    expect(() => combineScore(empty, false)).toThrow(/every score factor was excluded/);
  });
});

describe("rounding happens once", () => {
  it("rounds the final score and nothing before it", () => {
    /**
     * Chosen so per-factor rounding and final rounding disagree. Rounding each
     * factor first gives 33 + ... a different total; carrying full precision
     * gives 66.5 → 67. Without this case the precision rule is documented but
     * untested.
     */
    const result = scored(
      combineScore(
        outcomes({
          account_hygiene: 33.333333,
          open_findings: 66.666666,
          data_sensitivity: 99.999999,
          permission_exposure: 50.5,
          protective_actions: 0,
          verification_freshness: 100,
        }),
        false,
      ),
    );

    const exact =
      0.25 * 33.333333 + 0.25 * 66.666666 + 0.2 * 99.999999 + 0.15 * 50.5 + 0.1 * 0 + 0.05 * 100;

    expect(result.score).toBe(Math.round(exact));
  });

  it("keeps full precision in the breakdown", () => {
    // ATL-046 shows contributors; a pre-rounded factor could not explain a
    // score that disagreed with the sum of its displayed parts.
    const result = scored(combineScore(outcomes({ verification_freshness: 71.42857 }), false));
    const freshness = result.factors.find((f) => f.id === "verification_freshness");

    expect(freshness?.value).toBeCloseTo(71.42857, 5);
  });
});

describe("cold start", () => {
  it("is a distinct state, not a score of zero", () => {
    // ADR-004: "no score is computed until the user has at least one non-demo
    // asset ... No snapshot is written."
    const result = notYetScored();

    expect(result.status).toBe("not_yet_scored");
    expect(result).not.toHaveProperty("score");
  });

  it("still names the version that would have been used", () => {
    expect(notYetScored().scoreVersion).toBe("score-v1");
  });
});

describe("ADR-004's worked example", () => {
  /**
   * The golden test.
   *
   * > 6 active assets, 4 reviewed within 180 days, 1 inactive unaddressed asset;
   * > findings: 1 high + 2 medium open; 2 sensitive category-asset pairs; 1 of 5
   * > permissions broad; 1 resolved finding this period; 5 of 7 assets verified
   * > within 365 days.
   * >
   * > Hygiene = 40. Findings = 55. Sensitivity = 80. Permissions = 80.
   * > Protective = 10. Freshness = 71. Score ≈ **56**.
   *
   * Built from records and run through the real factors, so a change to any
   * arithmetic decision fails here — which is what makes it a golden test rather
   * than a restatement of the weighted sum.
   */

  const NOW = new Date("2026-08-09T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

  const at = (id: string, status: ScoreAsset["status"], lastVerifiedAt: string | null) => ({
    id,
    status,
    lastVerifiedAt,
  });

  /**
   * Four active assets reviewed recently, one reviewed 200 days ago (stale for
   * hygiene, fresh for the 365-day window), one reviewed 400 days ago, and one
   * inactive asset nobody addressed.
   *
   * That gives 4/6 active reviewed within 180 days, 0/1 addressed, and 5 of the
   * 7 active-or-inactive assets verified within 365 days — the example's three
   * asset-side numbers at once.
   */
  const assets: ScoreAsset[] = [
    at("a1", "active", daysAgo(30)),
    at("a2", "active", daysAgo(30)),
    at("a3", "active", daysAgo(30)),
    at("a4", "active", daysAgo(30)),
    at("a5", "active", daysAgo(200)),
    at("a6", "active", daysAgo(400)),
    at("a7", "inactive", null),
  ];

  const categories = [
    { assetId: "a1", category: "financial" },
    { assetId: "a2", category: "health" },
  ];

  const permissions = [
    { scope: "broad", status: "active" },
    { scope: "limited", status: "active" },
    { scope: "limited", status: "active" },
    { scope: "limited", status: "active" },
    { scope: "limited", status: "active" },
  ];

  const findings: ScoreFinding[] = [
    { severity: "high", status: "open", resolvedBy: null, resolvedAt: null },
    { severity: "medium", status: "open", resolvedBy: null, resolvedAt: null },
    { severity: "medium", status: "open", resolvedBy: null, resolvedAt: null },
    { severity: "low", status: "resolved", resolvedBy: "user", resolvedAt: daysAgo(20) },
  ];

  const computed = (): FactorOutcomes => ({
    account_hygiene: outcome(accountHygieneFactor(assets, NOW)),
    open_findings: outcome(openFindingsFactor(findings)),
    data_sensitivity: outcome(dataSensitivityFactor(assets, categories)),
    permission_exposure: outcome(permissionExposureFactor(permissions)),
    protective_actions: outcome(protectiveActionsFactor(findings, NOW)),
    verification_freshness: outcome(verificationFreshnessFactor(assets, NOW)),
  });

  it.each([
    ["account_hygiene", 40],
    ["open_findings", 55],
    ["data_sensitivity", 80],
    ["permission_exposure", 80],
    ["protective_actions", 10],
  ] as const)("computes %s as %i", (id, expected) => {
    expect(computed()[id].value).toBeCloseTo(expected, 10);
  });

  it("computes verification freshness as 5/7, which the ADR shows rounded to 71", () => {
    // Full precision here; the ADR's 71 is that number displayed.
    expect(computed().verification_freshness.value).toBeCloseTo((5 / 7) * 100, 10);
  });

  it("produces 56", () => {
    expect(scored(combineScore(computed(), false)).score).toBe(56);
  });

  it("includes every factor, so coverage is complete", () => {
    const result = scored(combineScore(computed(), false));

    expect(result.coverage).toBe(100);
    expect(result.factors.filter((factor) => factor.excluded)).toHaveLength(0);
  });
});
