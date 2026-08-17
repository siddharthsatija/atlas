import { describe, expect, it } from "vitest";
import {
  HYGIENE_SPLIT,
  PROTECTIVE_CAP,
  PROTECTIVE_CREDITS,
  SCORE_FACTORS,
  SCORE_VERSION,
  SENSITIVITY_FLOOR,
  SEVERITY_DEDUCTIONS,
  factorWeight,
} from "./score-config";
import { FINDING_SEVERITIES } from "@/lib/findings/findings";

/**
 * ATL-044 — the `score-v1` constants.
 *
 * These assertions exist because ADR-004 makes the constants a *contract*:
 * "changing any constant requires a new version; historical snapshots are never
 * recomputed". A typo here would not fail anywhere else — it would quietly
 * produce a different number under the same version name, which is precisely
 * the situation versioning exists to prevent.
 */

describe("the version", () => {
  it("is score-v1", () => {
    expect(SCORE_VERSION).toBe("score-v1");
  });
});

describe("the weights", () => {
  it("are ADR-004's six, in its order", () => {
    expect(SCORE_FACTORS.map((factor) => factor.id)).toEqual([
      "account_hygiene",
      "open_findings",
      "data_sensitivity",
      "permission_exposure",
      "protective_actions",
      "verification_freshness",
    ]);
  });

  it.each([
    ["account_hygiene", 25],
    ["open_findings", 25],
    ["data_sensitivity", 20],
    ["permission_exposure", 15],
    ["protective_actions", 10],
    ["verification_freshness", 5],
  ] as const)("weights %s at %i", (id, weight) => {
    expect(factorWeight(id)).toBe(weight);
  });

  it("sums to 100", () => {
    // Asserted rather than normalised at runtime: a table that renormalised
    // itself would hide the typo this catches.
    expect(SCORE_FACTORS.reduce((sum, factor) => sum + factor.weight, 0)).toBe(100);
  });
});

describe("the deductions and thresholds", () => {
  it("matches ADR-004's severity deductions", () => {
    expect(SEVERITY_DEDUCTIONS).toEqual({ critical: 40, high: 25, medium: 10, low: 4 });
  });

  it("covers every severity the findings vocabulary can produce", () => {
    /**
     * A severity with no deduction would be scored as `undefined` and poison the
     * sum. The two vocabularies are defined in different modules, so nothing but
     * this test keeps them in step.
     */
    for (const severity of FINDING_SEVERITIES) {
      expect(SEVERITY_DEDUCTIONS[severity]).toBeGreaterThan(0);
    }
  });

  it("splits hygiene 60/40", () => {
    expect(HYGIENE_SPLIT.activeReview).toBe(0.6);
    expect(HYGIENE_SPLIT.inactiveAddressed).toBe(0.4);
    expect(HYGIENE_SPLIT.activeReview + HYGIENE_SPLIT.inactiveAddressed).toBe(1);
  });

  it("floors data sensitivity at 40, not 0", () => {
    // Holding sensitive data is not by itself a failure.
    expect(SENSITIVITY_FLOOR).toBe(40);
  });

  it("credits protective actions at 10 and 20, capped at 100", () => {
    expect(PROTECTIVE_CREDITS.resolvedFinding).toBe(10);
    expect(PROTECTIVE_CREDITS.completedRequest).toBe(20);
    expect(PROTECTIVE_CAP).toBe(100);
  });
});
