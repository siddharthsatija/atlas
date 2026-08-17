/**
 * Registration-neutral authentication results (ATL-011).
 *
 * Security §5: "Do not reveal whether an email address is registered." That rule
 * is easy to state and easy to break by accident — a provider error string
 * forwarded to the UI, a different redirect for unknown addresses, or a faster
 * response when there is no user to look up all leak the same fact.
 *
 * So the outcome of an authentication attempt is expressed as a **closed set of
 * codes**, defined here as pure data. Nothing from the provider reaches the caller:
 * the service maps to one of these and the UI renders copy for the code. There is
 * no field capable of carrying a provider message, which means no future caller
 * can forward one by mistake.
 *
 * Copy for each code belongs to **ATL-014**, which owns the authentication screens.
 * This module deliberately defines meaning, not wording.
 */

/**
 * The result of requesting a magic link.
 *
 * Note what is *not* here: no "unknown email", no "account exists", no "signup
 * required". Those distinctions are precisely what must not be observable.
 */
export type MagicLinkResultCode =
  /**
   * A link has been sent **if the address can receive one**. Returned for both
   * registered and unregistered addresses — see `signInWithMagicLink` for why
   * this is genuinely indistinguishable rather than merely worded that way.
   */
  | "verification_sent"
  /** The address is not a valid email. A format check, not an account lookup. */
  | "invalid_email"
  /** Too many attempts. Independent of whether the address is registered. */
  | "rate_limited"
  /** The provider is unavailable. Never includes the provider's own message. */
  | "unavailable";

/** The result of consuming a magic link or OAuth callback. */
export type CallbackResultCode =
  | "session_established"
  /**
   * One code for expired, already-used, malformed, and unknown links.
   *
   * Distinguishing them would tell an attacker holding a stolen link whether it
   * was ever valid, so they collapse deliberately. The user-facing recovery is
   * identical in every case: request a new link.
   */
  | "link_invalid_or_expired"
  | "unavailable";

export type OAuthStartResultCode = "redirect_ready" | "unavailable";

export interface MagicLinkResult {
  code: MagicLinkResultCode;
}

export interface CallbackResult {
  code: CallbackResultCode;
}

export interface OAuthStartResult {
  code: OAuthStartResultCode;
  /** Provider consent URL. Present only when `code` is "redirect_ready". */
  url?: string;
}

/** Minimal email shape check. Deliberately not an account lookup. */
export function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 && trimmed.length <= 254 && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(trimmed)
  );
}

/**
 * Codes that indicate the provider rate-limited the attempt.
 *
 * Matched on Supabase's stable error codes rather than message text, which is
 * not a stable interface.
 */
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  "over_email_send_rate_limit",
  "over_request_rate_limit",
  "over_sms_send_rate_limit",
]);

/**
 * Maps a provider error to a registration-neutral magic-link code.
 *
 * Anything that could distinguish a known from an unknown address — "user not
 * found", "signups not allowed", "email not confirmed" — resolves to
 * `verification_sent`, the same code a successful send returns. The user is told
 * to check their inbox either way, which is true: for a registered address a link
 * arrives, and for an address that cannot receive one, nothing does. The attempt
 * discloses nothing.
 */
export function toMagicLinkResultCode(error: unknown): MagicLinkResultCode {
  const code = readErrorCode(error);

  if (code !== undefined && RATE_LIMIT_CODES.has(code)) return "rate_limited";

  if (
    code === "validation_failed" ||
    code === "email_address_invalid" ||
    code === "email_address_not_authorized"
  ) {
    // Address-shape and allowlist rejections are properties of the address, not
    // of an account, so they are safe to surface as an invalid address.
    return "invalid_email";
  }

  if (code !== undefined && IDENTITY_REVEALING_CODES.has(code)) {
    // The whole point: these would disclose registration status.
    return "verification_sent";
  }

  return error === undefined || error === null ? "verification_sent" : "unavailable";
}

/**
 * Provider outcomes that describe *the account*, not the request. Every one of
 * these must be indistinguishable from success.
 */
const IDENTITY_REVEALING_CODES: ReadonlySet<string> = new Set([
  "user_not_found",
  "signup_disabled",
  "email_not_confirmed",
  "user_banned",
  "identity_already_exists",
  "email_exists",
]);

/** Maps a provider error to a callback code. All link failures collapse to one. */
export function toCallbackResultCode(error: unknown): CallbackResultCode {
  if (error === undefined || error === null) return "session_established";

  const code = readErrorCode(error);
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) return "unavailable";

  // Everything else — expired, consumed, forged, malformed — is one outcome.
  return "link_invalid_or_expired";
}

/**
 * What verifying the current session established (ATL-111).
 *
 * Three outcomes, because there are three situations and only two were ever
 * represented:
 *
 *   - `authenticated` — the provider confirmed the token.
 *   - `unauthenticated` — the provider answered, and the answer is no session.
 *   - `unavailable` — the provider did not answer. Nothing is known about the
 *     session either way.
 *
 * Collapsing the third into the second is what sent signed-in users to
 * `/sign-in` during a provider outage: Atlas told them they were signed out
 * when the truth was that it could not check. The distinction exists to be
 * *reported honestly*, not to relax anything — no caller may render protected
 * content on `unavailable`, because an unverified token is not authorization
 * evidence (architecture §5).
 */
export type SessionCheckStatus = "authenticated" | "unauthenticated" | "unavailable";

/**
 * Classifies a `getUser()` failure as "the provider said no" or "the provider
 * did not say".
 *
 * Keyed on **HTTP status**, deliberately, rather than on the error-code
 * vocabulary the magic-link mappers use. A status is the most stable signal
 * Supabase exposes and it answers exactly the question being asked: a 4xx is the
 * auth server giving a definitive verdict on this token, while a 429, a 5xx, or
 * no status at all means no verdict was reached. Codes churn between provider
 * releases; the semantics of 401 versus 503 do not.
 *
 * The unclassifiable case resolves to `unavailable`. Both outcomes deny access —
 * neither renders anything — so the default is a question of what the user is
 * *told*, and claiming "you are signed out" on evidence Atlas does not have is
 * the failure this whole change exists to remove.
 */
export function toSessionCheckStatus(error: unknown): Exclude<SessionCheckStatus, "authenticated"> {
  const status = readErrorStatus(error);

  // Explicitly not "unauthenticated": 429 is the provider declining to answer.
  // Local development hits this the moment a test run exhausts an hourly limit.
  if (status === 429) return "unavailable";

  // A definitive verdict: no session, an expired token, a forged one, or a user
  // that no longer exists. This is the path a genuinely signed-out request takes.
  if (status !== undefined && status >= 400 && status < 500) return "unauthenticated";

  return "unavailable";
}

/**
 * Reads a Supabase `AuthError.status` without trusting the shape.
 *
 * Same defensive reasoning as `readErrorCode`: the value crosses a provider
 * boundary as `unknown`, and a transport failure arrives as an error object with
 * no status at all — which is itself the signal that no verdict was reached.
 */
export function readErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const status: unknown = (error as { status?: unknown }).status;
    return typeof status === "number" && Number.isFinite(status) ? status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a Supabase `AuthError.code` without trusting the shape.
 *
 * Wrapped because this value crosses a provider boundary as `unknown`, and a
 * throwing getter here would surface inside an auth handler.
 */
function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}
