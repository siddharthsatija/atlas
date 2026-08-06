/**
 * The typed API response envelope (architecture §10).
 *
 * Every route handler returns this shape, success or failure:
 *
 * ```json
 * { "data": {}, "error": null, "requestId": "uuid" }
 * { "data": null, "error": { "code": "RATE_LIMITED", "message": "..." }, "requestId": "uuid" }
 * ```
 *
 * Introduced by ATL-086 because the 429 path needs it, but written for every
 * consumer named in the ticket list — ATL-072's collection endpoints and the
 * M7/M8/M11 handlers all reference "the typed error envelope".
 *
 * In `lib/` rather than `server/` so the client can narrow on `code` when
 * rendering a failure. The layer boundaries stop components importing
 * `src/server`, and a duplicated copy of these codes for the UI is how a client
 * ends up branching on a code the server stopped sending.
 *
 * ## Codes are a closed set
 *
 * A free-string code cannot be exhaustively handled, and the failure shows up as
 * a UI that silently renders nothing for a case nobody anticipated. The union
 * also keeps provider errors out: architecture §10 requires typed codes rather
 * than raw provider text, and there is no variant here to smuggle one into.
 *
 * ## `message` is for humans, never for machines
 *
 * Callers branch on `code`. `message` is short, calm, and safe to display — it
 * never carries a provider message, a stack, an identifier, or anything from the
 * "Never capture" list in architecture §16.
 */

/**
 * Application error codes.
 *
 * Grows with the tickets that introduce the failures. Only the codes ATL-086
 * actually produces are listed; inventing the rest now would mean guessing at
 * behaviour those tickets own.
 */
export const API_ERROR_CODES = [
  /** Too many requests in the window (ATL-086). */
  "RATE_LIMITED",
  /** Input failed validation (architecture §10). */
  "INVALID_REQUEST",
  /** No verified session. */
  "UNAUTHENTICATED",
  /** Authenticated, but not permitted. */
  "FORBIDDEN",
  /**
   * The entity does not exist, **or** does not belong to the caller (ATL-030).
   *
   * Those two cases are deliberately indistinguishable. ATL-034 requires a
   * cross-user asset access to answer 404 rather than 403, because `FORBIDDEN`
   * on a record you do not own confirms that the record exists — a small leak,
   * but one that turns a guessed id into an oracle.
   */
  "NOT_FOUND",
  /** A dependency is unavailable. Never carries the provider's own message. */
  "UNAVAILABLE",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  code: ApiErrorCode;
  /** Calm, human-readable, safe to display. Never a provider message. */
  message: string;
}

export interface ApiEnvelope<T> {
  data: T | null;
  error: ApiError | null;
  requestId: string;
}

/** A successful envelope. */
export function ok<T>(data: T, requestId: string): ApiEnvelope<T> {
  return { data, error: null, requestId };
}

/** A failure envelope. `data` is null so a caller cannot read a partial result. */
export function fail(code: ApiErrorCode, message: string, requestId: string): ApiEnvelope<never> {
  return { data: null, error: { code, message }, requestId };
}

/**
 * The user-facing rate-limit message.
 *
 * Deliberately calm and non-accusatory (ATL-086: "UI shows a calm retry
 * message"). It does not say what the limit is, how many attempts remain, or
 * whether the address is registered — a limit message that leaked any of those
 * would be an enumeration oracle wearing an apology.
 */
export const RATE_LIMITED_MESSAGE = "Too many attempts. Please wait a moment and try again.";

export interface RateLimitedResponseInit {
  requestId: string;
  /** Whole seconds until the window resets. Sent as `Retry-After`. */
  retryAfterSeconds: number;
}

/**
 * Builds the 429 body and headers.
 *
 * Returns the parts rather than a `Response` so this module stays free of
 * framework imports and can be asserted on directly in tests — the envelope is
 * the contract, not the `NextResponse` wrapper around it.
 *
 * `Retry-After` is included because a client that does not know when to retry
 * will retry immediately, and a rate limiter that provokes tight retry loops
 * makes the load it was added to shed.
 */
export function rateLimitedResponse({ requestId, retryAfterSeconds }: RateLimitedResponseInit): {
  status: 429;
  body: ApiEnvelope<never>;
  headers: Record<string, string>;
} {
  return {
    status: 429,
    body: fail("RATE_LIMITED", RATE_LIMITED_MESSAGE, requestId),
    headers: {
      "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))),
      "cache-control": "no-store",
    },
  };
}
