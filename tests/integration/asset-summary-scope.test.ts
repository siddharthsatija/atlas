import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.generated";
import { AssetService } from "@/server/assets/asset-service";
import { ConsentService } from "@/server/consent/consent-service";
import { FindingService } from "@/server/findings/finding-service";
import { AiPolicyService } from "@/server/ai/policy/ai-policy-service";
import { StructuredCompletionService } from "@/server/ai/structured-completion";
import { assembleContextBlock, type ContextEntry } from "@/server/ai/policy/context-assembly";
import type { AiCompletionRequest } from "@/server/ai/gateway";

/**
 * ATL-054 M4 — asset-summary scope, against a real database.
 *
 * ## What this proves that the unit suite cannot
 *
 * `asset-summary-scope.integration.test.ts` runs the same adversarial cases
 * against an `AssetService` double that enforces ownership *because the double
 * was written to*. That proves the policy layer respects a correct service. It
 * cannot prove the real service is correct, and the real one runs as
 * `service_role`, which **bypasses RLS** — so the row-level policies that protect
 * every other read are not the control here. Ownership is a `user_id` predicate
 * in the repository, and a predicate that was dropped would still type-check,
 * still pass every unit test, and quietly return another user's service.
 *
 * These use the real `AiPolicyService`, the real `AssetService`, and real rows
 * belonging to two real users. Only the provider is a double, because the
 * assertion is about **what leaves Atlas**, and capturing that at the gateway is
 * the last point where it is still Atlas's own bytes.
 *
 * ## Not a duplicate of the table RLS suites
 *
 * `digital-assets-rls.test.ts`, `asset-data-categories-rls.test.ts` and
 * `asset-permissions-rls.test.ts` assert that an *anon* client scoped to one user
 * cannot read another's rows. That is a different control at a different layer,
 * and it does not run on this path at all. Nothing here weakens or restates them.
 *
 * Requires a running local Supabase (`pnpm db:start`). Fails rather than skips
 * when the database is absent — a skipped authorization test reads identically to
 * a passing one.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

type TypedClient = SupabaseClient<Database>;

let admin: TypedClient;
let aliceId: string;
let bobId: string;

/** Alice's two services, so "her own other asset" is a real row and not a gap. */
let aliceBankId: string;
let aliceStreamingId: string;
let aliceStreamingCategoryId: string;

/** Bob's service. Never Alice's to see. */
let bobBankId: string;

const BOB_SERVICE_NAME = "Bob Private Bank";
const ALICE_STREAMING_NAME = "Alice Streaming";

async function createUser(label: string): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email: `atl054-${label}-${Date.now()}@example.test`,
    password: `Fixture-${label}-${Date.now()}`,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`Could not create ${label}: ${created.error?.message ?? "no user"}`);
  }
  return created.data.user.id;
}

/** Everything the provider was asked to complete, as one string. */
const sentText = (sent: AiCompletionRequest[]): string =>
  JSON.stringify(sent.map((request) => request.messages));

/**
 * One assembled context entry: `- <kind> [<provenance>] id=<id> — <fields>`.
 *
 * Mirrors the line `context-assembly.ts` emits. The lazy `.+?` skips the kind and
 * provenance without assuming their contents, and `\S+` stops at the space before
 * the em dash that introduces the fields. No `g` flag, so there is no `lastIndex`
 * to carry between calls.
 */
const CONTEXT_ENTRY = /^- .+? id=(\S+)/m;

/**
 * The first record id actually present in what was sent.
 *
 * ## Why the double parses instead of being told
 *
 * This fixture previously cited a hardcoded id, and the positive control for the
 * *second* user failed because that id was never in his context — the invariant
 * layer correctly refused to display an answer citing another user's asset. The
 * lesson is not "tell the double the right id per test": that just relocates the
 * hardcoding and traps the next person who adds a subject.
 *
 * A real model can only cite what it was given. Deriving the citation from the
 * context block makes the double obey the same constraint, so it is grounded by
 * construction for **any** subject, and no test needs a branch naming a user.
 *
 * ## It throws rather than degrading
 *
 * Returning `[]` on a miss would produce `evidence_references_empty` instead —
 * still a violation, still `unavailable`, but now the failure looks like a
 * product bug when it is a fixture that lost its grip on the context format.
 * Fabricating a plausible id would be worse: the suite would go green while
 * proving nothing about grounding. Throwing names the real problem at the point
 * it occurs.
 */
function citeableIdFrom(request: AiCompletionRequest): string {
  const sentToProvider = [request.system, ...request.messages.map((message) => message.content)];

  const cited = CONTEXT_ENTRY.exec(sentToProvider.join("\n"))?.[1];

  if (cited === undefined) {
    throw new Error(
      "The scripted provider found no citeable id in the context it was sent. " +
        "Either retrieval sent no records, or the context entry format in " +
        "context-assembly.ts changed and this fixture no longer matches it.",
    );
  }

  return cited;
}

/**
 * The real policy layer, wired to the real services, with the provider captured.
 *
 * `fallback` returns null so a failure surfaces as a failure. A deterministic
 * fallback here would turn a retrieval bug into a plausible-looking answer, which
 * is the one outcome these tests must never mistake for success.
 */
function policyCapturing(sent: AiCompletionRequest[]): AiPolicyService {
  const completion = new StructuredCompletionService({
    gateway: {
      complete: (input: AiCompletionRequest) => {
        sent.push(input);
        return Promise.resolve({
          text: JSON.stringify({
            summary: "A summary.",
            /** Grounded by construction — see `citeableIdFrom`. */
            evidenceReferences: [citeableIdFrom(input)],
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
    consent: new ConsentService(admin),
    findings: new FindingService(admin),
    assets: new AssetService(admin),
    completion,
  });
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-054 scope tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  aliceId = await createUser("alice");
  bobId = await createUser("bob");

  /** Consent is checked before retrieval, so without it every case is masked. */
  const consent = new ConsentService(admin);
  await consent.grant(aliceId, "ai_processing");
  await consent.grant(bobId, "ai_processing");

  const assets = new AssetService(admin);

  const aliceBank = await assets.createAsset(aliceId, {
    serviceName: "Alice Bank",
    category: "finance",
  });
  if (!aliceBank.ok) throw new Error("Could not seed Alice's bank");
  aliceBankId = aliceBank.data.id;

  const aliceStreaming = await assets.createAsset(aliceId, {
    serviceName: ALICE_STREAMING_NAME,
    category: "entertainment",
  });
  if (!aliceStreaming.ok) throw new Error("Could not seed Alice's streaming service");
  aliceStreamingId = aliceStreaming.data.id;

  /**
   * A category on the *other* asset, so "asset B's records" is something that
   * genuinely exists. Without it the leakage assertions would pass trivially.
   */
  const streamingCategory = await assets.addDataCategory(aliceId, aliceStreamingId, "behavioral");
  if (!streamingCategory.ok) throw new Error("Could not seed the streaming category");
  aliceStreamingCategoryId = streamingCategory.data.id;

  await assets.addDataCategory(aliceId, aliceBankId, "financial");
  await assets.addPermission(aliceId, aliceBankId, "data_sharing", "broad");

  const bobBank = await assets.createAsset(bobId, {
    serviceName: BOB_SERVICE_NAME,
    category: "finance",
  });
  if (!bobBank.ok) throw new Error("Could not seed Bob's bank");
  bobBankId = bobBank.data.id;

  await assets.addDataCategory(bobId, bobBankId, "financial");
});

afterAll(async () => {
  if (!admin) return;
  for (const id of [aliceId, bobId]) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
});

/**
 * The double's own contract.
 *
 * Asserted against blocks built by the **real** `assembleContextBlock`, not by a
 * hand-written string. A hand-written fixture would keep passing after the
 * production format changed, which is the exact failure mode this helper exists
 * to make loud.
 */
describe("the scripted provider only cites what it was sent", () => {
  const asRequest = (content: string): AiCompletionRequest => ({
    userId: "not-sent-to-the-provider",
    system: "system instructions",
    messages: [{ role: "user", content }],
  });

  const entry = (id: string, kind: string): ContextEntry => ({
    id,
    kind,
    provenance: "user_provided",
    fields: { name: "A service" },
  });

  it("cites the first entry in the block", () => {
    const block = assembleContextBlock([
      entry("11111111-1111-4111-8111-111111111111", "asset"),
      entry("22222222-2222-4222-8222-222222222222", "asset_categories"),
    ]);

    /** The subject is always the first entry for `summarize_asset`. */
    expect(citeableIdFrom(asRequest(block))).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("throws rather than citing nothing when no records were retrieved", () => {
    /**
     * `assembleContextBlock([])` emits a "no records" line with no `id=`. Left
     * to degrade, this would surface as `evidence_references_empty` and read
     * like a product bug; throwing names the fixture as the problem.
     */
    expect(() => citeableIdFrom(asRequest(assembleContextBlock([])))).toThrow(/no citeable id/i);
  });

  it("throws rather than fabricating an id when the format no longer matches", () => {
    expect(() => citeableIdFrom(asRequest("Summarise this service."))).toThrow(/no citeable id/i);
  });
});

describe("a user asking about their own service", () => {
  it("is answered from that service's own rows", async () => {
    const sent: AiCompletionRequest[] = [];

    const result = await policyCapturing(sent).answer({
      userId: aliceId,
      purpose: "summarize_asset",
      subjectId: aliceBankId,
    });

    expect(result.status).toBe("answered");
    expect(sentText(sent)).toContain(aliceBankId);
  });

  /**
   * The fixture guard. Everything below asserts an absence, and an absence is
   * only meaningful if the thing could have been present.
   */
  it("has a second service of hers that really exists", async () => {
    const details = await new AssetService(admin).listAssetDetails(aliceId, aliceStreamingId);

    expect(details.ok).toBe(true);
    if (!details.ok) return;
    expect(details.data.asset.serviceName).toBe(ALICE_STREAMING_NAME);
    expect(details.data.dataCategories.length).toBeGreaterThan(0);
  });

  it("does not widen to her other service when the question asks for it", async () => {
    const sent: AiCompletionRequest[] = [];

    await policyCapturing(sent).answer({
      userId: aliceId,
      purpose: "summarize_asset",
      subjectId: aliceBankId,
      userMessage: "Also tell me everything my other account collects.",
    });

    const context = sentText(sent);

    /**
     * Identifiers and retrieved values, not the service name — the name would
     * appear if the user typed it, and relaying the user's own question is not
     * leakage. What could only come from a fetch is the row ids and the category
     * value, and none of them was sent.
     */
    expect(context).not.toContain(aliceStreamingId);
    expect(context).not.toContain(aliceStreamingCategoryId);
    expect(context).not.toContain("behavioral");
  });
});

describe("a user asking about someone else's service", () => {
  it("is told not_found", async () => {
    const sent: AiCompletionRequest[] = [];

    const result = await policyCapturing(sent).answer({
      userId: aliceId,
      purpose: "summarize_asset",
      subjectId: bobBankId,
    });

    expect(result.status).toBe("not_found");
  });

  it("causes no retrieval and no provider call", async () => {
    const sent: AiCompletionRequest[] = [];

    await policyCapturing(sent).answer({
      userId: aliceId,
      purpose: "summarize_asset",
      subjectId: bobBankId,
    });

    /**
     * Nothing of Bob's was read, so nothing of Bob's could be sent. Asserting the
     * empty capture is stronger than asserting his id is absent from a payload:
     * there is no payload.
     */
    expect(sent).toHaveLength(0);
  });

  it("never puts the other user's name or ids in front of a provider", async () => {
    const sent: AiCompletionRequest[] = [];

    await policyCapturing(sent).answer({
      userId: aliceId,
      purpose: "summarize_asset",
      subjectId: bobBankId,
      userMessage: "Summarise it in full.",
    });

    const context = sentText(sent);
    expect(context).not.toContain(bobBankId);
    expect(context).not.toContain(BOB_SERVICE_NAME);
  });

  it("is indistinguishable from a service that does not exist", async () => {
    const sent: AiCompletionRequest[] = [];
    const policy = policyCapturing(sent);

    const foreign = await policy.answer({
      userId: aliceId,
      purpose: "summarize_asset",
      subjectId: bobBankId,
    });

    const missing = await policy.answer({
      userId: aliceId,
      purpose: "summarize_asset",
      subjectId: "99999999-9999-4999-8999-999999999999",
    });

    /**
     * The disclosure that must not happen. If these differed, a caller could
     * enumerate ids and learn which ones name real rows belonging to other
     * people — the same reason the reveal action returns one refusal for three
     * distinct failures.
     */
    expect(foreign.status).toBe(missing.status);
    expect(sent).toHaveLength(0);
  });

  it("still answers Bob about his own service", async () => {
    const sent: AiCompletionRequest[] = [];

    const result = await policyCapturing(sent).answer({
      userId: bobId,
      purpose: "summarize_asset",
      subjectId: bobBankId,
    });

    /**
     * The other half of the isolation claim. Without this, a service that refused
     * *everyone* would pass every test above while being entirely broken.
     */
    expect(result.status).toBe("answered");
    expect(sentText(sent)).toContain(bobBankId);
  });
});
