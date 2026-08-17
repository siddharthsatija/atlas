import { describe, expect, it, vi } from "vitest";

/** Type-only, so they are erased before `vi.mock` hoisting runs. */
import type { AiPolicyRequest } from "../policy/ai-policy-service";
import type { AiCompletionRequest } from "../gateway";
import type { AiConversationHistory } from "./conversation-history";

vi.mock("@/config/env", () => ({
  env: {
    AUDIT_HMAC_KEY: Buffer.alloc(32, 9).toString("base64"),
    RATE_LIMIT_REDIS_URL: "https://counter.example.test",
    RATE_LIMIT_REDIS_TOKEN: "test-token",
  },
}));

const { AiPolicyService } = await import("../policy/ai-policy-service");
const { StructuredCompletionService } = await import("../structured-completion");
const { anchorFor, noopConversationHistory } = await import("./conversation-history");

/**
 * ATL-109 — where the conversation layer joins the request pipeline.
 *
 * The database behaviour lives in `tests/integration/ai-history-service.test.ts`,
 * which needs Postgres. What is settled here is the *wiring*, and the properties
 * that make it additive rather than a change to how Atlas answers:
 *
 *   1. History is consulted only after an answer has been validated.
 *   2. A fallback is not filed as something the assistant said.
 *   3. A storage failure never costs the person their answer.
 *   4. Nothing is stored when history is not wired at all.
 */

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET_A = "11111111-1111-4111-8111-111111111111";
const FINDING_ID = "ffff1111-1111-4111-8111-111111111111";

interface Recorded {
  userId: string;
  anchor: { contextType: string; entityId: string | null };
  turns: readonly { role: string; content: string }[];
}

/** Captures what would have been stored, without storing anything. */
function recordingHistory(): { history: AiConversationHistory; stored: Recorded[] } {
  const stored: Recorded[] = [];
  return {
    stored,
    history: {
      append: (userId, anchor, turns) => {
        stored.push({ userId, anchor, turns });
        return Promise.resolve({ stored: true, conversationId: "conversation-1" });
      },
    },
  };
}

const failingHistory: AiConversationHistory = {
  append: () => Promise.reject(new Error("storage is down")),
};

function build(options: {
  history?: AiConversationHistory;
  modelOutput?: string;
  gatewayThrows?: boolean;
}) {
  const completion = new StructuredCompletionService({
    gateway: {
      complete: (_input: AiCompletionRequest) => {
        if (options.gatewayThrows) return Promise.reject(new Error("provider unreachable"));
        return Promise.resolve({
          text:
            options.modelOutput ??
            JSON.stringify({
              summary: "A summary.",
              evidenceReferences: [ASSET_A],
              uncertainties: [],
            }),
          model: "test-model",
          attempts: 1,
          latencyMs: 1,
        });
      },
    },
    fallback: { provide: () => null },
  });

  return new AiPolicyService({
    consent: { hasConsent: () => Promise.resolve(true) } as never,
    findings: {
      getFindingDetail: () => Promise.resolve({ ok: false as const, code: "NOT_FOUND" }),
      listFindings: () => Promise.resolve({ ok: true as const, data: [] }),
    } as never,
    assets: {
      listAssetDetails: () =>
        Promise.resolve({
          ok: true as const,
          data: {
            asset: {
              id: ASSET_A,
              serviceName: "Alice Bank",
              category: "finance",
              status: "active",
            },
            dataCategories: [],
            permissions: [],
          },
        }),
    } as never,
    completion,
    ...(options.history === undefined ? {} : { history: options.history }),
  });
}

const ask = (overrides: Partial<AiPolicyRequest> = {}): AiPolicyRequest => ({
  userId: ALICE,
  purpose: "summarize_asset",
  subjectId: ASSET_A,
  userMessage: "What does this service hold?",
  ...overrides,
});

describe("anchorFor", () => {
  it("files a finding explanation under its finding", () => {
    expect(anchorFor("explain_finding", FINDING_ID)).toEqual({
      contextType: "finding",
      entityId: FINDING_ID,
    });
  });

  it("files an asset summary under its asset", () => {
    expect(anchorFor("summarize_asset", ASSET_A)).toEqual({
      contextType: "asset",
      entityId: ASSET_A,
    });
  });

  it.each(["explain_score", "recommend_action", "draft_request"] as const)(
    "files %s globally, with no entity",
    (purpose) => {
      expect(anchorFor(purpose, undefined)).toEqual({ contextType: "global", entityId: null });
    },
  );

  it("never produces the request context type, which has no producer yet", () => {
    /**
     * `request` is in §7.18 and in the migration's check constraint, but request
     * surfaces are M8. Mapping `draft_request` to it would claim an anchor to a
     * `data_requests` row that cannot exist, and the anchor constraint requires
     * an entity id this purpose has no way to supply.
     */
    const purposes = [
      "explain_finding",
      "summarize_asset",
      "explain_score",
      "recommend_action",
      "draft_request",
      "product_question",
    ] as const;

    for (const purpose of purposes) {
      expect(anchorFor(purpose, ASSET_A).contextType).not.toBe("request");
    }
  });

  it("falls back to global rather than throwing when a subject is missing", () => {
    expect(anchorFor("summarize_asset", undefined)).toEqual({
      contextType: "global",
      entityId: null,
    });
  });
});

describe("history is consulted only after a validated answer", () => {
  it("stores the exchange when the answer validated", async () => {
    const { history, stored } = recordingHistory();
    const result = await build({ history }).answer(ask());

    expect(result.status).toBe("answered");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.userId).toBe(ALICE);
    expect(stored[0]?.anchor).toEqual({ contextType: "asset", entityId: ASSET_A });
  });

  it("stores the question and the answer, in that order", async () => {
    const { history, stored } = recordingHistory();
    await build({ history }).answer(ask());

    expect(stored[0]?.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(stored[0]?.turns[0]?.content).toBe("What does this service hold?");
  });

  it("stores the validated output verbatim rather than a chosen field", async () => {
    const { history, stored } = recordingHistory();
    await build({ history }).answer(ask());

    const assistant = stored[0]?.turns[1]?.content ?? "";
    expect(JSON.parse(assistant)).toEqual({
      summary: "A summary.",
      evidenceReferences: [ASSET_A],
      uncertainties: [],
    });
  });

  it("omits the user turn when the surface asked no question", async () => {
    /**
     * A button-triggered ask carries no question (ATL-055). Manufacturing one
     * would put words in the person's mouth in their own transcript.
     */
    const { history, stored } = recordingHistory();
    await build({ history }).answer(ask({ userMessage: undefined }));

    expect(stored[0]?.turns.map((turn) => turn.role)).toEqual(["assistant"]);
  });

  it("treats a whitespace-only question as absent", async () => {
    const { history, stored } = recordingHistory();
    await build({ history }).answer(ask({ userMessage: "   " }));

    expect(stored[0]?.turns.map((turn) => turn.role)).toEqual(["assistant"]);
  });

  it("stores nothing when the output failed validation", async () => {
    const { history, stored } = recordingHistory();
    const result = await build({ history, modelOutput: "not json" }).answer(ask());

    expect(result.status).not.toBe("answered");
    expect(stored).toEqual([]);
  });

  it("stores nothing when the answer came from the fallback", async () => {
    /**
     * A fallback is Atlas's own deterministic text, not something the assistant
     * said. Filing it as an assistant turn would make the transcript describe a
     * conversation that did not happen.
     */
    const { history, stored } = recordingHistory();
    await build({ history, gatewayThrows: true }).answer(
      ask({ purpose: "explain_finding", subjectId: FINDING_ID }),
    );

    expect(stored).toEqual([]);
  });
});

describe("history never affects the answer", () => {
  it("still answers when storage throws", async () => {
    const result = await build({ history: failingHistory }).answer(ask());

    expect(result.status).toBe("answered");
  });

  it("answers identically with no history wired at all", async () => {
    const withNoop = await build({ history: noopConversationHistory }).answer(ask());
    const withNothing = await build({}).answer(ask());

    expect(withNoop).toEqual(withNothing);
    expect(withNothing.status).toBe("answered");
  });
});
