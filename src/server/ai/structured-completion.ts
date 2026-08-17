import "server-only";
import { logger } from "@/lib/telemetry/logger";
import type { AiInteractionStatus, InputClassification } from "@/lib/ai/interaction-vocabulary";
import { AI_GATEWAY_CONFIG, type AiGateway, type AiMessage } from "./gateway";
import { AiGatewayError } from "./errors";
import type { ResolvedPrompt } from "./prompts/prompt";
import { validateOutput } from "./schemas/validate";
import { schemaFor } from "./schemas/registry";
import type { InvariantViolation, ValidationContext } from "./schemas/invariants";
import { noopInteractionRecorder, type AiInteractionRecorder } from "./interaction-recorder";
import type { FallbackFindingInput } from "./fallback/finding-fallback";

/**
 * Structured completion: gateway call, validation, one repaired retry, fallback
 * (ATL-050).
 *
 * ## Two different retries, owned by two different layers
 *
 * ATL-048 retries **transport** failures — timeout, 429, 5xx — inside a single
 * logical attempt, and that behaviour is not duplicated here. This module
 * retries **schema-invalid output**, which is a successful provider call whose
 * content was wrong. They compose: a schema retry issues a second logical
 * attempt, which the gateway may itself retry once on transport grounds.
 *
 * The bound this module owns is exactly **two provider attempts total**.
 *
 * ## Why the second attempt is not identical
 *
 * Temperature is 0, so re-sending byte-identical input to a deterministic model
 * would very likely return the identical invalid output — a retry that is real
 * in code and hollow in practice, spending a second call and a second unit of
 * the rate budget to reach the same failure. The second attempt therefore
 * appends the prompt's **registered** repair instruction.
 *
 * That instruction comes from ATL-051's registry, not from here. It is fixed,
 * version-controlled and evaluated like any other prompt text, and it carries no
 * user data, no echo of the invalid completion and no validation-error detail.
 * Feeding the model's own bad output back would let text it emitted re-enter the
 * prompt as instruction, which is the injection path AI behavior §10 closes.
 *
 * ## Invariant violations never retry
 *
 * A hallucinated reference or an unapproved field key is not a formatting slip.
 * Asking again does not make it acceptable, so the first violation goes straight
 * to fallback with exactly one provider call spent.
 */

/**
 * The deterministic fallback seam (ATL-052).
 *
 * Defaults to unavailable, in the shape ATL-045 established with
 * `NoopScoreRecalculationQueue`: the seam exists and is wired now, the content
 * arrives with the ticket that owns it. ATL-050 authors no fallback prose.
 */
export interface AiFallbackProvider {
  /**
   * Returns replacement output, or `null` when none is available yet.
   *
   * Typed `unknown` rather than `unknown | null` because the union collapses —
   * `unknown` already admits `null`. The convention is documented here and
   * asserted by the seam's tests rather than encoded in a wider type.
   */
  provide(request: StructuredCompletionRequest): unknown;
}

export const unavailableFallback: AiFallbackProvider = {
  provide: () => null,
};

export interface StructuredCompletionRequest {
  userId: string;
  prompt: ResolvedPrompt;
  /** Context block and user turn, assembled by ATL-049. Never built here. */
  messages: AiMessage[];
  context: ValidationContext;
  /**
   * The records the policy layer already retrieved, for the fallback to use
   * (ATL-052).
   *
   * Passed through rather than re-read: the policy layer owns this data and has
   * already paid for the query, so a second database round trip would be work
   * done twice to reach the same rows — and it would give the fallback path its
   * own failure mode, on the path that exists precisely because something else
   * already failed.
   */
  fallbackSubject?: FallbackFindingInput | undefined;
  /**
   * Sensitivity of the context that was assembled (ATL-049).
   *
   * Passed in rather than derived: this service cannot know whether approved
   * personal fields were included, because it never sees the retrieval. Optional
   * so callers without a policy layer — every test double here — record null
   * rather than a fabricated tier.
   */
  inputClassification?: InputClassification | undefined;
}

export type StructuredCompletionResult =
  | {
      status: "validated";
      value: unknown;
      /** Provider attempts spent. 1 or 2, never more. */
      attempts: number;
      promptVersion: number;
      policyVersion: number;
      schemaVersion: number;
      /**
       * The `ai_interactions` row this interaction produced (task #109).
       *
       * Absent when no row exists — an inert recorder, or a failed insert. A
       * caller uses it to attach feedback; it is an identifier, not a
       * capability, and `recordFeedback` still scopes by owner.
       */
      interactionId?: string | undefined;
    }
  /** Validation failed; ATL-052's deterministic content was substituted. */
  | { status: "fallback"; value: unknown; attempts: number; interactionId?: string | undefined }
  /** Validation failed and no fallback is available yet. */
  | {
      status: "unavailable";
      attempts: number;
      violations?: InvariantViolation[];
      interactionId?: string | undefined;
    };

/** Total provider attempts this module will spend. */
export const MAX_VALIDATION_ATTEMPTS = 2;

export interface StructuredCompletionDeps {
  gateway: AiGateway;
  fallback?: AiFallbackProvider;
  /**
   * Where interaction metadata is recorded (task #95).
   *
   * Defaults to inert, so this service keeps working — and keeps being testable
   * — without a database. Wiring a real recorder is what closes ATL-050's
   * "schema versions recorded on `ai_interactions`" clause.
   */
  recorder?: AiInteractionRecorder;
  /** Injected so elapsed time is assertable rather than wall-clock. */
  now?: () => number;
}

export class StructuredCompletionService {
  private readonly gateway: AiGateway;
  private readonly fallback: AiFallbackProvider;
  private readonly recorder: AiInteractionRecorder;
  private readonly now: () => number;

  constructor({
    gateway,
    fallback = unavailableFallback,
    recorder = noopInteractionRecorder,
    now = Date.now,
  }: StructuredCompletionDeps) {
    this.gateway = gateway;
    this.fallback = fallback;
    this.recorder = recorder;
    this.now = now;
  }

  async complete(request: StructuredCompletionRequest): Promise<StructuredCompletionResult> {
    const { prompt } = request;
    const startedAt = this.now();
    let attempts = 0;

    for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
      let completion;

      try {
        completion = await this.gateway.complete({
          userId: request.userId,
          system: prompt.system,
          messages: attempt === 1 ? request.messages : this.withRepairInstruction(request),
        });
      } catch (error) {
        /**
         * The provider failed after the gateway's own bounded retries.
         *
         * **This used to rethrow** (ATL-050). ATL-052 changed it, because the
         * ticket's objective is deterministic content "when AI fails **or is
         * rate-limited**" — and an exception escaping to the caller is neither
         * deterministic content nor a workflow that keeps working. AI behavior
         * §11 is explicit: do not block manual workflows, do not expose provider
         * errors. A thrown `AiGatewayError` does both.
         *
         * The interaction is still recorded first, with the gateway's *kind*
         * collapsed to this table's vocabulary — never a provider message, which
         * `AiGatewayError` has no field to carry anyway. The provider status
         * reaches the log through `logFailure`; it never reaches the fallback
         * content.
         */
        const status = toFailureStatus(error);
        const interactionId = await this.recordInteraction(request, status, startedAt, null);

        logger.warn("ai.provider_failed_to_fallback", {
          operation: "ai.structured_completion",
          errorCode: status.toUpperCase(),
          providerAvailable: false,
        });

        /**
         * The id of the row just written travels with the fallback (task #109).
         * One interaction, one row, one id — a user reading deterministic text
         * after an outage can still say whether it helped, which is exactly when
         * that signal is most informative.
         */
        return this.toFallback(request, attempt, startedAt, undefined, {
          alreadyRecorded: true,
          interactionId,
        });
      }

      attempts = attempt;

      const validation = validateOutput(prompt.schemaId, completion.text, request.context);

      if (validation.status === "valid") {
        const interactionId = await this.recordInteraction(
          request,
          "validated",
          startedAt,
          completion.model,
        );

        return {
          status: "validated",
          value: validation.value,
          attempts,
          promptVersion: prompt.promptVersion,
          policyVersion: prompt.policyVersion,
          schemaVersion: validation.schemaVersion,
          ...(interactionId === null ? {} : { interactionId }),
        };
      }

      if (validation.status === "invariant_violated") {
        /**
         * Fail closed immediately. `aiSchemaFailure` is false because this is
         * not a shape problem — conflating them would hide a grounding failure
         * inside a formatting metric. Codes and counts only; no values.
         */
        logger.error("ai.invariant_violated", {
          operation: "ai.structured_completion",
          aiSchemaFailure: false,
          count: validation.violations.length,
        });

        return this.toFallback(request, attempts, startedAt, validation.violations);
      }

      logger.warn("ai.schema_invalid", {
        operation: "ai.structured_completion",
        aiSchemaFailure: true,
        count: attempt,
      });
    }

    return this.toFallback(request, attempts, startedAt);
  }

  /**
   * Writes one metadata row per interaction (§7.11, task #95).
   *
   * Everything sent here is metadata by construction: versions, a status from a
   * closed vocabulary, an elapsed time, and the entity IDs that were in context.
   * There is no parameter capable of carrying a prompt, a completion, user text
   * or a provider message — the input type has no such field, and neither does
   * the table.
   *
   * `recordsReferenced` comes from the context that was actually sent, which is
   * the whole point of the column: it is what makes user-visible disclosure
   * truthful rather than a guess about what the assistant saw.
   *
   * The schema version recorded is the **implementation's**, not the prompt's
   * declaration — it is the version that actually validated the output.
   */
  private async recordInteraction(
    request: StructuredCompletionRequest,
    status: AiInteractionStatus,
    startedAt: number,
    model: string | null,
  ): Promise<string | null> {
    return this.recorder.record({
      userId: request.userId,
      purpose: request.prompt.purpose,
      // No completion on a failure path, so the model that would have run.
      model: model ?? AI_GATEWAY_CONFIG.model,
      promptVersion: request.prompt.promptVersion,
      policyVersion: request.prompt.policyVersion,
      ...(request.inputClassification === undefined
        ? {}
        : { inputClassification: request.inputClassification }),
      recordsReferenced: [...request.context.contextIds],
      outputSchemaVersion: schemaFor(request.prompt.schemaId).version,
      status,
      latencyMs: Math.max(0, this.now() - startedAt),
    });
  }

  /**
   * The repair turn.
   *
   * Appended as a user message so the system policy is untouched — the policy is
   * never user-influenced, and a repair note is not policy. The instruction is
   * taken verbatim from the registry; nothing is interpolated into it.
   */
  private withRepairInstruction(request: StructuredCompletionRequest): AiMessage[] {
    return [...request.messages, { role: "user", content: request.prompt.repairInstruction }];
  }

  /**
   * Substitutes deterministic content, or reports that none is available.
   *
   * `alreadyRecorded` exists to keep the single-recording invariant intact on
   * the provider-failure path: that branch records the *provider's* status
   * (`provider_error` / `rate_limited`) before arriving here, and recording
   * again would produce two rows for one interaction — and the second would
   * misdescribe a provider outage as a mere fallback.
   */
  private async toFallback(
    request: StructuredCompletionRequest,
    attempts: number,
    startedAt: number,
    violations?: InvariantViolation[],
    options: { alreadyRecorded?: boolean; interactionId?: string | null } = {},
  ): Promise<StructuredCompletionResult> {
    const value = this.fallback.provide(request);

    if (value === null) {
      const id = options.alreadyRecorded
        ? (options.interactionId ?? null)
        : await this.recordInteraction(request, "unavailable", startedAt, null);

      const carried = id === null ? {} : { interactionId: id };

      return violations === undefined
        ? { status: "unavailable", attempts, ...carried }
        : { status: "unavailable", attempts, violations, ...carried };
    }

    const id = options.alreadyRecorded
      ? (options.interactionId ?? null)
      : await this.recordInteraction(request, "fallback", startedAt, null);

    return { status: "fallback", value, attempts, ...(id === null ? {} : { interactionId: id }) };
  }
}

/**
 * Collapses a gateway failure to this table's status vocabulary.
 *
 * Only `rate_limited` is distinguished, because it is the one failure a user can
 * act on. Every other kind — timeout, outage, malformed transport — becomes
 * `provider_error`: the finer distinction is an operational concern that already
 * reaches the log sink, and widening a user-visible vocabulary to carry it would
 * leak provider taxonomy into a disclosure surface.
 */
function toFailureStatus(error: unknown): AiInteractionStatus {
  return error instanceof AiGatewayError && error.kind === "rate_limited"
    ? "rate_limited"
    : "provider_error";
}
