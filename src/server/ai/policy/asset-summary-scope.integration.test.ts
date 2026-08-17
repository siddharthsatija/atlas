import { describe, expect, it, vi } from "vitest";

/** Type-only, erased before `vi.mock` hoisting. */
import type { AiPolicyRequest } from "./ai-policy-service";
import type { AiCompletionRequest } from "../gateway";

vi.mock("@/config/env", () => ({
  env: {
    AUDIT_HMAC_KEY: Buffer.alloc(32, 3).toString("base64"),
    RATE_LIMIT_REDIS_URL: "https://counter.example.test",
    RATE_LIMIT_REDIS_TOKEN: "test-token",
  },
}));

const { AiPolicyService } = await import("./ai-policy-service");
const { StructuredCompletionService } = await import("../structured-completion");

/**
 * ATL-054 — asset-scoped retrieval, proven adversarially.
 *
 * The acceptance criterion is "retrieval scoped to it (policy-layer enforced,
 * tested)", and the interesting word is *enforced*. A test that simply asks for
 * asset A and checks asset A came back proves the happy path and nothing about
 * scope. These instead try to get asset B out, the two ways a user actually
 * could: by asking for it in prose, and by naming someone else's id.
 *
 * What is asserted is the **assembled context**, captured at the gateway — the
 * exact bytes leaving Atlas. Asserting on the model's answer would only prove
 * what a stubbed model chose to say.
 */

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ASSET_A = "11111111-1111-4111-8111-111111111111";
const ASSET_B = "22222222-2222-4222-8222-222222222222";
const BOB_ASSET = "33333333-3333-4333-8333-333333333333";

const CATEGORY_A = "aaaa1111-1111-4111-8111-111111111111";
const CATEGORY_B = "bbbb2222-2222-4222-8222-222222222222";
const PERMISSION_A = "cccc1111-1111-4111-8111-111111111111";

/** Alice owns A and B. Bob owns his own. The store knows all three. */
const OWNED = {
  [ASSET_A]: {
    userId: ALICE,
    asset: { id: ASSET_A, serviceName: "Alice Bank", category: "finance", status: "active" },
    dataCategories: [{ id: CATEGORY_A, category: "financial", sensitivity: "high" }],
    permissions: [
      { id: PERMISSION_A, permissionType: "data_sharing", scope: "broad", status: "active" },
    ],
  },
  [ASSET_B]: {
    userId: ALICE,
    asset: { id: ASSET_B, serviceName: "Alice Streaming", category: "media", status: "active" },
    dataCategories: [{ id: CATEGORY_B, category: "behavioral", sensitivity: "standard" }],
    permissions: [],
  },
  [BOB_ASSET]: {
    userId: BOB,
    asset: { id: BOB_ASSET, serviceName: "Bob Bank", category: "finance", status: "active" },
    dataCategories: [],
    permissions: [],
  },
} as const;

/**
 * Stands in for `AssetService`, enforcing ownership the way the real one does —
 * a row is returned only when the requesting user owns it.
 */
const assets = {
  listAssetDetails: (userId: string, assetId: string) => {
    const record = OWNED[assetId as keyof typeof OWNED] as
      (typeof OWNED)[keyof typeof OWNED] | undefined;

    return Promise.resolve(
      record && record.userId === userId
        ? { ok: true as const, data: record }
        : { ok: false as const, code: "NOT_FOUND" as const },
    );
  },
};

/** Captures what actually reached the provider. */
function serviceCapturing(sent: AiCompletionRequest[]) {
  const completion = new StructuredCompletionService({
    gateway: {
      complete: (input: AiCompletionRequest) => {
        sent.push(input);
        return Promise.resolve({
          text: JSON.stringify({
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
    assets: assets as never,
    completion,
  });
}

/**
 * Everything that left Atlas for the provider, as one string.
 *
 * The context block is assembled into the message content, so asserting on the
 * whole payload is what proves an identifier was never sent — checking one field
 * would leave the others unexamined.
 */
const sentText = (sent: AiCompletionRequest[]): string =>
  JSON.stringify(sent.map((request) => request.messages));

const ask = (overrides: Partial<AiPolicyRequest> = {}): AiPolicyRequest => ({
  userId: ALICE,
  purpose: "summarize_asset",
  subjectId: ASSET_A,
  ...overrides,
});

describe("the subject id is the whole scope", () => {
  it("sends the subject asset with its own categories and permissions", async () => {
    const sent: AiCompletionRequest[] = [];

    await serviceCapturing(sent).answer(ask());

    const context = sentText(sent);
    expect(context).toContain(ASSET_A);
    expect(context).toContain(CATEGORY_A);
    expect(context).toContain(PERMISSION_A);
  });

  /**
   * The adversarial case. Alice owns both assets, so nothing about ownership
   * stops B — only the retrieval scope does.
   */
  it("ignores prose asking for a second asset the user does own", async () => {
    const sent: AiCompletionRequest[] = [];

    await serviceCapturing(sent).answer(
      ask({
        userMessage:
          "Also tell me everything about my Alice Streaming account and what it collects.",
      }),
    );

    const context = sentText(sent);

    /**
     * Neither the other asset nor anything hanging off it was fetched.
     *
     * Asserted on **identifiers and retrieved field values**, not on the service
     * name. The name appears in the payload because the user typed it into the
     * question, and the question is relayed by design — treating that as leakage
     * would be asserting that Atlas may not repeat what the user said. What
     * matters is that nothing about asset B was *retrieved*: its id, its
     * category row's id, and the category value only a fetch could supply.
     */
    expect(context).not.toContain(ASSET_B);
    expect(context).not.toContain(CATEGORY_B);
    expect(context).not.toContain("behavioral");

    /** The subject is still there — the request was answered, not refused. */
    expect(context).toContain(ASSET_A);
  });

  it("carries the user's words without letting them widen retrieval", async () => {
    const sent: AiCompletionRequest[] = [];

    await serviceCapturing(sent).answer(
      ask({ userMessage: "Compare this with my other account." }),
    );

    /**
     * The message reaches the model — it is the question. What it cannot do is
     * change what was fetched, which is the distinction ATL-054 turns on.
     */
    expect(sentText(sent)).toContain("Compare this with my other account");
    expect(sentText(sent)).not.toContain(ASSET_B);
  });
});

describe("another user's asset", () => {
  it("answers not_found", async () => {
    const sent: AiCompletionRequest[] = [];

    const result = await serviceCapturing(sent).answer(ask({ subjectId: BOB_ASSET }));

    expect(result.status).toBe("not_found");
  });

  it("assembles no context and calls no provider", async () => {
    const sent: AiCompletionRequest[] = [];

    await serviceCapturing(sent).answer(ask({ subjectId: BOB_ASSET }));

    /** Refused before retrieval, so nothing of Bob's was read, let alone sent. */
    expect(sent).toHaveLength(0);
  });

  it("is indistinguishable from an asset that does not exist", async () => {
    const sent: AiCompletionRequest[] = [];
    const service = serviceCapturing(sent);

    const foreign = await service.answer(ask({ subjectId: BOB_ASSET }));
    const missing = await service.answer(
      ask({ subjectId: "99999999-9999-4999-8999-999999999999" }),
    );

    expect(foreign.status).toBe(missing.status);
  });
});

describe("what this purpose may never include", () => {
  it("sends no finding, whatever the user asks", async () => {
    const sent: AiCompletionRequest[] = [];

    await serviceCapturing(sent).answer(ask({ userMessage: "What findings does this have?" }));

    /**
     * `maxFindings: 0` in the policy map; `finding` is not a permitted kind for
     * this purpose. Asserted on the **context entry marker** rather than the
     * bare word, which the user's own question contains — the entry format is
     * `- <kind> [<provenance>] id=…`, so this is what a retrieved finding would
     * actually look like.
     */
    expect(sentText(sent)).not.toContain("- finding [");
  });

  it("refuses when no subject is named", async () => {
    const sent: AiCompletionRequest[] = [];

    const result = await serviceCapturing(sent).answer(ask({ subjectId: undefined }));

    expect(result.status).toBe("not_found");
    expect(sent).toHaveLength(0);
  });
});
