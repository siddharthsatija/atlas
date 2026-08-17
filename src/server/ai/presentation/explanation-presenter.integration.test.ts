import { describe, expect, it } from "vitest";

import {
  presentAssetSummary,
  presentExplanation,
  type ResolvedEvidence,
} from "./explanation-presenter";
import type { AiPolicyResult } from "../policy/ai-policy-service";
import { buildFindingFallback } from "../fallback/finding-fallback";

/**
 * ATL-053 M1 — the presenter.
 *
 * What these protect is the boundary between two contracts that look alike and
 * mean different things. The AI explanation carries the **model's** confidence;
 * the deterministic one carries none, and ATL-052 made `source` a discriminant so
 * a surface could never show one as the other. The presenter is where that
 * distinction either survives into the UI or quietly dies.
 */

const RECORD_A = "11111111-1111-1111-1111-111111111111";
const RECORD_B = "22222222-2222-2222-2222-222222222222";

const evidence: ResolvedEvidence[] = [
  { id: RECORD_A, label: "Old shopping account", href: "/assets/a" },
  { id: RECORD_B, label: "Location history", href: null },
];

const aiOutput = {
  summary: "This account still has your address.",
  whyItMatters: "Dormant accounts are a common breach source.",
  evidenceReferences: [RECORD_A],
  confidence: "high" as const,
  uncertainties: ["Atlas cannot see whether the account is still active."],
  recommendedActions: [{ label: "Open the asset", actionType: "open_asset", entityId: RECORD_A }],
};

function answered(overrides: Partial<Extract<AiPolicyResult, { status: "answered" }>>) {
  return {
    status: "answered",
    source: "ai",
    value: aiOutput,
    classification: "metadata",
    ...overrides,
  } as AiPolicyResult;
}

describe("an AI answer", () => {
  it("keeps the model's confidence and uncertainties", () => {
    const state = presentExplanation({ result: answered({}), evidence });

    expect(state.status).toBe("answered");
    if (state.status !== "answered") return;
    expect(state.explanation.source).toBe("ai");
    if (state.explanation.source !== "ai") return;

    expect(state.explanation.confidence).toBe("high");
    expect(state.explanation.uncertainties).toHaveLength(1);
  });

  it("resolves cited ids to labels a person can read", () => {
    const state = presentExplanation({ result: answered({}), evidence });
    if (state.status !== "answered") throw new Error("expected an answer");

    expect(state.explanation.sources).toEqual([
      { id: RECORD_A, label: "Old shopping account", href: "/assets/a" },
    ]);
  });

  it("drops a citation it cannot resolve rather than showing a bare id", () => {
    /**
     * ATL-050's invariant layer already refuses references outside the sent
     * context, so an unresolvable id here means an internal mismatch — not a
     * hallucination. Either way a UUID is not an explanation, and rendering one
     * would be the worst of both.
     */
    const result = answered({
      value: {
        ...aiOutput,
        evidenceReferences: [RECORD_A, "99999999-9999-9999-9999-999999999999"],
      },
    });

    const state = presentExplanation({ result, evidence });
    if (state.status !== "answered") throw new Error("expected an answer");

    expect(state.explanation.sources.map((source) => source.id)).toEqual([RECORD_A]);
  });

  it("reports unavailable when the payload does not match ATL-050's schema", () => {
    /**
     * It validated once inside the pipeline, so a failure here means the contract
     * moved underneath us. A partial render would be the dishonest option.
     */
    const state = presentExplanation({
      result: answered({ value: { summary: "" } }),
      evidence,
    });

    expect(state.status).toBe("unavailable");
  });

  it("carries the interaction id through so feedback can attach to it", () => {
    const state = presentExplanation({
      result: answered({ interactionId: "row-1" }),
      evidence,
    });
    if (state.status !== "answered") throw new Error("expected an answer");

    expect(state.explanation.interactionId).toBe("row-1");
  });

  it("omits the id entirely when nothing was recorded", () => {
    const state = presentExplanation({ result: answered({}), evidence });
    if (state.status !== "answered") throw new Error("expected an answer");

    /** Absent rather than null: there is no row, so there is nothing to offer. */
    expect(state.explanation.interactionId).toBeUndefined();
  });
});

describe("a deterministic answer", () => {
  const fallback = buildFindingFallback({
    id: "finding-1",
    title: "An old account still holds your address",
    description: "Atlas found a dormant account.",
    evidenceSummary: "One asset and one permission were read.",
    recommendedAction: "Close the account or remove the address.",
    confidence: "low",
    sourceType: "demo",
    evidenceIds: [RECORD_A, RECORD_B],
  });

  const result = {
    status: "answered",
    source: "fallback",
    value: fallback,
    classification: "metadata",
  } as AiPolicyResult;

  it("has no confidence field at all", () => {
    const state = presentExplanation({ result, evidence });
    if (state.status !== "answered") throw new Error("expected an answer");

    /**
     * The type already makes this impossible to render; asserted anyway because
     * a later refactor that widened the variant would pass tsc and fail here.
     */
    expect(state.explanation).not.toHaveProperty("confidence");
  });

  it("keeps the rule's recommendation as prose, not as an action", () => {
    const state = presentExplanation({ result, evidence });
    if (state.status !== "answered") throw new Error("expected an answer");
    if (state.explanation.source !== "fallback") throw new Error("expected the fallback");

    expect(state.explanation.recommendedAction).toContain("Close the account");
    /** No actionType or entityId exists, so no button may claim one. */
    expect(state.explanation.actions).toEqual([]);
  });

  it("carries the demo disclosure §4 requires", () => {
    const state = presentExplanation({ result, evidence });
    if (state.status !== "answered") throw new Error("expected an answer");
    if (state.explanation.source !== "fallback") throw new Error("expected the fallback");

    expect(state.explanation.disclosures.join(" ")).toMatch(/demo/i);
  });

  it("reports unavailable when the payload is not a fallback explanation", () => {
    const state = presentExplanation({
      result: { status: "answered", source: "fallback", value: null, classification: "none" },
      evidence,
    });

    expect(state.status).toBe("unavailable");
  });
});

describe("the non-answer states", () => {
  it("passes consent_required through so the UI can ask", () => {
    const state = presentExplanation({
      result: { status: "consent_required" },
      evidence,
    });

    expect(state.status).toBe("consent_required");
  });

  it("keeps not_found distinct, because the panel closes on it", () => {
    const state = presentExplanation({
      result: { status: "not_found" },
      evidence,
    });

    expect(state.status).toBe("not_found");
  });

  it("collapses guidance to unavailable, the panel asking no product questions", () => {
    const state = presentExplanation({
      /** The real shape: `message`, not `value` — a product answer, not a payload. */
      result: { status: "guidance", message: "Atlas can help with that." },
      evidence,
    });

    expect(state.status).toBe("unavailable");
  });
});

describe("what reaches the user", () => {
  it("never carries provider vocabulary in any rendered string", () => {
    /**
     * The locked decision: a user is told Atlas could not answer, never that a
     * named vendor rate-limited it. Asserted on the whole serialised state rather
     * than field by field, so a new field added later is covered by default.
     */
    const states = [
      presentExplanation({ result: answered({}), evidence }),
      presentExplanation({
        result: { status: "unavailable" },
        evidence,
      }),
    ];

    const rendered = JSON.stringify(states).toLowerCase();

    for (const term of ["anthropic", "claude", "sonnet", "openai", "overloaded", "429"]) {
      expect(rendered).not.toContain(term);
    }
  });

  it("discloses how many records were sent", () => {
    const state = presentExplanation({ result: answered({}), evidence });
    if (state.status !== "answered") throw new Error("expected an answer");

    expect(state.explanation.disclosure).toEqual({
      classification: "metadata",
      recordCount: 2,
    });
  });
});

/**
 * ATL-054 M3 — the asset-summary path.
 *
 * These exist because the shapes are close enough to be mistaken for each other
 * and different enough that mistaking them is a silent outage. An asset summary
 * has no `whyItMatters` and no `confidence`; routing it through
 * `presentExplanation` returns `unavailable` on a perfectly good answer, and the
 * surface looks broken while the model is working. The first test below is the
 * one that fails if anyone reunites the two functions.
 */

const ASSET = "33333333-3333-3333-3333-333333333333";
const CATEGORY = "44444444-4444-4444-4444-444444444444";

const assetEvidence: ResolvedEvidence[] = [
  { id: ASSET, label: "Beta Bank", href: "/assets/beta" },
  { id: CATEGORY, label: "Financial", href: "/assets/beta/edit" },
];

const summaryOutput = {
  summary: "Beta Bank is recorded as holding financial data.",
  evidenceReferences: [ASSET, CATEGORY],
  uncertainties: ["Atlas cannot see when this was last confirmed."],
};

function summarised(overrides: Partial<Extract<AiPolicyResult, { status: "answered" }>>) {
  return {
    status: "answered",
    source: "ai",
    value: summaryOutput,
    classification: "metadata",
    ...overrides,
  } as AiPolicyResult;
}

const present = (result: AiPolicyResult) =>
  presentAssetSummary({ result, evidence: assetEvidence, subjectName: "Beta Bank" });

describe("an asset summary", () => {
  it("is rendered as its own variant, not as an explanation", () => {
    const state = present(summarised({}));

    expect(state.status).toBe("answered");
    if (state.status !== "answered") return;

    /**
     * The discriminant is the whole guarantee. `asset_summary` is what makes the
     * component pick a renderer that cannot read a `confidence` — a field this
     * output does not have and which would have to be invented to show one.
     */
    expect(state.explanation.source).toBe("asset_summary");
  });

  /**
   * The regression this milestone was written to prevent.
   *
   * `explanationSchema` rejects this value, so a shared presenter would answer
   * `unavailable` every single time. Asserting the *positive* status is what
   * catches that, because `unavailable` is also what a genuine outage returns and
   * the two are indistinguishable from the outside.
   */
  it("does not collapse to unavailable the way the explanation parser would", () => {
    expect(presentExplanation({ result: summarised({}), evidence: assetEvidence }).status).toBe(
      "unavailable",
    );

    expect(present(summarised({})).status).toBe("answered");
  });

  it("names the asset in the disclosure, from the caller and not the model", () => {
    const state = present(summarised({}));
    if (state.status !== "answered") throw new Error("expected an answer");

    /**
     * `subjectName` is an argument, so it cannot carry model output — the scope
     * claim in §11 is a statement Atlas makes about itself, and a hallucinated
     * name inside it would make the sentence false while still reading well.
     */
    expect(state.explanation.disclosure.subjectName).toBe("Beta Bank");
  });

  it("leaves the finding panel's disclosure unnamed", () => {
    const state = presentExplanation({ result: answered({}), evidence });
    if (state.status !== "answered") throw new Error("expected an answer");

    /** Naming the subject is opt-in; the finding drawer is already titled. */
    expect(state.explanation.disclosure.subjectName).toBeUndefined();
  });

  it("resolves cited ids to labels and drops ids it cannot match", () => {
    const state = present(
      summarised({
        value: { ...summaryOutput, evidenceReferences: [ASSET, RECORD_A] },
      }),
    );
    if (state.status !== "answered") throw new Error("expected an answer");

    /**
     * `RECORD_A` belongs to the finding fixtures and is not in this asset's
     * evidence. It is dropped rather than rendered as a bare identifier — the
     * invariant layer has already refused references outside the context, so a
     * gap here is an internal mismatch and a user should see neither.
     */
    expect(state.explanation.sources.map((source) => source.label)).toEqual(["Beta Bank"]);
  });

  it("refuses a deterministic value rather than rendering it as a summary", () => {
    const fallback = present(
      summarised({
        source: "fallback",
        value: buildFindingFallback(
          {
            id: ASSET,
            title: "Unused account",
            description: "This account has not been used.",
            evidenceSummary: "Last seen a year ago.",
            recommendedAction: "Consider closing it.",
            confidence: "high",
            sourceType: "manual",
            evidenceIds: [],
          },
          "ai_unavailable",
        ),
      }),
    );

    /**
     * There is no deterministic asset summary — a locked ATL-054 decision, since
     * no rule exists to write one from. A `fallback` value here therefore
     * describes something else, and `unavailable` plus Try again is the honest
     * reading of it.
     */
    expect(fallback.status).toBe("unavailable");
  });

  it("passes every refusal through unchanged", () => {
    expect(present({ status: "consent_required" }).status).toBe("consent_required");
    expect(present({ status: "not_found" }).status).toBe("not_found");
  });

  it("carries the interaction id when there is one, and omits it when there is not", () => {
    const withId = present(summarised({ interactionId: "interaction-1" }));
    if (withId.status !== "answered") throw new Error("expected an answer");
    expect(withId.explanation.interactionId).toBe("interaction-1");

    const without = present(summarised({}));
    if (without.status !== "answered") throw new Error("expected an answer");
    expect(without.explanation.interactionId).toBeUndefined();
  });
});
