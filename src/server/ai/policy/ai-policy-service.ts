import "server-only";
import { logger } from "@/lib/telemetry/logger";
import type { InputClassification } from "@/lib/ai/interaction-vocabulary";
import type { ContextProvenance } from "@/lib/ai/context-provenance";
import type { FindingConfidence, FindingSourceType } from "@/lib/findings/findings";
import type { ConsentService } from "@/server/consent/consent-service";
import type { FindingService } from "@/server/findings/finding-service";
import type { AssetService } from "@/server/assets/asset-service";
import { AI_GATEWAY_CONFIG } from "../gateway";
import { resolvePrompt, hasPrompt } from "../prompts/registry";
import type { AiPurpose } from "../prompts/prompt";
import { schemaFor } from "../schemas/registry";
import type { ValidationContext } from "../schemas/invariants";
import type { AiInteractionRecorder } from "../interaction-recorder";
import {
  buildFindingFallback,
  type FallbackFindingInput,
  type FallbackReason,
} from "../fallback/finding-fallback";
import { noopInteractionRecorder } from "../interaction-recorder";
import {
  anchorFor,
  noopConversationHistory,
  type AiConversationHistory,
} from "../history/conversation-history";
import type { StructuredCompletionService } from "../structured-completion";
import { policyFor } from "./policy-map";
import { classifyContext } from "./classification";
import { assembleContextBlock, contextIdsOf, type ContextEntry } from "./context-assembly";

/**
 * The AI policy layer (ATL-049, architecture §12, security §10).
 *
 * **The only path from user data to the provider.** Nothing else may call
 * `StructuredCompletionService`: consent, retrieval limits, redaction and
 * fencing all live here, and a second entry point would be a way around all four
 * at once.
 *
 * ## The order of the pipeline is the design
 *
 * Consent is checked **before retrieval**, not merely before the provider call.
 * Reading a user's findings to build context for someone who has not consented
 * to AI processing already moves their data toward a processor; checking first
 * means the denial path never touches their records at all.
 *
 * Then: purpose policy → retrieval capped at the source → redaction → fenced
 * assembly → classification → delegation.
 *
 * ## Exactly one interaction row, guaranteed by structure
 *
 * This service records **only on paths that never reach**
 * `StructuredCompletionService`. Once delegation happens the service owns the
 * row, and delegation is the last thing this method does. There is no branch
 * where both record.
 *
 * ## What is deferred, and why that is honest
 *
 * `draft_request` enforces per-request field approval but retrieves no stored
 * values: `user_personal_fields` does not exist (ATL-105) and the approval step
 * is ATL-058. The enforcement is real today — ATL-050 intersects the model's
 * claimed keys against the approved set and fails closed — even though the
 * storage source is not built.
 *
 * Only `explain_finding` has a registered prompt (ATL-051 authored prompts for
 * consumers that exist). Other purposes retrieve correctly and then report
 * `unavailable`, which is the honest status for "we could have asked, but no
 * instructions are written".
 */

export interface AiPolicyRequest {
  userId: string;
  purpose: AiPurpose;
  /** The entity the purpose acts on, where the purpose needs one. */
  subjectId?: string | undefined;
  /**
   * The user's question or instruction. Untrusted; fenced like any other input.
   *
   * **Optional** (ATL-055). A button-triggered surface has no question to send:
   * pressing "Ask Atlas" on a finding declares a purpose, and the registered
   * task template plus the retrieved context already define the task completely.
   *
   * When absent, no question block is emitted at all — not an empty one.
   * Manufacturing a default string here would be prompt text at a call site,
   * which ATL-051 forbids, and an empty `<atlas-question></atlas-question>`
   * would tell the model a question was asked and then show it nothing.
   *
   * Kept supported because conversational surfaces (ATL-053/054) genuinely do
   * carry a question.
   */
  userMessage?: string | undefined;
  /**
   * Personal-field keys approved **in this flow** (ADR-002).
   *
   * Supplied by the caller because approval is per-request state; storage alone
   * is never permission. Empty for every purpose but `draft_request`.
   */
  approvedFieldKeys?: readonly string[] | undefined;
}

export type AiPolicyResult =
  /**
   * An answer. `source` distinguishes a model-generated, schema-validated
   * explanation from deterministic text Atlas wrote itself (ATL-052).
   *
   * The discriminant is not cosmetic: only an AI answer carries model
   * confidence, and a surface that could not tell the two apart would either
   * render a confidence the fallback does not have or drop one the AI does.
   */
  | {
      status: "answered";
      source: "ai" | "fallback";
      value: unknown;
      classification: InputClassification;
      /**
       * The `ai_interactions` row this answer came from (task #109).
       *
       * Present wherever a row exists, so ATL-053 can attach feedback to the
       * exact interaction on screen. Absent when nothing was recorded — an inert
       * recorder, or a failed insert.
       */
      interactionId?: string | undefined;
    }
  /**
   * Deterministic local text; no provider was called (B3).
   *
   * **No `interactionId` field, deliberately.** A product question writes no
   * `ai_interactions` row, so an optional id here would invite a caller to check
   * for something that can never be present.
   */
  | { status: "guidance"; message: string }
  | { status: "consent_required"; interactionId?: string | undefined }
  /**
   * The subject does not exist or is not the caller's. Indistinguishable,
   * deliberately — and refused before any row is written, so no id either.
   */
  | { status: "not_found" }
  | { status: "unavailable"; interactionId?: string | undefined };

/**
 * B3: no curated corpus exists, so product questions get deterministic text
 * rather than an invented answer. A model asked about Atlas with no grounding
 * would state facts about the product that nobody wrote down.
 */
export const PRODUCT_GUIDANCE_UNAVAILABLE =
  "Guidance for product questions is not available yet. You can find your assets, findings and privacy score in the app, and Atlas will answer questions here once product guidance is published.";

/**
 * What retrieval produced: the context entries, and the deterministic source
 * material for the fallback when the purpose has any.
 *
 * Returned together rather than held on the service, because a field on the
 * instance would be shared by every concurrent request — two users asking at
 * once would race, and one could receive the other's finding.
 */
interface Retrieved {
  entries: ContextEntry[];
  fallbackSubject: FallbackFindingInput | null;
}

export interface AiPolicyDeps {
  consent: ConsentService;
  findings: FindingService;
  /**
   * Asset reads for `summarize_asset` (ATL-054).
   *
   * Injected by type like every other collaborator, which is also what keeps the
   * dependency one-directional: nothing under `server/assets` imports the AI
   * subsystem, so there is no cycle to break.
   */
  assets: AssetService;
  completion: StructuredCompletionService;
  recorder?: AiInteractionRecorder;
  /**
   * Conversation history (ATL-109), off unless wired.
   *
   * Optional and defaulted, so every existing construction of this service —
   * and every existing test — is unchanged. History is strictly additive: it
   * never participates in producing an answer, and it is consulted only after
   * one has been validated.
   */
  history?: AiConversationHistory;
  /**
   * The `AI_ENABLED` kill switch (ATL-052).
   *
   * Injected rather than read from env here, so the policy layer stays free of
   * `@/config/env` — the same reason the gateway keeps its own env access in the
   * vendor adapter. Production passes `env.AI_ENABLED`.
   */
  aiEnabled?: boolean;
  now?: () => number;
}

export class AiPolicyService {
  private readonly consent: ConsentService;
  private readonly findings: FindingService;
  private readonly assets: AssetService;
  private readonly completion: StructuredCompletionService;
  private readonly recorder: AiInteractionRecorder;
  private readonly history: AiConversationHistory;
  private readonly aiEnabled: boolean;
  private readonly now: () => number;

  constructor({
    consent,
    findings,
    assets,
    completion,
    recorder = noopInteractionRecorder,
    history = noopConversationHistory,
    aiEnabled = true,
    now = Date.now,
  }: AiPolicyDeps) {
    this.consent = consent;
    this.findings = findings;
    this.assets = assets;
    this.completion = completion;
    this.recorder = recorder;
    this.history = history;
    this.aiEnabled = aiEnabled;
    this.now = now;
  }

  /**
   * Stores the exchange, when the person has enabled history (ATL-109).
   *
   * ## Only a validated answer
   *
   * Called for `validated` and not for `fallback`. A fallback is Atlas's own
   * deterministic text, assembled from the user's records because the provider
   * could not be reached — it is not something the assistant said, and filing it
   * as an assistant turn would make the transcript claim a conversation that did
   * not happen.
   *
   * ## The stored assistant turn is the validated output verbatim
   *
   * `JSON.stringify(value)` rather than a prose field lifted out of it. The
   * validated object *is* what the assistant returned; picking `summary` and
   * discarding the rest would store a lossy paraphrase of the answer and quietly
   * decide which parts of it mattered. It is encrypted either way.
   *
   * ## Failure here never fails the request
   *
   * The person asked a question and received a correct, validated answer. Losing
   * the transcript is a storage problem, not a reason to withhold it — so this
   * logs and returns rather than throwing. No message content reaches the log.
   */
  private async remember(request: AiPolicyRequest, value: unknown): Promise<void> {
    const turns = [
      ...(request.userMessage && request.userMessage.trim().length > 0
        ? ([{ role: "user", content: request.userMessage }] as const)
        : []),
      { role: "assistant", content: JSON.stringify(value) } as const,
    ];

    try {
      await this.history.append(
        request.userId,
        anchorFor(request.purpose, request.subjectId),
        turns,
      );
    } catch {
      logger.warn("ai.history_not_stored", {
        operation: "ai.history",
        provider: "ai",
      });
    }
  }

  async answer(request: AiPolicyRequest): Promise<AiPolicyResult> {
    const startedAt = this.now();
    const policy = policyFor(request.purpose);

    /**
     * The kill switch, checked before everything (ATL-052).
     *
     * Ahead of the consent read on purpose: a deployment with AI switched off
     * should perform no consent lookup, no retrieval and no provider call. A
     * flag checked later would still touch the user's records to build context
     * for a request that was never going to be sent.
     *
     * The deterministic explanation still runs, so the surface degrades rather
     * than disappearing — AI behavior §11's "do not block manual workflows".
     */
    if (!this.aiEnabled) {
      const disabled = await this.answerWithoutAi(request, "ai_disabled", startedAt);
      return disabled;
    }

    /**
     * Consent first, before any record is read. `hasConsent` returns false when
     * the latest grant is against a superseded policy version, so a stale grant
     * is a denial rather than a silent pass (ATL-078).
     */
    if (!(await this.consent.hasConsent(request.userId, "ai_processing"))) {
      const interactionId = await this.record(request, "consent_denied", "none", [], startedAt);
      return { status: "consent_required", ...(interactionId === null ? {} : { interactionId }) };
    }

    /**
     * No user records, no provider call, and — per the recording decision — no
     * `ai_interactions` row: that table represents interactions with a provider,
     * and recording model, prompt and schema versions for a path where none of
     * them ran would describe something that never happened.
     */
    if (policy.readsNoUserRecords) {
      return { status: "guidance", message: PRODUCT_GUIDANCE_UNAVAILABLE };
    }

    const retrieved = await this.retrieve(request);
    if (retrieved === null) return { status: "not_found" };

    const approvedFieldKeys = policy.allowsPersonalFields ? (request.approvedFieldKeys ?? []) : [];
    const contextIds = contextIdsOf(retrieved.entries);

    /**
     * Included field keys are empty until ATL-105 supplies stored values. The
     * classification is therefore honest about what was actually sent rather
     * than about what was permitted.
     */
    const classification = classifyContext({
      recordIds: contextIds,
      includedPersonalFieldKeys: [],
    });

    if (!hasPrompt(request.purpose)) {
      /**
       * Retrieval succeeded but no instructions are registered for this purpose
       * yet. Recorded as `unavailable` — the vocabulary's honest fit — rather
       * than inventing a status for "not built".
       */
      const interactionId = await this.record(
        request,
        "unavailable",
        classification,
        contextIds,
        startedAt,
      );
      return { status: "unavailable", ...(interactionId === null ? {} : { interactionId }) };
    }

    const prompt = resolvePrompt(request.purpose);

    /**
     * One set, used twice. `contextIds` is what the invariant checks validate
     * against and what the disclosure row records; computing them separately is
     * how a row ends up claiming the assistant saw something it did not.
     */
    const context: ValidationContext = {
      contextIds: new Set(contextIds),
      approvedFieldKeys: new Set(approvedFieldKeys),
      ownedEntityIds: new Set(contextIds),
    };

    const result = await this.completion.complete({
      userId: request.userId,
      prompt,
      messages: [
        {
          role: "user",
          content: assembleTurn(retrieved.entries, request.userMessage),
        },
      ],
      context,
      inputClassification: classification,
      /** Lets the fallback answer without a second read (ATL-052). */
      ...(retrieved.fallbackSubject === null ? {} : { fallbackSubject: retrieved.fallbackSubject }),
    });

    // Past this point the completion service owns the row.
    const carried =
      result.interactionId === undefined ? {} : { interactionId: result.interactionId };

    if (result.status === "validated") {
      await this.remember(request, result.value);
      return { status: "answered", source: "ai", value: result.value, classification, ...carried };
    }

    if (result.status === "fallback") {
      return {
        status: "answered",
        source: "fallback",
        value: result.value,
        classification,
        ...carried,
      };
    }

    return { status: "unavailable", ...carried };
  }

  /**
   * The disabled path: deterministic content, no AI machinery at all.
   *
   * Retrieval still runs, because the fallback is built from the user's own
   * records and refusing to read them would mean showing nothing rather than
   * showing what Atlas already knows. What does not run is the consent read (no
   * processing is being consented to), the prompt resolution, and the provider
   * call.
   *
   * Recorded as `unavailable`: the interaction reached the AI surface and
   * produced no AI output, which is exactly what that status means.
   */
  private async answerWithoutAi(
    request: AiPolicyRequest,
    reason: FallbackReason,
    startedAt: number,
  ): Promise<AiPolicyResult> {
    const policy = policyFor(request.purpose);

    if (policy.readsNoUserRecords) {
      return { status: "guidance", message: PRODUCT_GUIDANCE_UNAVAILABLE };
    }

    const retrieved = await this.retrieve(request);
    if (retrieved === null) return { status: "not_found" };

    const contextIds = contextIdsOf(retrieved.entries);
    const classification = classifyContext({
      recordIds: contextIds,
      includedPersonalFieldKeys: [],
    });

    const value = retrieved.fallbackSubject
      ? buildFindingFallback(retrieved.fallbackSubject, reason)
      : null;

    const interactionId = await this.record(
      request,
      "unavailable",
      classification,
      contextIds,
      startedAt,
    );
    const carried = interactionId === null ? {} : { interactionId };

    return value === null
      ? { status: "unavailable", ...carried }
      : { status: "answered", source: "fallback", value, classification, ...carried };
  }

  /**
   * Purpose-scoped retrieval.
   *
   * Every read goes through a service that already takes `userId` as an explicit
   * predicate, so ownership is enforced by code that is separately tested for it
   * rather than re-implemented here. `null` means the subject was not found *or*
   * is not the caller's — deliberately indistinguishable, matching ATL-034.
   */
  private async retrieve(request: AiPolicyRequest): Promise<Retrieved | null> {
    const policy = policyFor(request.purpose);

    if (policy.requiresSubject && !request.subjectId) return null;

    if (request.purpose === "explain_finding" && request.subjectId) {
      const found = await this.findings.getFindingDetail(request.userId, request.subjectId);
      if (!found.ok) return null;

      const finding = found.data;
      const entries: ContextEntry[] = [
        {
          id: finding.id,
          kind: "finding",
          /**
           * Provenance from the finding's real source vocabulary
           * (`demo | manual | connector | import`). Demo must be labelled as
           * demo — AI behavior §4 requires the response to disclose it, and the
           * model can only disclose what the context tells it.
           */
          provenance: toProvenance(finding.sourceType, finding.confidence),
          fields: {
            title: finding.title,
            severity: finding.severity,
            confidence: finding.confidence,
            evidence: finding.evidenceSummary,
            recommended_action: finding.recommendedAction,
          },
        },
      ];

      /** The related asset, named rather than identified (§5's "related asset"). */
      if (finding.assetId) {
        entries.push({
          id: finding.assetId,
          kind: "asset",
          provenance: "user_provided",
          fields: { name: finding.impactedAsset },
        });
      }

      /**
       * The same finding, in the shape the deterministic fallback needs
       * (ATL-052). Returned alongside the context rather than re-read later: the
       * policy layer has already paid for this query, and a fallback that went
       * back to the database would add a failure mode to the path that exists
       * because something else already failed.
       */
      return {
        entries,
        fallbackSubject: {
          id: finding.id,
          title: finding.title,
          description: finding.description,
          evidenceSummary: finding.evidenceSummary,
          recommendedAction: finding.recommendedAction,
          confidence: finding.confidence,
          sourceType: finding.sourceType,
          evidenceIds: finding.evidenceRecords.map((record) => record.id),
        },
      };
    }

    if (request.purpose === "recommend_action") {
      const listed = await this.findings.listFindings(request.userId, { status: "open" });
      if (!listed.ok) return null;

      /**
       * The cap is applied to what enters context. The service returns a user's
       * own findings — bounded by their records — and the policy's limit is what
       * decides how many of them the model is allowed to reason over.
       */
      return {
        entries: listed.data.slice(0, policy.maxFindings).map((finding) => ({
          id: finding.id,
          kind: "finding",
          provenance: "verified" as const,
          fields: { title: finding.title, severity: finding.severity },
        })),
        fallbackSubject: null,
      };
    }

    if (request.purpose === "summarize_asset" && request.subjectId) {
      /**
       * ATL-054. **The subject id is the entire scope.**
       *
       * `listAssetDetails` takes the user id and one asset id and returns that
       * asset with its own categories and permissions. There is no second query
       * and no list read, so "another asset leaked in" is not a filter that
       * could be forgotten — it would require code that does not exist. A
       * request naming an asset the caller does not own fails `NOT_FOUND` here,
       * indistinguishably from one that does not exist.
       *
       * Nothing in `request.userMessage` reaches this function. Prose asking
       * Atlas to "also cover my other account" changes what the model is asked,
       * never what was fetched — and an id that was never sent cannot survive
       * the invariant check even if the model produces it.
       */
      const found = await this.assets.listAssetDetails(request.userId, request.subjectId);
      if (!found.ok) return null;

      const { asset, dataCategories, permissions } = found.data;

      const entries: ContextEntry[] = [
        {
          id: asset.id,
          kind: "asset",
          /** User-entered, so unverified as fact — §4's own vocabulary. */
          provenance: "user_provided",
          fields: {
            name: asset.serviceName,
            category: asset.category,
            status: asset.status,
          },
        },
      ];

      /**
       * Categories and permissions are `verified`: unlike the service name, they
       * are constrained vocabularies the product wrote, and `sensitivity` is
       * generated by the database from `category` (ADR-004), so neither is a
       * free-text claim the model should hedge about.
       *
       * The account identifier is **deliberately absent**. It is Restricted
       * under §8, encrypted at rest, and no part of summarising what a service
       * holds requires it.
       */
      for (const record of dataCategories) {
        entries.push({
          id: record.id,
          kind: "asset_categories",
          provenance: "verified",
          fields: { category: record.category, sensitivity: record.sensitivity ?? "standard" },
        });
      }

      for (const record of permissions) {
        entries.push({
          id: record.id,
          kind: "asset_permissions",
          provenance: "verified",
          fields: {
            permission: record.permissionType,
            scope: record.scope,
            status: record.status,
          },
        });
      }

      /**
       * No fallback subject. ATL-052's deterministic builder is finding-shaped,
       * and ATL-054 deliberately does not add an asset equivalent: there is no
       * rule-derived text to fall back *to*, and inventing summary prose Atlas
       * never derived would break the grounding rules the fallback exists to
       * honour. A provider failure reports `unavailable`, which is true.
       */
      return { entries, fallbackSubject: null };
    }

    /**
     * `explain_score` and `draft_request` have policies and caps but no
     * registered prompt, so retrieval for them is not built: it would be code
     * with no caller, shaped by guesses about what its prompt will need. The
     * purpose still reaches the `unavailable` path above with an empty context,
     * which is accurate — nothing was sent.
     */
    return { entries: [], fallbackSubject: null };
  }

  /**
   * Records an interaction that never reached the completion service.
   *
   * The failure-path half of the single-recording invariant. Versions come from
   * the registry when a prompt exists and default to 1 otherwise — the columns
   * are `NOT NULL`, and a row for a purpose with no prompt still has to say
   * which generation of the policy layer produced it.
   */
  private async record(
    request: AiPolicyRequest,
    status: "consent_denied" | "unavailable",
    classification: InputClassification,
    contextIds: readonly string[],
    startedAt: number,
  ): Promise<string | null> {
    const prompt = hasPrompt(request.purpose) ? resolvePrompt(request.purpose) : null;

    const interactionId = await this.recorder.record({
      userId: request.userId,
      purpose: request.purpose,
      model: AI_GATEWAY_CONFIG.model,
      promptVersion: prompt?.promptVersion ?? 1,
      policyVersion: prompt?.policyVersion ?? 1,
      inputClassification: classification,
      recordsReferenced: [...contextIds],
      outputSchemaVersion: prompt ? schemaFor(prompt.schemaId).version : 1,
      status,
      latencyMs: Math.max(0, this.now() - startedAt),
    });

    logger.info("ai.policy_denied", {
      operation: "ai.policy",
      errorCode: status.toUpperCase(),
    });

    return interactionId;
  }
}

/**
 * Maps a finding to a provenance label (ATL-049, extended by ATL-055).
 *
 * ## Why confidence is an input
 *
 * ATL-055 requires stale sources to be disclosed, and the model can only
 * disclose what the context tells it. Before this, `potentially_stale` existed
 * in the vocabulary and was **never emitted** — a stale finding was labelled
 * `Verified`, so the disclosure was impossible to make truthfully.
 *
 * ADR-001 derives `confidence` from source *and staleness*: a `low` confidence
 * finding is exactly one whose records could not be recently verified. So the
 * signal was already on the record; nothing new is queried or stored.
 *
 * ## Demo takes precedence
 *
 * A demo finding is demo first. Both labels would be accurate, but §4's demo
 * disclosure is the more important one — a user must never mistake demo data
 * for their own, and "potentially stale" would imply the records are real.
 *
 * `manual` is the user's own assertion, so it is user-provided rather than
 * verified — Atlas records it faithfully but has not confirmed it. `connector`
 * and `import` came from an authorised source and count as verified.
 */
function toProvenance(
  sourceType: FindingSourceType,
  confidence: FindingConfidence,
): ContextProvenance {
  if (sourceType === "demo") return "demo";
  if (confidence === "low") return "potentially_stale";
  return sourceType === "manual" ? "user_provided" : "verified";
}

/**
 * The user's own message, fenced separately from retrieved records.
 *
 * A question is untrusted too — it is typed by a person who may have been sent a
 * link telling them what to paste — but it is not a *record*, and mixing it into
 * the record block would make provenance meaningless.
 */
function assembleUserTurn(message: string): string {
  return `<atlas-question>\n${message.replaceAll("<", "‹").replaceAll(">", "›")}\n</atlas-question>`;
}

/**
 * The full user turn: context, plus a question only when there is one.
 *
 * A button-triggered explanation has no question (ATL-055). Emitting an empty
 * `<atlas-question></atlas-question>` would claim one was asked and then show
 * nothing — worse than silence, because the model would try to answer it. So the
 * block is omitted entirely, and a caller that *does* have a message gets byte
 * identical output to before.
 */
function assembleTurn(entries: readonly ContextEntry[], message?: string): string {
  const context = assembleContextBlock(entries);
  const trimmed = message?.trim() ?? "";

  return trimmed.length > 0 ? `${context}\n\n${assembleUserTurn(message as string)}` : context;
}
