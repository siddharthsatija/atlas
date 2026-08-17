import { describe, expect, it } from "vitest";
import { buildFindingFallback, type FallbackFindingInput } from "./finding-fallback";
import { AI_DISABLED_NOTICE, FALLBACK_NOTICE } from "@/lib/ai/fallback-copy";

/**
 * ATL-052 — the deterministic finding explanation.
 *
 * A pure module, so this runs in the `unit` project. The assertions that matter
 * most are the *negative* ones: this is the path that runs when the AI failed,
 * so it must not leak provider language, must not invent a confidence it cannot
 * have, and must not depend on anything the AI produced.
 */

const finding = (overrides: Partial<FallbackFindingInput> = {}): FallbackFindingInput => ({
  id: "11111111-1111-1111-1111-111111111111",
  title: "Broad contact access",
  description: "This service can read your contacts.",
  evidenceSummary: "The permission grants contact access and was last reviewed 8 months ago.",
  recommendedAction: "Review this permission",
  confidence: "medium",
  sourceType: "connector",
  evidenceIds: ["22222222-2222-2222-2222-222222222222"],
  ...overrides,
});

describe("the explanation is built from persisted fields only", () => {
  it("uses the finding's title as the summary", () => {
    expect(buildFindingFallback(finding()).summary).toBe("Broad contact access");
  });

  it("combines the description and the rule's evidence summary", () => {
    /**
     * `description` says what the condition is, `evidenceSummary` says what the
     * rule actually read. Both were rendered from the versioned rule template at
     * evaluation time, which is what keeps this "rule-based template text"
     * without touching the catalog.
     */
    const result = buildFindingFallback(finding());

    expect(result.whyItMatters).toContain("This service can read your contacts.");
    expect(result.whyItMatters).toContain("last reviewed 8 months ago");
  });

  it("opens with the approved §8 phrasing", () => {
    // So a fallback does not read as a different product from an AI answer.
    expect(buildFindingFallback(finding()).whyItMatters).toMatch(
      /^Based on the information saved in Atlas/,
    );
  });

  it("carries the rule's recommended action verbatim", () => {
    expect(buildFindingFallback(finding()).recommendedAction).toBe("Review this permission");
  });

  it("cites the finding and the records the rule read", () => {
    // An explanation citing nothing is ungrounded — the same standard ATL-050
    // holds AI output to.
    const result = buildFindingFallback(finding());

    expect(result.evidenceReferences).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("still cites the finding when it has no evidence records", () => {
    expect(buildFindingFallback(finding({ evidenceIds: [] })).evidenceReferences).toEqual([
      "11111111-1111-1111-1111-111111111111",
    ]);
  });
});

describe("it never fabricates model confidence", () => {
  it("has no confidence field at all", () => {
    /**
     * The semantic distinction this ticket turns on. ATL-050's `confidence`
     * means the *model's* certainty about its own reasoning; there is no model
     * here, so any value would be false — and copying the finding's rule
     * confidence would be worse, because the UI would render one as the other.
     */
    expect(buildFindingFallback(finding())).not.toHaveProperty("confidence");
  });

  it("reports low rule confidence in words instead", () => {
    // The derived value is real (ADR-001); restating it as a number the user
    // cannot act on is what would be unhelpful.
    const result = buildFindingFallback(finding({ confidence: "low" }));

    expect(result.disclosures.join(" ")).toMatch(/could not recently verify/i);
  });

  it("adds no staleness disclosure when confidence is not low", () => {
    /**
     * Asserted on the joined string, not with `toContain` plus an asymmetric
     * matcher: `toContain` compares array members by equality, so a
     * `stringMatching` argument would never match and the test would pass
     * whatever the code did.
     */
    for (const confidence of ["medium", "high"] as const) {
      expect(buildFindingFallback(finding({ confidence })).disclosures.join(" ")).not.toMatch(
        /could not recently verify/i,
      );
    }
  });
});

describe("required disclosures (§4)", () => {
  it("labels demo findings as demo", () => {
    const result = buildFindingFallback(finding({ sourceType: "demo" }));

    expect(result.disclosures.join(" ")).toMatch(/demo data/i);
  });

  it("adds no demo label to a real finding", () => {
    expect(buildFindingFallback(finding()).disclosures.join(" ")).not.toMatch(/demo/i);
  });

  it("reports both disclosures when both apply", () => {
    const result = buildFindingFallback(finding({ sourceType: "demo", confidence: "low" }));

    expect(result.disclosures).toHaveLength(2);
  });
});

describe("the notice explains which path was taken", () => {
  it("says temporarily unavailable when the AI failed", () => {
    expect(buildFindingFallback(finding(), "ai_unavailable").notice).toBe(FALLBACK_NOTICE);
  });

  it("says turned off when AI is disabled", () => {
    /**
     * Deliberately different copy. Telling a user something is "temporarily
     * unavailable" when an operator switched it off is a small lie, and small
     * lies about the assistant erode trust in the rest of the product.
     */
    expect(buildFindingFallback(finding(), "ai_disabled").notice).toBe(AI_DISABLED_NOTICE);
  });

  it("defaults to the outage notice", () => {
    expect(buildFindingFallback(finding()).notice).toBe(FALLBACK_NOTICE);
  });
});

describe("nothing about the provider escapes", () => {
  it("contains no provider or failure vocabulary anywhere", () => {
    /**
     * AI behavior §11: do not expose provider errors. Asserted over the whole
     * serialised result rather than one field, because a leak would most likely
     * arrive in whichever field nobody thought to check.
     */
    const serialised = JSON.stringify(buildFindingFallback(finding()));

    for (const forbidden of [
      "anthropic",
      "claude",
      "provider",
      "rate limit",
      "timeout",
      "500",
      "429",
      "error",
    ]) {
      expect(serialised.toLowerCase(), `${forbidden} leaked`).not.toContain(forbidden);
    }
  });

  it("marks itself as a fallback so a caller cannot mistake it for AI output", () => {
    expect(buildFindingFallback(finding()).source).toBe("fallback");
  });
});

describe("it is deterministic and immutable", () => {
  it("produces the same result for the same finding", () => {
    // The whole point: no model, no variation, no surprise on a retry.
    expect(buildFindingFallback(finding())).toEqual(buildFindingFallback(finding()));
  });

  it("is frozen, so a caller cannot edit the explanation in place", () => {
    expect(Object.isFrozen(buildFindingFallback(finding()))).toBe(true);
  });
});
