import { describe, expect, it, vi } from "vitest";

/** Type-only, so they are erased before `vi.mock` hoisting runs. */
import type { AiPolicyRequest } from "./ai-policy-service";
import type { InteractionRecord, AiInteractionRecorder } from "../interaction-recorder";
import type { AiCompletion, AiCompletionRequest, AiGateway } from "../gateway";
import type { FallbackExplanation } from "../fallback/finding-fallback";

vi.mock("@/config/env", () => ({
  env: {
    AUDIT_HMAC_KEY: Buffer.alloc(32, 7).toString("base64"),
    RATE_LIMIT_REDIS_URL: "https://counter.example.test",
    RATE_LIMIT_REDIS_TOKEN: "test-token",
  },
}));

const { AiPolicyService } = await import("./ai-policy-service");
const { StructuredCompletionService } = await import("../structured-completion");
const { outageFallbackProvider } = await import("../fallback/fallback-provider");
const { EVAL_RULES } = await import("../evals/cases");
const { runEvals } = await import("../evals/harness");

/**
 * ATL-055 — grounding and hallucination probes for finding explanations.
 *
 * Unlike the ATL-049 suite, which stubs the completion service, this wires the
 * **real** `StructuredCompletionService` — real schema validation, real
 * invariant checks, real fallback — behind a scripted gateway. That is what
 * makes these grounding tests rather than tests of a stub: a hallucinated
 * reference has to survive the actual pipeline to reach a caller, and here it
 * does not.
 *
 * No provider access (B4). Live-model probes stay in ATL-051's documented
 * pre-release step; what runs in CI is fixture-driven and deterministic.
 */

const FINDING_ID = "11111111-1111-1111-1111-111111111111";
const ASSET_ID = "22222222-2222-2222-2222-222222222222";
const FOREIGN_ID = "99999999-9999-9999-9999-999999999999";

const findingRecord = {
  id: FINDING_ID,
  assetId: ASSET_ID,
  title: "Broad contact access",
  description: "This service can read your contacts.",
  severity: "high",
  confidence: "medium",
  evidenceSummary: "The permission grants contact access.",
  recommendedAction: "Review this permission",
  sourceType: "connector",
  impactedAsset: "Example Service",
  evidenceRecords: [{ id: ASSET_ID, kind: "asset", label: "Example Service", href: null }],
};

/** A well-formed, fully grounded explanation. */
const groundedExplanation = {
  summary: "Based on the information saved in Atlas, this service can read your contacts.",
  whyItMatters: "This may matter because contact access continues until you revoke it.",
  evidenceReferences: [FINDING_ID],
  confidence: "medium",
  uncertainties: ["Atlas could not verify when the permission was last used."],
  recommendedActions: [
    { label: "Review this permission", actionType: "review_permission", entityId: ASSET_ID },
  ],
};

const json = (value: unknown) => JSON.stringify(value);

/**
 * The whole pipeline with a scripted model: policy layer → structured
 * completion → schema → invariants → fallback.
 */
function build(modelOutputs: string[], finding: Record<string, unknown> = findingRecord) {
  const rows: InteractionRecord[] = [];
  const calls: AiCompletionRequest[] = [];
  let index = 0;

  const recorder: AiInteractionRecorder = {
    record: (interaction) => {
      rows.push(interaction);
      // Task #109: the recorder returns the row id it wrote.
      return Promise.resolve(`row-${rows.length}`);
    },
  };

  const gateway: AiGateway = {
    complete: (input: AiCompletionRequest): Promise<AiCompletion> => {
      calls.push(input);
      const text = modelOutputs[Math.min(index, modelOutputs.length - 1)] ?? "";
      index += 1;
      return Promise.resolve({ text, model: "test-model", attempts: 1, latencyMs: 1 });
    },
  };

  const service = new AiPolicyService({
    consent: { hasConsent: () => Promise.resolve(true) } as never,
    /** Required since ATL-054; unused here, so it refuses rather than pretends. */
    assets: {
      listAssetDetails: () => Promise.resolve({ ok: false as const, code: "NOT_FOUND" }),
    } as never,
    findings: {
      getFindingDetail: () => Promise.resolve({ ok: true as const, data: finding }),
      listFindings: () => Promise.resolve({ ok: true as const, data: [] }),
    } as never,
    completion: new StructuredCompletionService({
      gateway,
      fallback: outageFallbackProvider,
      recorder,
    }),
    recorder,
  });

  return { service, rows, calls };
}

const request = (overrides: Partial<AiPolicyRequest> = {}): AiPolicyRequest => ({
  userId: "user-1",
  purpose: "explain_finding",
  subjectId: FINDING_ID,
  ...overrides,
});

describe("a grounded explanation reaches the caller", () => {
  it("returns the validated explanation from the AI", async () => {
    const { service } = build([json(groundedExplanation)]);

    const result = await service.answer(request());

    expect(result.status).toBe("answered");
    if (result.status === "answered") expect(result.source).toBe("ai");
  });

  it("preserves model confidence and uncertainties exactly as the schema defines", async () => {
    /**
     * B2: no rendering decision here, but the values must survive the pipeline
     * intact so ATL-053 has something truthful to render.
     */
    const { service } = build([json(groundedExplanation)]);

    const result = await service.answer(request());

    if (result.status === "answered") {
      expect(result.value).toMatchObject({
        confidence: "medium",
        uncertainties: ["Atlas could not verify when the permission was last used."],
      });
    }
  });

  it("cites only references that were in the context sent", async () => {
    const { service, calls } = build([json(groundedExplanation)]);

    const result = await service.answer(request());

    const sent = calls[0]?.messages[0]?.content ?? "";
    if (result.status === "answered") {
      const cited = (result.value as { evidenceReferences: string[] }).evidenceReferences;
      for (const reference of cited) {
        expect(sent, `${reference} was cited but never sent`).toContain(reference);
      }
    }
  });

  it("records one validated interaction", async () => {
    const { service, rows } = build([json(groundedExplanation)]);
    await service.answer(request());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("validated");
  });
});

describe("hallucination probes fail closed", () => {
  it("rejects an explanation citing a record that was never sent", async () => {
    /**
     * The core hallucination case: correctly shaped output about a record
     * nobody supplied. It must not reach the caller, and it must not be retried
     * — asking again does not make an invented citation true.
     */
    const { service, calls } = build([
      json({ ...groundedExplanation, evidenceReferences: [FOREIGN_ID] }),
    ]);

    const result = await service.answer(request());

    /**
     * Note the shape of the guarantee. Before ATL-052 this would have been
     * `unavailable`; now the deterministic fallback answers instead, so the user
     * gets rule-derived text rather than nothing. The hallucination is still
     * refused — what changed is what replaces it.
     */
    expect(result.status).toBe("answered");
    if (result.status === "answered") expect(result.source).toBe("fallback");

    // Not retried: asking again does not make an invented citation true.
    expect(calls).toHaveLength(1);
  });

  it("never returns the hallucinated identifier to the caller", async () => {
    const { service } = build([json({ ...groundedExplanation, evidenceReferences: [FOREIGN_ID] })]);

    const result = await service.answer(request());

    expect(json(result)).not.toContain(FOREIGN_ID);
  });

  it("rejects an action pointing at an entity the user does not own", async () => {
    const { service } = build([
      json({
        ...groundedExplanation,
        recommendedActions: [{ label: "Open", actionType: "open_asset", entityId: FOREIGN_ID }],
      }),
    ]);

    const result = await service.answer(request());

    expect(result.status).toBe("answered");
    if (result.status === "answered") expect(result.source).toBe("fallback");
  });

  it("rejects an action type outside the allowlist", async () => {
    // A model proposing `delete_account` must never reach a surface that could
    // render it as an offered action.
    const { service } = build([
      json({
        ...groundedExplanation,
        recommendedActions: [
          { label: "Delete it", actionType: "delete_account", entityId: ASSET_ID },
        ],
      }),
    ]);

    const result = await service.answer(request());

    expect(result.status).toBe("answered");
    if (result.status === "answered") expect(result.source).toBe("fallback");
  });

  it("rejects an explanation citing nothing at all", async () => {
    // Ungrounded by construction: ATL-050 treats an empty evidence list as a
    // violation rather than a stylistic choice.
    const { service } = build([json({ ...groundedExplanation, evidenceReferences: [] })]);

    const result = await service.answer(request());

    expect(result.status).toBe("answered");
    if (result.status === "answered") expect(result.source).toBe("fallback");
  });

  it("records the failure without recording the invented content", async () => {
    const { service, rows } = build([
      json({ ...groundedExplanation, evidenceReferences: [FOREIGN_ID] }),
    ]);

    await service.answer(request());

    expect(rows).toHaveLength(1);
    expect(json(rows)).not.toContain(FOREIGN_ID);
    expect(json(rows)).not.toContain(groundedExplanation.summary);
  });
});

describe("no new factual claims beyond the provided context", () => {
  /**
   * The prohibited-claim rules from ATL-051's harness, applied to explanation
   * fixtures. Assertion-based and provider-free, so they run in CI (B4); the
   * judgement-based half stays in the pre-release step.
   */
  const graded = (output: unknown) =>
    runEvals({
      cases: [
        {
          id: "atl055/probe",
          promptId: "explain-finding-v1",
          description: "ATL-055 grounding probe",
          output: json(output),
          rules: EVAL_RULES.map((rule) => rule.id),
        },
      ],
      rules: EVAL_RULES,
      requiredPromptIds: [],
    });

  it("passes a grounded explanation", () => {
    expect(graded(groundedExplanation).failures).toEqual([]);
  });

  it("catches a claim that Atlas scanned or discovered something", () => {
    const report = graded({
      ...groundedExplanation,
      summary: "We scanned the web and found your address on three broker sites.",
    });

    expect(report.failures.map((failure) => failure.ruleId)).toContain("no-scanning-claim");
  });

  it("catches a claim that an action already happened", () => {
    const report = graded({
      ...groundedExplanation,
      summary: "I deleted your data from that service.",
    });

    expect(report.failures.map((failure) => failure.ruleId)).toContain("no-action-claim");
  });

  it("catches an unsupported legal guarantee", () => {
    const report = graded({
      ...groundedExplanation,
      whyItMatters: "Deletion is legally guaranteed within 30 days.",
    });

    expect(report.failures.map((failure) => failure.ruleId)).toContain("no-legal-guarantee");
  });

  it("catches fear language", () => {
    const report = graded({
      ...groundedExplanation,
      whyItMatters: "You are in danger and you must act now.",
    });

    expect(report.failures.map((failure) => failure.ruleId)).toContain("no-fear-language");
  });
});

describe("demo and stale disclosures reach the model", () => {
  it("labels a demo finding as demo in the context", async () => {
    const { service, calls } = build([json(groundedExplanation)], {
      ...findingRecord,
      sourceType: "demo",
    });

    await service.answer(request());

    expect(calls[0]?.messages[0]?.content).toContain("[Demo]");
  });

  it("labels a low-confidence finding as potentially stale", async () => {
    const { service, calls } = build([json(groundedExplanation)], {
      ...findingRecord,
      confidence: "low",
    });

    await service.answer(request());

    expect(calls[0]?.messages[0]?.content).toContain("[Potentially stale]");
  });
});

describe("the deterministic fallback stays confidence-free", () => {
  it("substitutes deterministic text after two schema failures", async () => {
    const { service } = build(["not json", "still not json"]);

    const result = await service.answer(request());

    expect(result.status).toBe("answered");
    if (result.status === "answered") expect(result.source).toBe("fallback");
  });

  it("carries no model confidence field", async () => {
    /**
     * The rule this ticket preserves. A deterministic explanation has no model,
     * so a `confidence` field would be fabricated — and inheriting the finding's
     * rule confidence would put a different quantity under the same name.
     */
    const { service } = build(["not json", "still not json"]);

    const result = await service.answer(request());

    if (result.status === "answered") {
      expect(result.value).not.toHaveProperty("confidence");
      expect((result.value as FallbackExplanation).source).toBe("fallback");
    }
  });

  it("still cites only records from the finding", async () => {
    const { service } = build(["not json", "still not json"]);

    const result = await service.answer(request());

    if (result.status === "answered") {
      expect((result.value as FallbackExplanation).evidenceReferences).toEqual([
        FINDING_ID,
        ASSET_ID,
      ]);
    }
  });

  it("discloses demo data deterministically too", async () => {
    const { service } = build(["not json", "still not json"], {
      ...findingRecord,
      sourceType: "demo",
    });

    const result = await service.answer(request());

    if (result.status === "answered") {
      expect((result.value as FallbackExplanation).disclosures.join(" ")).toMatch(/demo data/i);
    }
  });
});
