import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_LOW_CAP_DAYS,
  CONFIDENCE_MEDIUM_CAP_DAYS,
  ageInDays,
  baseConfidence,
  confidenceForInput,
  deriveConfidence,
  minConfidence,
  stalenessCap,
} from "./confidence";
import type { ConfidenceInput } from "./rules/types";

/**
 * ATL-101 — §11.1's confidence model.
 *
 * The thresholds are not decoration: confidence is shown on every finding card
 * (frontend §8) and is how a user decides whether to act on one. Getting a
 * boundary wrong shifts a whole population of findings by a category.
 */

const NOW = new Date("2026-08-09T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const input = (overrides: Partial<ConfidenceInput> = {}): ConfidenceInput => ({
  sourceType: "manual",
  lastVerifiedAt: daysAgo(1),
  createdAt: daysAgo(1),
  ...overrides,
});

describe("base confidence by source", () => {
  it("trusts what the user typed themselves", () => {
    expect(baseConfidence("manual")).toBe("high");
  });

  it("never lets demo data look more certain than real records", () => {
    // §11.1 calls demo "labeled demo". The column has three values, and the
    // label lives in `source_type`, so demo caps at the lowest.
    expect(baseConfidence("demo")).toBe("low");
  });

  it("treats second-hand sources as medium", () => {
    // Neither exists yet; when a connector lands it can raise its own source
    // with evidence rather than inheriting an optimistic default.
    expect(baseConfidence("connector")).toBe("medium");
    expect(baseConfidence("import")).toBe("medium");
  });
});

describe("staleness caps", () => {
  it("does not degrade on the threshold itself", () => {
    // §11.1 says "older than 180 days". Degrading at exactly 180 would be 179
    // days of grace.
    expect(stalenessCap(input({ lastVerifiedAt: daysAgo(CONFIDENCE_MEDIUM_CAP_DAYS) }), NOW)).toBe(
      "high",
    );
    expect(
      stalenessCap(input({ lastVerifiedAt: daysAgo(CONFIDENCE_MEDIUM_CAP_DAYS + 1) }), NOW),
    ).toBe("medium");
  });

  it("caps at low past a year", () => {
    expect(stalenessCap(input({ lastVerifiedAt: daysAgo(CONFIDENCE_LOW_CAP_DAYS) }), NOW)).toBe(
      "medium",
    );
    expect(stalenessCap(input({ lastVerifiedAt: daysAgo(CONFIDENCE_LOW_CAP_DAYS + 1) }), NOW)).toBe(
      "low",
    );
  });

  it("falls back to creation when a record was never verified", () => {
    // Never verified is not fresh: the user said it exists and has not confirmed
    // it since.
    expect(stalenessCap(input({ lastVerifiedAt: null, createdAt: daysAgo(400) }), NOW)).toBe("low");
  });

  it("treats a future date as age zero rather than negative", () => {
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();

    expect(ageInDays(future, NOW)).toBe(0);
    expect(stalenessCap(input({ lastVerifiedAt: future }), NOW)).toBe("high");
  });
});

describe("combining source and staleness", () => {
  it("takes the weaker of the two", () => {
    // A demo record verified yesterday is still demo; a manual record from two
    // years ago is still old.
    expect(confidenceForInput(input({ sourceType: "demo" }), NOW)).toBe("low");
    expect(confidenceForInput(input({ lastVerifiedAt: daysAgo(400) }), NOW)).toBe("low");
    expect(confidenceForInput(input(), NOW)).toBe("high");
  });

  it("orders the scale correctly", () => {
    expect(minConfidence("high", "medium")).toBe("medium");
    expect(minConfidence("low", "high")).toBe("low");
    expect(minConfidence("medium", "medium")).toBe("medium");
  });
});

describe("a finding's confidence", () => {
  it("is the minimum across every input, not the average", () => {
    /**
     * §11.1: "a rule's finding confidence is the minimum across its inputs". A
     * conclusion drawn partly from a record nobody has checked in a year is only
     * as trustworthy as that record, and averaging would let fresh inputs hide a
     * stale one.
     */
    expect(deriveConfidence([input(), input(), input({ lastVerifiedAt: daysAgo(400) })], NOW)).toBe(
      "low",
    );
  });

  it("is high only when every input is", () => {
    expect(deriveConfidence([input(), input()], NOW)).toBe("high");
  });

  it("is low when a rule read nothing", () => {
    // A rule that demonstrated nothing must not look the most certain.
    expect(deriveConfidence([], NOW)).toBe("low");
  });

  it("never returns a value outside the column's vocabulary", () => {
    const cases: ConfidenceInput[][] = [
      [input({ sourceType: "demo" })],
      [input({ sourceType: "connector", lastVerifiedAt: daysAgo(200) })],
      [input({ lastVerifiedAt: null, createdAt: daysAgo(1) })],
    ];

    for (const inputs of cases) {
      expect(["low", "medium", "high"]).toContain(deriveConfidence(inputs, NOW));
    }
  });
});
