import { describe, expect, it } from "vitest";
import { CONFIDENCE_METHOD, PROVENANCE_LIMITATION, parseProvenance } from "./provenance";
import { sourceReferenceFor } from "./rules/catalog";

/**
 * ATL-041 — reading provenance back.
 *
 * ADR-001: "every finding cites rule ID, rule version, and input records". The
 * first two are packed into `source_reference` by the engine; this is the other
 * half of that contract, and the round-trip test below is what keeps the two
 * from drifting apart.
 */

describe("parsing rule_id@version", () => {
  it("round-trips what the engine writes", () => {
    // Against the writer itself, not a hand-typed string — the pairing is the
    // thing under test.
    const parsed = parseProvenance(sourceReferenceFor("R-001"));

    expect(parsed.ruleId).toBe("R-001");
    expect(parsed.ruleVersion).toBe("rules-v1");
  });

  it("keeps the raw reference alongside the parts", () => {
    expect(parseProvenance("R-004@rules-v1").reference).toBe("R-004@rules-v1");
  });

  it("splits on the last separator, so a rule id containing @ survives", () => {
    expect(parseProvenance("R@odd@rules-v2")).toMatchObject({
      ruleId: "R@odd",
      ruleVersion: "rules-v2",
    });
  });
});

describe("references that cannot be split", () => {
  it("reports no rule for a demo-seeded finding", () => {
    // §7.5 allows a finding with no rule behind it; `source_reference` is null.
    expect(parseProvenance(null)).toEqual({
      ruleId: null,
      ruleVersion: null,
      reference: null,
    });
  });

  it("returns an unexpected value whole rather than discarding it", () => {
    /**
     * Showing something true beats showing nothing. A surface can render the
     * raw reference and the reader can still quote it back.
     */
    for (const odd of ["R-001", "@rules-v1", "R-001@", ""]) {
      const parsed = parseProvenance(odd);

      expect(parsed.ruleId).toBeNull();
      expect(parsed.ruleVersion).toBeNull();
      if (odd !== "") expect(parsed.reference).toBe(odd);
    }
  });
});

describe("what the copy must not claim", () => {
  it("describes how confidence is derived without asserting per-record certainty", () => {
    // The `ConfidenceInput[]` behind a finding is not persisted, so the method
    // is explained and the individual inputs are not invented.
    expect(CONFIDENCE_METHOD).toMatch(/lowest certainty/i);
    expect(CONFIDENCE_METHOD).toMatch(/derived from your data/i);
  });

  it("states the two gaps plainly", () => {
    /**
     * Frontend §8 requires a view to explain its limitations and CLAUDE.md
     * forbids claiming behaviour Atlas does not have. Nothing records when a
     * rule last ran, and nothing records per-input certainty.
     */
    expect(PROVENANCE_LIMITATION).toMatch(/when a rule last ran/i);
    expect(PROVENANCE_LIMITATION).toMatch(/each individual record/i);
  });

  it("promises no evaluation timestamp anywhere in the copy", () => {
    for (const copy of [CONFIDENCE_METHOD, PROVENANCE_LIMITATION]) {
      expect(copy).not.toMatch(/last evaluated at|evaluated on \d/i);
    }
  });
});
