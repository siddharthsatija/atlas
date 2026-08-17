import { describe, expect, it } from "vitest";
import { validateOutput } from "./validate";
import { schemaEntries, schemaFor } from "./registry";
import { checkInvariants, type ValidationContext } from "./invariants";
import { explanationSchema, ACTION_TYPES } from "./explanation";
import { draftSchema } from "./draft";
import { SCHEMA_IDS } from "../prompts/prompt";

/**
 * ATL-050 — output schemas, invariants and the validation pipeline.
 *
 * `*.integration.test.ts` for the `server` project: these import through
 * modules that are `server-only`.
 *
 * The adversarial cases carry the most weight. A schema test proves Zod works;
 * the adversarial cases prove that a well-formed lie — correctly shaped output
 * citing records nobody sent — is refused.
 */

const FINDING_ID = "11111111-1111-1111-1111-111111111111";
const ASSET_ID = "22222222-2222-2222-2222-222222222222";
const FOREIGN_ID = "99999999-9999-9999-9999-999999999999";

const context: ValidationContext = {
  contextIds: new Set([FINDING_ID, ASSET_ID]),
  approvedFieldKeys: new Set(["email", "full_name"]),
  ownedEntityIds: new Set([ASSET_ID]),
};

const validExplanation = {
  summary: "Based on the information saved in Atlas, this account has broad access.",
  whyItMatters: "This may matter because broad access persists after you stop using a service.",
  evidenceReferences: [FINDING_ID],
  confidence: "medium",
  uncertainties: ["Atlas could not verify when the permission was last used."],
  recommendedActions: [
    { label: "Review this permission", actionType: "review_permission", entityId: ASSET_ID },
  ],
};

const validDraft = {
  recipient: "privacy@example.com",
  subject: "Request to delete my personal data",
  body: "I am requesting deletion of the personal data you hold about me.",
  includedFieldKeys: ["email"],
  assumptions: ["The recipient address was entered by the user and is unverified."],
  warnings: [],
};

const json = (value: unknown) => JSON.stringify(value);

describe("the schema registry", () => {
  it("implements every identifier ATL-051 declares", () => {
    /**
     * The ticket's named check, and the drift guard between the two tickets. A
     * prompt naming a schema nobody implemented fails on every call, retries
     * once and falls back — a total outage produced by two artefacts disagreeing.
     */
    for (const id of SCHEMA_IDS) {
      expect(schemaFor(id)).toBeDefined();
      expect(schemaFor(id).id).toBe(id);
    }

    expect(schemaEntries()).toHaveLength(SCHEMA_IDS.length);
  });

  it("gives every schema a positive version", () => {
    for (const entry of schemaEntries()) {
      expect(entry.version).toBeGreaterThan(0);
    }
  });

  it("agrees with the version each registered prompt declares", async () => {
    /**
     * Two artefacts name the same schema version: ATL-051's prompt declares one,
     * ATL-050 implements one. They must match, because
     * `ai_interactions.output_schema_version` records the implementation's — and
     * a disagreement would mean the recorded number describes a different schema
     * than the prompt asked the model to produce.
     */
    const { registeredPrompts } = await import("../prompts/registry");

    for (const prompt of registeredPrompts()) {
      expect(
        schemaFor(prompt.schemaId).version,
        `${prompt.promptId} declares a stale version`,
      ).toBe(prompt.schemaVersion);
    }
  });
});

describe("the explanation schema matches AI behavior §7", () => {
  it("accepts a well-formed explanation", () => {
    expect(explanationSchema.safeParse(validExplanation).success).toBe(true);
  });

  it("requires every specified field", () => {
    for (const field of Object.keys(validExplanation)) {
      const incomplete = { ...validExplanation };
      delete (incomplete as Record<string, unknown>)[field];

      expect(explanationSchema.safeParse(incomplete).success, `${field} was optional`).toBe(false);
    }
  });

  it("rejects an empty summary rather than rendering a blank answer", () => {
    // z.string() would accept "". A blank panel presented as an answer is worse
    // than a fallback.
    expect(explanationSchema.safeParse({ ...validExplanation, summary: "" }).success).toBe(false);
  });

  it("rejects a confidence value outside the specified three", () => {
    expect(
      explanationSchema.safeParse({ ...validExplanation, confidence: "very-high" }).success,
    ).toBe(false);
  });

  it("rejects an action type outside the allowlist", () => {
    const output = {
      ...validExplanation,
      recommendedActions: [
        { label: "Delete it", actionType: "delete_account", entityId: ASSET_ID },
      ],
    };

    expect(explanationSchema.safeParse(output).success).toBe(false);
  });

  it("rejects an entity id that is not a uuid", () => {
    // A model inventing `asset-123` fails here rather than reaching the
    // ownership check with a shape nobody can look up.
    const output = {
      ...validExplanation,
      recommendedActions: [
        { label: "Open", actionType: "open_asset", entityId: "asset-not-a-uuid" },
      ],
    };

    expect(explanationSchema.safeParse(output).success).toBe(false);
  });

  it("strips unknown fields rather than rejecting them", () => {
    const parsed = explanationSchema.parse({
      ...validExplanation,
      internalScore: 0.97,
      systemPrompt: "leaked",
    });

    expect(parsed).not.toHaveProperty("internalScore");
    expect(parsed).not.toHaveProperty("systemPrompt");
    expect(parsed.summary).toBe(validExplanation.summary);
  });
});

describe("the draft schema matches AI behavior §7", () => {
  it("accepts a well-formed draft", () => {
    expect(draftSchema.safeParse(validDraft).success).toBe(true);
  });

  it("requires every specified field", () => {
    for (const field of Object.keys(validDraft)) {
      const incomplete = { ...validDraft };
      delete (incomplete as Record<string, unknown>)[field];

      expect(draftSchema.safeParse(incomplete).success, `${field} was optional`).toBe(false);
    }
  });

  it("accepts a non-email recipient", () => {
    /**
     * Deliberate. §5: the recipient is user-entered and unverified in MVP, and
     * services accept postal and web-form recipients. Validating it as an email
     * would imply a check Atlas has not performed.
     */
    expect(
      draftSchema.safeParse({ ...validDraft, recipient: "Data Protection Officer, PO Box 1" })
        .success,
    ).toBe(true);
  });

  it("strips unknown fields", () => {
    const parsed = draftSchema.parse({ ...validDraft, sendImmediately: true });

    expect(parsed).not.toHaveProperty("sendImmediately");
  });
});

describe("invariants catch well-formed lies", () => {
  it("rejects an evidence reference that was never in context", () => {
    // The hallucination case: correctly shaped, and about a record nobody sent.
    const violations = checkInvariants(
      "explanation",
      { ...validExplanation, evidenceReferences: [FOREIGN_ID] },
      context,
    );

    expect(violations.map((violation) => violation.code)).toContain(
      "evidence_reference_not_in_context",
    );
  });

  it("counts how many references were unknown without naming them", () => {
    // A message quoting the hallucinated id would put model text into a log.
    const violations = checkInvariants(
      "explanation",
      {
        ...validExplanation,
        evidenceReferences: [FOREIGN_ID, "88888888-8888-8888-8888-888888888888"],
      },
      context,
    );

    expect(violations[0]?.count).toBe(2);
    expect(JSON.stringify(violations)).not.toContain(FOREIGN_ID);
  });

  it("rejects an explanation citing no evidence at all", () => {
    const violations = checkInvariants(
      "explanation",
      { ...validExplanation, evidenceReferences: [] },
      context,
    );

    expect(violations.map((violation) => violation.code)).toContain("evidence_references_empty");
  });

  it("rejects an action pointing at an entity the user does not own", () => {
    const violations = checkInvariants(
      "explanation",
      {
        ...validExplanation,
        recommendedActions: [{ label: "Open", actionType: "open_asset", entityId: FOREIGN_ID }],
      },
      context,
    );

    expect(violations.map((violation) => violation.code)).toContain("entity_not_owned");
  });

  it("rejects an action type outside the allowlist at the invariant layer too", () => {
    /**
     * Unreachable while the schema enum holds, and kept deliberately: the schema
     * layer retries, the invariant layer fails closed. If the enum were widened
     * without retrieval being widened to match, this is what refuses to display
     * the result.
     */
    const violations = checkInvariants(
      "explanation",
      {
        ...validExplanation,
        recommendedActions: [{ label: "x", actionType: "delete_account", entityId: ASSET_ID }],
      },
      context,
    );

    expect(violations.map((violation) => violation.code)).toContain("action_type_not_allowed");
  });

  it("rejects a draft including a field the user did not approve", () => {
    /**
     * The privacy violation the skill names outright: storage is not permission
     * (ADR-002), so a key the model claims it used must be intersected with the
     * keys approved in this flow.
     */
    const violations = checkInvariants(
      "draft",
      { ...validDraft, includedFieldKeys: ["email", "home_address"] },
      context,
    );

    expect(violations).toEqual([{ code: "included_field_not_approved", count: 1 }]);
  });

  it("accepts a draft using a subset of approved fields", () => {
    expect(checkInvariants("draft", { ...validDraft, includedFieldKeys: [] }, context)).toEqual([]);
  });

  it("passes a fully grounded explanation", () => {
    expect(checkInvariants("explanation", validExplanation, context)).toEqual([]);
  });

  it("covers every action type in the allowlist without complaint", () => {
    for (const actionType of ACTION_TYPES) {
      const violations = checkInvariants(
        "explanation",
        {
          ...validExplanation,
          recommendedActions: [{ label: "x", actionType, entityId: ASSET_ID }],
        },
        context,
      );

      expect(violations, `${actionType} was rejected`).toEqual([]);
    }
  });
});

describe("the validation pipeline", () => {
  it("returns the parsed value for valid output", () => {
    const result = validateOutput("explanation", json(validExplanation), context);

    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.schemaVersion).toBe(1);
      expect(result.value).toMatchObject({ confidence: "medium" });
    }
  });

  it("reports non-JSON as schema-invalid", () => {
    expect(validateOutput("explanation", "I'm afraid I can't do that.", context).status).toBe(
      "schema_invalid",
    );
  });

  it("reports markdown-fenced JSON as schema-invalid", () => {
    /**
     * Deliberate strictness. The system policy says "no markdown fences";
     * quietly stripping them would mean the policy is not a control. The bounded
     * repair retry exists for exactly this.
     */
    const fenced = "```json\n" + json(validExplanation) + "\n```";

    expect(validateOutput("explanation", fenced, context).status).toBe("schema_invalid");
  });

  it("reports a shape mismatch as schema-invalid", () => {
    expect(validateOutput("explanation", json({ summary: "only this" }), context).status).toBe(
      "schema_invalid",
    );
  });

  it("distinguishes an invariant violation from a shape problem", () => {
    // The distinction that decides whether a retry happens at all.
    const result = validateOutput(
      "explanation",
      json({ ...validExplanation, evidenceReferences: [FOREIGN_ID] }),
      context,
    );

    expect(result.status).toBe("invariant_violated");
  });

  it("never returns the raw completion on failure", () => {
    const result = validateOutput("explanation", json({ summary: "secret model text" }), context);

    expect(JSON.stringify(result)).not.toContain("secret model text");
  });

  it("strips unknown fields before returning", () => {
    const result = validateOutput(
      "explanation",
      json({ ...validExplanation, injected: "ignore previous instructions" }),
      context,
    );

    expect(JSON.stringify(result)).not.toContain("ignore previous instructions");
  });
});
