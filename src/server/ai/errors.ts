import { fail, RATE_LIMITED_MESSAGE, type ApiEnvelope } from "@/lib/api/response-envelope";

/**
 * The AI gateway's internal failure taxonomy (ATL-048, architecture §10 and §12).
 *
 * ## Why a second set of codes exists
 *
 * `ApiErrorCode` is a **closed** union, and deliberately so: architecture §10
 * requires "typed error codes, not raw provider errors", and a closed set leaves
 * no variant to smuggle a provider message into. But the gateway itself has to
 * tell its failures apart — a timeout is retryable, a malformed request is not —
 * and encoding that distinction in the public union would push provider-shaped
 * vocabulary all the way out to the client.
 *
 * So the distinction lives here, and `toApiError` collapses it at the service
 * boundary. Callers outside `src/server/ai` see only `RATE_LIMITED` or
 * `UNAVAILABLE`. Nothing here is ever displayed.
 *
 * ## Nothing carries provider text
 *
 * `AiGatewayError` has no field for a provider message, so there is no place to
 * put one. That is the point: a message field that existed "for debugging" is
 * how a provider string reaches a log sink, a monitoring payload, or a user.
 * The status code is kept because it is a number, not prose.
 */

/**
 * What went wrong, in the gateway's own terms.
 *
 * These are exhaustive over the failures the adapter can actually produce.
 * Anything the provider does that is not one of these becomes
 * `provider_unavailable`, because an unclassifiable failure is still a failure
 * and guessing at its meaning would be worse than treating it as an outage.
 */
export type AiFailureKind =
  /** The request exceeded the gateway's own deadline. */
  | "timeout"
  /** Atlas's own per-user limit denied the call before the provider saw it. */
  | "rate_limited"
  /** The provider answered 429. Distinct from `rate_limited`: different actor. */
  | "provider_overloaded"
  /** Provider 5xx, connection failure, or an unclassifiable transport error. */
  | "provider_unavailable"
  /** A non-retryable 4xx. An Atlas-side defect: bad key, bad request shape. */
  | "provider_rejected"
  /** A 200 whose body carried no usable text. */
  | "malformed_response";

/**
 * The retryable set, fixed by B2.
 *
 * A `Set` rather than a predicate with a `switch`, so that adding a kind without
 * deciding its retryability is impossible to do accidentally — the kind is
 * either listed here or it is not retried.
 *
 * `provider_rejected` is absent on purpose: a 400 or a 401 will fail identically
 * on the second attempt, so retrying it spends money and latency to reach the
 * same answer. `rate_limited` is absent because retrying inside the same request
 * would defeat the limit that just denied it.
 */
const RETRYABLE: ReadonlySet<AiFailureKind> = new Set<AiFailureKind>([
  "timeout",
  "provider_overloaded",
  "provider_unavailable",
]);

export function isRetryable(kind: AiFailureKind): boolean {
  return RETRYABLE.has(kind);
}

/**
 * Maps an HTTP status to a failure kind.
 *
 * 429 is separated from the rest of the 4xx range because it is the one client
 * error that is genuinely transient. Everything else in that range says the
 * request itself is wrong, which is an Atlas defect rather than an outage —
 * worth distinguishing internally even though both collapse to `UNAVAILABLE`
 * for the caller, because only one of them should page anyone.
 */
export function classifyStatus(status: number): AiFailureKind {
  if (status === 429) return "provider_overloaded";
  if (status >= 500) return "provider_unavailable";
  if (status >= 400) return "provider_rejected";

  // A 1xx/2xx/3xx reaching the failure path means the response was unusable
  // rather than the status being bad.
  return "malformed_response";
}

export interface AiGatewayErrorInit {
  /** Provider HTTP status, when there was one. Numbers only — never prose. */
  status?: number | undefined;
  /** How many attempts were made in total, including the first. */
  attempts?: number | undefined;
  /**
   * Seconds until Atlas's own limit resets. Set only for `rate_limited`.
   *
   * Carried because `rateLimitedResponse` needs it to emit `Retry-After`, and a
   * caller that cannot read it will either omit the header or invent a number —
   * and a 429 with no retry guidance provokes the tight retry loop the limiter
   * was added to prevent.
   */
  retryAfterSeconds?: number | undefined;
}

/**
 * The only error the gateway throws.
 *
 * The `message` is a fixed, developer-facing string derived from the kind, never
 * from the provider. It is safe in a stack trace because it contains nothing the
 * provider said.
 */
export class AiGatewayError extends Error {
  readonly kind: AiFailureKind;
  readonly status: number | undefined;
  readonly attempts: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: AiFailureKind, init: AiGatewayErrorInit = {}) {
    super(`AI gateway failure: ${kind}`);
    this.name = "AiGatewayError";
    this.kind = kind;
    this.status = init.status;
    this.attempts = init.attempts;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }

  /** True when this failure is worth another attempt. */
  get retryable(): boolean {
    return isRetryable(this.kind);
  }
}

/**
 * The user-facing message for every non-rate-limit failure.
 *
 * AI behavior §11: explain that the assistant is temporarily unavailable, and do
 * not expose provider errors. One message for every kind is deliberate — a user
 * cannot act on the difference between a 500 and a malformed body, and varying
 * the copy would leak the taxonomy this module exists to contain.
 */
export const AI_UNAVAILABLE_MESSAGE =
  "The assistant is temporarily unavailable. Please try again in a moment.";

/**
 * Collapses an internal kind to the closed public union.
 *
 * This is the boundary. Past this function no caller can tell a timeout from a
 * malformed response, which is the intended loss of detail.
 */
export function toApiError(kind: AiFailureKind, requestId: string): ApiEnvelope<never> {
  return kind === "rate_limited"
    ? fail("RATE_LIMITED", RATE_LIMITED_MESSAGE, requestId)
    : fail("UNAVAILABLE", AI_UNAVAILABLE_MESSAGE, requestId);
}

/**
 * The log-safe code for a kind.
 *
 * `LOG_FIELD_POLICY.errorCode` requires `^[A-Z][A-Z0-9_]{0,63}$`, so the kind is
 * upper-cased rather than passed through. The *internal* code is logged, not the
 * collapsed one: operators need to tell an outage from an Atlas-side defect, and
 * the log sink is a trusted destination in a way the client is not.
 */
export function toLogCode(kind: AiFailureKind): string {
  return kind.toUpperCase();
}
