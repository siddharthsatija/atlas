import { describe, expect, it, vi } from "vitest";

/** Type-only, so they are erased before `vi.mock` hoisting runs. */
import type { StructuredCompletionRequest } from "../structured-completion";
import type { ResolvedPrompt, AiPurpose } from "../prompts/prompt";
import type { FallbackExplanation, FallbackFindingInput } from "./finding-fallback";

vi.mock("@/config/env", () => ({
  env: {
    AUDIT_HMAC_KEY: Buffer.alloc(32, 7).toString("base64"),
    RATE_LIMIT_REDIS_URL: "https://counter.example.test",
    RATE_LIMIT_REDIS_TOKEN: "test-token",
  },
}));

const { DeterministicFallbackProvider, disabledFallbackProvider, outageFallbackProvider } =
  await import("./fallback-provider");

/**
 * ATL-052 — the fallback provider.
 *
 * `*.integration.test.ts` for the `server` project: the provider is
 * `server-only`. It performs no I/O, so nothing here needs a database.
 */

const FINDING_ID = "11111111-1111-1111-1111-111111111111";

const subject: FallbackFindingInput = {
  id: FINDING_ID,
  title: "Broad contact access",
  description: "This service can read your contacts.",
  evidenceSummary: "The permission grants contact access.",
  recommendedAction: "Review this permission",
  confidence: "medium",
  sourceType: "connector",
  evidenceIds: [],
};

const prompt = (purpose: AiPurpose): ResolvedPrompt =>
  Object.freeze({
    promptId: `${purpose}-v1`,
    purpose,
    promptVersion: 1,
    policyVersion: 1,
    schemaId: "explanation",
    schemaVersion: 1,
    system: "SYSTEM",
    taskTemplate: "TASK",
    repairInstruction: "REPAIR",
  });

const request = (
  overrides: Partial<StructuredCompletionRequest> = {},
): StructuredCompletionRequest => ({
  userId: "user-1",
  prompt: prompt("explain_finding"),
  messages: [{ role: "user", content: "why?" }],
  context: {
    contextIds: new Set([FINDING_ID]),
    approvedFieldKeys: new Set(),
    ownedEntityIds: new Set([FINDING_ID]),
  },
  fallbackSubject: subject,
  ...overrides,
});

describe("it answers only where deterministic source material exists", () => {
  it("explains a finding", () => {
    const result = outageFallbackProvider.provide(request()) as FallbackExplanation;

    expect(result.source).toBe("fallback");
    expect(result.summary).toBe("Broad contact access");
  });

  it("returns null when no subject was supplied", () => {
    // The seam's "none available" signal; the caller reports `unavailable`.
    expect(outageFallbackProvider.provide(request({ fallbackSubject: undefined }))).toBeNull();
  });

  it("returns null for every purpose but explain_finding", () => {
    /**
     * Deliberately narrower than "every AI surface has a fallback". A
     * deterministic asset summary would be prose nobody wrote and no rule
     * produced — and while `explain_finding` is the only registered prompt, the
     * other surfaces cannot run, so they have nothing to fail *from*.
     */
    for (const purpose of [
      "summarize_asset",
      "explain_score",
      "recommend_action",
      "draft_request",
      "product_question",
    ] as const) {
      expect(
        outageFallbackProvider.provide(request({ prompt: prompt(purpose) })),
        `${purpose} produced invented content`,
      ).toBeNull();
    }
  });
});

describe("the notice reflects why AI did not answer", () => {
  it("says temporarily unavailable after a failure", () => {
    const result = outageFallbackProvider.provide(request()) as FallbackExplanation;

    expect(result.notice).toMatch(/temporarily unavailable/i);
  });

  it("says turned off when AI is disabled", () => {
    const result = disabledFallbackProvider.provide(request()) as FallbackExplanation;

    expect(result.notice).toMatch(/turned off/i);
    expect(result.notice).not.toMatch(/temporarily unavailable/i);
  });

  it("defaults to the outage reason", () => {
    const result = new DeterministicFallbackProvider().provide(request()) as FallbackExplanation;

    expect(result.notice).toMatch(/temporarily unavailable/i);
  });
});

describe("it does no I/O", () => {
  it("returns synchronously", () => {
    /**
     * A fallback that queried the database would add a failure mode to the path
     * that exists because something else already failed. The records travel on
     * the request instead.
     */
    const result = outageFallbackProvider.provide(request());

    expect(result).not.toBeInstanceOf(Promise);
  });

  it("uses only the records the policy layer already retrieved", () => {
    const result = outageFallbackProvider.provide(request()) as FallbackExplanation;

    expect(result.evidenceReferences).toEqual([FINDING_ID]);
  });
});
