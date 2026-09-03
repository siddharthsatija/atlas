import { describe, expect, it } from "vitest";
import {
  DEFAULT_FINDING_CONFIDENCE,
  DEFAULT_FINDING_SOURCE_TYPE,
  DEFAULT_FINDING_STATUS,
  FINDING_CONFIDENCES,
  FINDING_RESOLVERS,
  FINDING_SEVERITIES,
  FINDING_SOURCE_TYPES,
  FINDING_STATUSES,
  FINDING_TYPES,
  OPEN_FINDING_STATUSES,
  isFindingConfidence,
  isFindingResolver,
  isFindingSeverity,
  isFindingSourceType,
  isFindingStatus,
  isFindingType,
  isFindingTypeShape,
  isOpenFinding,
} from "./findings";

/**
 * ATL-038 — the finding vocabularies.
 *
 * These are not cosmetic lists. §11.1's rules write them, ADR-004's factors read
 * them, and the migration constrains them in SQL — so a value added here and not
 * there fails at insert time, and a value that drifts changes what a rule means
 * or what a score deducts.
 */

describe("finding types", () => {
  it("is exactly §11.1's four rule categories", () => {
    /**
     * Pinned rather than derived. §7.5 names the column and enumerates nothing;
     * §11.1's catalog groups its eight rules into these four categories, and the
     * decision to store the category rather than the rule name is what lets a
     * demo-seeded finding — which has no `rule_id` — still have a type.
     */
    expect(FINDING_TYPES.map((entry) => entry.id)).toEqual([
      "hygiene",
      "exposure",
      "permissions",
      "requests",
    ]);
  });

  it("gives every category a label", () => {
    for (const entry of FINDING_TYPES) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("accepts the vocabulary and nothing else", () => {
    expect(isFindingType("hygiene")).toBe(true);
    expect(isFindingType("requests")).toBe(true);

    // Well-shaped but not in the vocabulary — the gap the application closes.
    expect(isFindingTypeShape("stale_review")).toBe(true);
    expect(isFindingType("stale_review")).toBe(false);

    for (const value of ["", "Hygiene", "data exposure", "exposure "]) {
      expect(isFindingType(value)).toBe(false);
    }
  });

  it("keeps every value storable by the migration's shape check", () => {
    for (const entry of FINDING_TYPES) {
      expect(isFindingTypeShape(entry.id)).toBe(true);
    }
  });

  it("has no duplicates", () => {
    const ids = FINDING_TYPES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("severity", () => {
  it("is ordered from least to most serious", () => {
    // ADR-004 deducts 4, 10, 25 and 40 respectively; the order is the scale.
    expect(FINDING_SEVERITIES).toEqual(["low", "medium", "high", "critical"]);
  });

  it("accepts only those four", () => {
    expect(isFindingSeverity("critical")).toBe(true);
    expect(isFindingSeverity("catastrophic")).toBe(false);
    expect(isFindingSeverity("")).toBe(false);
  });
});

describe("status and the open population", () => {
  it("is §11.1's lifecycle", () => {
    expect(FINDING_STATUSES).toEqual(["open", "in_progress", "resolved", "dismissed"]);
  });

  it("counts in_progress as still open", () => {
    /**
     * ADR-004 stops deducting when the condition clears, not when the user
     * starts working on it. Treating `in_progress` as closed would improve a
     * score for intent alone.
     */
    expect(OPEN_FINDING_STATUSES).toEqual(["open", "in_progress"]);
    expect(isOpenFinding("open")).toBe(true);
    expect(isOpenFinding("in_progress")).toBe(true);
  });

  it("counts dismissed as closed for the lifecycle, though ADR-004 keeps deducting", () => {
    /**
     * The asymmetry is deliberate and lives in two places: the lifecycle says a
     * dismissed finding is over, and ADR-004 says its deduction survives until
     * the underlying condition clears. Dismissal is "I have seen this", not
     * "this is no longer true".
     */
    expect(isOpenFinding("dismissed")).toBe(false);
    expect(isOpenFinding("resolved")).toBe(false);
  });

  it("rejects anything else", () => {
    expect(isFindingStatus("snoozed")).toBe(false);
    expect(isOpenFinding("snoozed")).toBe(false);
  });
});

describe("resolvers", () => {
  it("distinguishes the user from the system", () => {
    // §11.1's auto-resolution writes `system`. ADR-004 credits resolutions, so
    // conflating the two would credit a user for a condition that expired.
    expect(FINDING_RESOLVERS).toEqual(["user", "system"]);
    expect(isFindingResolver("system")).toBe(true);
    expect(isFindingResolver("admin")).toBe(false);
  });
});

describe("confidence", () => {
  it("is the same three-value scale as an asset's", () => {
    // §11.1 derives it from source and staleness; it is the same scale
    // `digital_assets.confidence` uses, so the two must not diverge.
    expect(FINDING_CONFIDENCES).toEqual(["low", "medium", "high"]);
    expect(isFindingConfidence("medium")).toBe(true);
    expect(isFindingConfidence("certain")).toBe(false);
  });
});

describe("source types", () => {
  it("mirrors the asset vocabulary, including the documented demo value", () => {
    // §11.1 pins `demo`: those findings are removed with the demo data, and
    // §11.2 forbids demo and real records mixing in one calculation.
    expect(FINDING_SOURCE_TYPES).toEqual(["manual", "demo", "connector", "import", "discovery"]);
    expect(isFindingSourceType("demo")).toBe(true);
    expect(isFindingSourceType("guessed")).toBe(false);
  });
});

describe("defaults", () => {
  it("matches the migration's column defaults", () => {
    // Restating them here means a caller need not, and a drift shows up as a
    // failing test rather than as a surprising row.
    expect(DEFAULT_FINDING_STATUS).toBe("open");
    expect(DEFAULT_FINDING_CONFIDENCE).toBe("medium");
    expect(DEFAULT_FINDING_SOURCE_TYPE).toBe("manual");
  });

  it("uses values that are in their own vocabularies", () => {
    expect(isFindingStatus(DEFAULT_FINDING_STATUS)).toBe(true);
    expect(isFindingConfidence(DEFAULT_FINDING_CONFIDENCE)).toBe(true);
    expect(isFindingSourceType(DEFAULT_FINDING_SOURCE_TYPE)).toBe(true);
  });
});
