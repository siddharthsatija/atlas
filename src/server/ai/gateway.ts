import "server-only";
import { logger } from "@/lib/telemetry/logger";
import { RATE_LIMIT_POLICIES, type RateLimiter } from "@/server/rate-limit/rate-limit";
import {
  AiGatewayError,
  classifyStatus,
  isRetryable,
  toLogCode,
  type AiFailureKind,
} from "./errors";

/**
 * The AI gateway (ATL-048, architecture §12, security §10).
 *
 * A server-only adapter around one provider call. It owns four things and
 * deliberately nothing else: **timeout, bounded retry, typed error mapping, and
 * the provider abstraction**.
 *
 * ## What lives elsewhere
 *
 * Output schema validation is ATL-050. Prompt templates and their versions are
 * ATL-051. Purpose classification, minimal retrieval, redaction, per-request
 * field approval and the `ai_processing` consent gate are ATL-049. Deterministic
 * fallback copy is ATL-052. Recording to `ai_interactions` belongs to whichever
 * ticket eventually owns that table — architecture §7.11 specifies it and no
 * ticket creates it, which is filed as a follow-up rather than absorbed here.
 *
 * This module's contract stops at: returned text, or an `AiGatewayError` that
 * carries no provider prose.
 *
 * ## No provider type crosses this boundary
 *
 * `gateway.ts` imports no SDK. The provider lives behind `AiProviderClient`,
 * whose implementation is `anthropic-client.ts` — the only module in the
 * repository that knows which vendor Atlas uses. That is what makes "adapter
 * unit tests with mocked provider" possible without a network, and what makes a
 * second provider a new file rather than an edit to this logic.
 *
 * ## Rate limiting is inside, not beside
 *
 * B1: the gateway performs the check, so every future caller inherits it without
 * having to remember. The key is the **user only** — never the IP. Every AI call
 * happens in an authenticated session, and an IP key would throttle a shared
 * office as though it were one person.
 *
 * The limiter fails **open** when its store is unreachable, matching every other
 * surface. That is a deliberate trade: an unreachable counter store would
 * otherwise take the assistant down for everyone, and the degradation is logged
 * so it is visible rather than silent.
 */

/**
 * Generation settings, defined centrally (B5).
 *
 * One constant rather than a per-caller parameter: a model chosen at each call
 * site drifts, and `ai_interactions.model` is supposed to record what Atlas
 * actually used, not what one caller happened to pass. Callers supply content;
 * the gateway supplies everything about *how* it is generated.
 *
 * **`temperature: 0`.** Atlas's AI surfaces explain and draft from supplied
 * evidence — AI behavior §4 grounding rules — where variation between identical
 * requests is a defect rather than a feature. It also makes the ATL-051
 * evaluation set meaningful: a graded prompt whose output changes run to run
 * cannot be regression-tested.
 *
 * **Timeout 30s, 2 attempts total** are the B2 decisions. The timeout is per
 * attempt, so the worst case a caller waits is roughly two timeouts plus one
 * backoff — bounded, and far below the SDK's own 10-minute default.
 */
export const AI_GATEWAY_CONFIG = {
  model: "claude-sonnet-5",
  maxOutputTokens: 1024,
  temperature: 0,
  timeoutMs: 30_000,
  /** Total attempts including the first. B2: one retry, never more. */
  maxAttempts: 2,
  backoffBaseMs: 500,
  backoffCeilingMs: 4_000,
} as const;

/** One turn of conversation. Content is plain text; no tools, no blocks. */
export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiCompletionRequest {
  /** The signed-in user. Used only as the rate-limit key — never sent. */
  userId: string;
  /** System instruction. ATL-051 owns its text and version; the gateway relays it. */
  system: string;
  messages: AiMessage[];
}

export interface AiCompletion {
  text: string;
  /** What actually generated it, for the caller to record. */
  model: string;
  /** Total attempts made, including the first. */
  attempts: number;
  latencyMs: number;
}

/** What the gateway hands the provider. Vendor-neutral by construction. */
export interface ProviderCallInput {
  model: string;
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  temperature: number;
}

/**
 * The provider port.
 *
 * Implementations throw on failure. The gateway reads a numeric `status` off the
 * thrown value when one is present and ignores everything else about it — no
 * message, no body, no vendor error class. Anything unclassifiable becomes an
 * outage, which is the safe direction.
 */
export interface AiProviderClient {
  send(input: ProviderCallInput, signal: AbortSignal): Promise<{ text: string }>;
}

export interface AiGateway {
  complete(request: AiCompletionRequest): Promise<AiCompletion>;
}

export interface AiGatewayDeps {
  client: AiProviderClient;
  limiter: RateLimiter;
  /** Injected so backoff is asserted rather than waited for. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so jitter is deterministic under test. */
  random?: () => number;
  now?: () => number;
}

/** Reads a numeric HTTP status off an unknown thrown value, if it carries one. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status: unknown = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class AiProviderGateway implements AiGateway {
  private readonly client: AiProviderClient;
  private readonly limiter: RateLimiter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(deps: AiGatewayDeps) {
    this.client = deps.client;
    this.limiter = deps.limiter;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletion> {
    await this.enforceRateLimit(request.userId);

    const startedAt = this.now();
    let attempts = 0;

    for (;;) {
      attempts += 1;

      try {
        const text = await this.callOnce(request);

        /**
         * An empty completion is a failure, not an empty success. A caller that
         * received `""` would render a blank explanation and call it an answer.
         * Non-retryable: the same request produced nothing once and there is no
         * reason to believe a second identical call differs.
         */
        if (text.trim().length === 0) {
          throw new AiGatewayError("malformed_response", { attempts });
        }

        return {
          text,
          model: AI_GATEWAY_CONFIG.model,
          attempts,
          latencyMs: this.now() - startedAt,
        };
      } catch (error) {
        const kind = toFailureKind(error);
        const exhausted = attempts >= AI_GATEWAY_CONFIG.maxAttempts;

        if (!isRetryable(kind) || exhausted) {
          this.logFailure(kind, statusOf(error), this.now() - startedAt);
          throw new AiGatewayError(kind, { status: statusOf(error), attempts });
        }

        await this.sleep(this.backoffFor(attempts));
      }
    }
  }

  /**
   * One attempt, with its own deadline.
   *
   * `AbortSignal.timeout` is avoided for the same reason the rate-limit store
   * avoids it: it is not available in every runtime Atlas targets. The manual
   * controller is also what makes the timeout distinguishable from a provider
   * abort — the flag is ours, so a cancellation we caused is never misread as
   * one the provider caused.
   */
  private async callOnce(request: AiCompletionRequest): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, AI_GATEWAY_CONFIG.timeoutMs);

    try {
      const { text } = await this.client.send(
        {
          model: AI_GATEWAY_CONFIG.model,
          system: request.system,
          messages: request.messages,
          maxTokens: AI_GATEWAY_CONFIG.maxOutputTokens,
          temperature: AI_GATEWAY_CONFIG.temperature,
        },
        controller.signal,
      );

      return text;
    } catch (error) {
      if (timedOut) throw new AiGatewayError("timeout");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Full jitter over an exponential base.
   *
   * Jitter is not decoration: without it, every client that failed against the
   * same provider incident retries at the same instant, and the retry storm
   * arrives exactly when the provider is least able to absorb it.
   */
  private backoffFor(attempt: number): number {
    const exponential = AI_GATEWAY_CONFIG.backoffBaseMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, AI_GATEWAY_CONFIG.backoffCeilingMs);
    return Math.round(this.random() * capped);
  }

  private async enforceRateLimit(userId: string): Promise<void> {
    const decision = await this.limiter.check(RATE_LIMIT_POLICIES.aiRequest, [
      { kind: "user", value: userId },
    ]);

    if (decision.degraded) {
      /**
       * Fail open, and say so (B1). The identifier is never logged — that is
       * exactly the value the limiter's HMAC exists to keep out of log sinks.
       */
      logger.warn("ai.ratelimit_degraded", {
        operation: "ai.complete",
        provider: "ratelimit",
        providerAvailable: false,
      });
    }

    if (!decision.allowed) {
      throw new AiGatewayError("rate_limited", {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
  }

  /**
   * One line per failed call.
   *
   * Every field is allowlisted by `LOG_FIELD_POLICY`, which is what structurally
   * prevents a prompt or a completion from being logged: an unlisted key is
   * dropped rather than trusted. The *internal* code is recorded rather than the
   * collapsed public one, because an operator needs to tell a provider outage
   * from an Atlas-side defect and both collapse to `UNAVAILABLE`.
   */
  private logFailure(kind: AiFailureKind, status: number | undefined, latencyMs: number): void {
    logger.error("ai.provider_failure", {
      operation: "ai.complete",
      provider: "anthropic",
      providerAvailable: kind !== "provider_unavailable" && kind !== "timeout",
      errorCode: toLogCode(kind),
      latencyMs,
      ...(status === undefined ? {} : { status }),
    });
  }
}

/** Classifies anything thrown during an attempt into the internal taxonomy. */
function toFailureKind(error: unknown): AiFailureKind {
  if (error instanceof AiGatewayError) return error.kind;

  const status = statusOf(error);
  if (status !== undefined) return classifyStatus(status);

  /**
   * No status: a connection reset, a DNS failure, a provider abort. Treated as
   * an outage rather than inspected further — reading a vendor error's shape
   * here is how provider specifics leak into logic that claims to be neutral.
   */
  return "provider_unavailable";
}
