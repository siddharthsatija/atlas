import { describe, expect, it } from "vitest";
import { PURPOSE_POLICIES, allowsRecordKind, policyFor } from "./policy-map";
import { classifyContext } from "./classification";
import { AI_PURPOSES } from "../prompts/prompt";

/**
 * ATL-049 — the per-purpose data-selection policy and the sensitivity classifier.
 *
 * Pure modules, so these run in the `unit` project. The assertions are mostly
 * *negative*: what each purpose may not see matters more than what it may, and
 * "unrelated records never included" is the acceptance criterion this table
 * exists to satisfy.
 */

describe("the policy covers the taxonomy exactly", () => {
  it("defines a policy for every purpose", () => {
    // A purpose with no data policy would fall through to whatever a caller
    // happened to pass.
    for (const purpose of AI_PURPOSES) {
      expect(policyFor(purpose), `${purpose} has no policy`).toBeDefined();
    }
  });

  it("defines no policy for a purpose outside the taxonomy", () => {
    expect(Object.keys(PURPOSE_POLICIES).sort()).toEqual([...AI_PURPOSES].sort());
  });
});

describe("per-purpose selection (AI behavior §5)", () => {
  it("lets explain_finding see the finding, its asset, and score definitions", () => {
    expect(policyFor("explain_finding").allows).toEqual([
      "finding",
      "asset",
      "score_factor_definition",
    ]);
    expect(policyFor("explain_finding").maxFindings).toBe(1);
  });

  it("lets summarize_asset see one asset with its categories and permissions", () => {
    expect(policyFor("summarize_asset").allows).toEqual([
      "asset",
      "asset_categories",
      "asset_permissions",
    ]);
    // No findings: a summary of an asset is not a summary of its problems.
    expect(policyFor("summarize_asset").maxFindings).toBe(0);
  });

  it("lets explain_score see the latest snapshot and definitions only", () => {
    expect(policyFor("explain_score").allows).toEqual([
      "score_snapshot",
      "score_factor_definition",
    ]);
  });

  it("caps recommend_action at ten findings", () => {
    expect(policyFor("recommend_action").maxFindings).toBe(10);
    expect(policyFor("recommend_action").allows).toEqual(["finding"]);
  });

  it("lets draft_request see approved personal fields and nothing else", () => {
    expect(policyFor("draft_request").allows).toEqual(["approved_personal_fields"]);
    expect(policyFor("draft_request").allowsPersonalFields).toBe(true);
  });

  it("lets product_question see no user records at all", () => {
    expect(policyFor("product_question").allows).toEqual([]);
    expect(policyFor("product_question").readsNoUserRecords).toBe(true);
  });
});

describe("unrelated records are never allowed", () => {
  it("permits personal fields for draft_request alone", () => {
    /**
     * The sharpest privacy boundary in the table. A purpose that could reach
     * personal fields without an approval flow would be sending stored values
     * on the strength of their existing (ADR-002).
     */
    const permitted = AI_PURPOSES.filter((purpose) => policyFor(purpose).allowsPersonalFields);

    expect(permitted).toEqual(["draft_request"]);
  });

  it("keeps findings out of every purpose that has no use for them", () => {
    for (const purpose of [
      "summarize_asset",
      "explain_score",
      "draft_request",
      "product_question",
    ] as const) {
      expect(allowsRecordKind(purpose, "finding"), `${purpose} allows findings`).toBe(false);
      expect(policyFor(purpose).maxFindings).toBe(0);
    }
  });

  it("keeps assets out of score and product purposes", () => {
    expect(allowsRecordKind("explain_score", "asset")).toBe(false);
    expect(allowsRecordKind("product_question", "asset")).toBe(false);
  });

  it("gives product_question no reachable record kind whatsoever", () => {
    const kinds = [
      "finding",
      "asset",
      "asset_categories",
      "asset_permissions",
      "score_snapshot",
      "score_factor_definition",
      "approved_personal_fields",
    ] as const;

    for (const kind of kinds) {
      expect(allowsRecordKind("product_question", kind), `${kind} was reachable`).toBe(false);
    }
  });

  it("requires a subject only where retrieval hangs off one entity", () => {
    expect(policyFor("explain_finding").requiresSubject).toBe(true);
    expect(policyFor("summarize_asset").requiresSubject).toBe(true);
    expect(policyFor("explain_score").requiresSubject).toBe(false);
    expect(policyFor("recommend_action").requiresSubject).toBe(false);
    expect(policyFor("product_question").requiresSubject).toBe(false);
  });
});

describe("sensitivity classification", () => {
  it("is none when no user records were sent", () => {
    expect(classifyContext({ recordIds: [], includedPersonalFieldKeys: [] })).toBe("none");
  });

  it("is metadata when records were sent but no personal values", () => {
    expect(classifyContext({ recordIds: ["finding-1"], includedPersonalFieldKeys: [] })).toBe(
      "metadata",
    );
  });

  it("is personal as soon as one approved field value is included", () => {
    /**
     * The maximum reached, not the majority. The disclosure surface answers "how
     * sensitive was what you sent", so one personal value colours the whole
     * interaction.
     */
    expect(classifyContext({ recordIds: ["asset-1"], includedPersonalFieldKeys: ["email"] })).toBe(
      "personal",
    );
  });

  it("is personal even with no other records", () => {
    expect(classifyContext({ recordIds: [], includedPersonalFieldKeys: ["email"] })).toBe(
      "personal",
    );
  });
});
