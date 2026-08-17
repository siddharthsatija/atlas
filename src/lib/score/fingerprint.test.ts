import { describe, expect, it } from "vitest";
import { fingerprintOfStored, scoreFingerprint, type FingerprintSource } from "./fingerprint";

/**
 * ATL-045 — the write-on-change fingerprint.
 *
 * The property under test is exactness: two calculations over identical records
 * must produce byte-identical fingerprints, or the write-on-change rule writes a
 * snapshot on every mutation and stops being a rule at all.
 */

const source = (overrides: Partial<FingerprintSource> = {}): FingerprintSource => ({
  score: 56,
  scoreVersion: "score-v1",
  isDemo: false,
  factors: [
    { id: "account_hygiene", excluded: false, inputs: { activeAssets: 6, activeReviewed: 4 } },
    { id: "open_findings", excluded: false, inputs: { deductingFindings: 3 } },
  ],
  ...overrides,
});

describe("what the fingerprint distinguishes", () => {
  it("is identical for identical states", () => {
    expect(scoreFingerprint(source())).toBe(scoreFingerprint(source()));
  });

  it.each([
    ["score", { score: 57 }],
    ["version", { scoreVersion: "score-v2" }],
    ["demo flag", { isDemo: true }],
  ] as const)("changes when the %s changes", (_label, change) => {
    expect(scoreFingerprint(source(change))).not.toBe(scoreFingerprint(source()));
  });

  it("changes when a factor's inputs change", () => {
    const moved = source({
      factors: [
        { id: "account_hygiene", excluded: false, inputs: { activeAssets: 6, activeReviewed: 5 } },
        { id: "open_findings", excluded: false, inputs: { deductingFindings: 3 } },
      ],
    });

    expect(scoreFingerprint(moved)).not.toBe(scoreFingerprint(source()));
  });

  it("changes when a factor becomes excluded", () => {
    /**
     * Coverage is part of the breakdown, and a factor dropping out changes what
     * the score means even if the number happens to land the same.
     */
    const excluded = source({
      factors: [
        { id: "account_hygiene", excluded: false, inputs: { activeAssets: 6, activeReviewed: 4 } },
        { id: "open_findings", excluded: true, inputs: {} },
      ],
    });

    expect(scoreFingerprint(excluded)).not.toBe(scoreFingerprint(source()));
  });
});

describe("what the fingerprint deliberately ignores", () => {
  it("does not depend on factor order", () => {
    // Two code paths building the same state must agree, or an unrelated
    // refactor writes a snapshot.
    const reversed = source({ factors: [...source().factors].reverse() });

    expect(scoreFingerprint(reversed)).toBe(scoreFingerprint(source()));
  });

  it("does not depend on input key order", () => {
    const reordered = source({
      factors: [
        { id: "account_hygiene", excluded: false, inputs: { activeReviewed: 4, activeAssets: 6 } },
        { id: "open_findings", excluded: false, inputs: { deductingFindings: 3 } },
      ],
    });

    expect(scoreFingerprint(reordered)).toBe(scoreFingerprint(source()));
  });

  it("ignores floats entirely, by not accepting them", () => {
    /**
     * `value` and `normalisedWeight` are not part of `FingerprintFactor`. This
     * asserts the consequence rather than the type: a state carrying different
     * float values but identical inputs fingerprints the same, because the
     * floats are derived from the inputs and never compared.
     */
    const withFloats = {
      ...source(),
      factors: source().factors.map((factor) => ({
        ...factor,
        value: 71.42857142857143,
        normalisedWeight: 29.411764705882355,
      })),
    };

    expect(scoreFingerprint(withFloats)).toBe(scoreFingerprint(source()));
  });
});

describe("reading a stored snapshot", () => {
  const stored = (breakdown: unknown) =>
    fingerprintOfStored({ score: 56, scoreVersion: "score-v1", isDemo: false, breakdown });

  it("round-trips a breakdown this service wrote", () => {
    const breakdown = {
      coverage: 100,
      factors: source().factors.map((factor) => ({
        ...factor,
        label: "Account hygiene",
        weight: 25,
        normalisedWeight: 25,
        value: 40,
      })),
    };

    expect(stored(breakdown)).toBe(scoreFingerprint(source()));
  });

  it.each([
    ["null", null],
    ["a scalar", 7],
    ["an array", []],
    ["an object with no factors", { coverage: 100 }],
    ["factors that are not an array", { factors: {} }],
    ["a factor missing its id", { factors: [{ excluded: false, inputs: {} }] }],
    ["a factor with a non-boolean exclusion", { factors: [{ id: "a", excluded: 1, inputs: {} }] }],
    [
      "a factor with non-numeric inputs",
      { factors: [{ id: "a", excluded: false, inputs: { n: "1" } }] },
    ],
  ])("answers null for %s", (_label, breakdown) => {
    /**
     * Null means "different", so the caller writes. Failing towards recording is
     * right: a redundant snapshot is noise compaction removes, while a skipped
     * one is a hole in the user's history.
     */
    expect(stored(breakdown)).toBeNull();
  });
});
