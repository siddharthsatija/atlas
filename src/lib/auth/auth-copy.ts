/**
 * Authentication copy (ATL-014).
 *
 * ATL-011 deliberately defined *meaning* as a closed set of codes and left the
 * wording to this ticket. This module is that wording, and it is kept pure and
 * separate from the components so the neutrality rule can be tested as data
 * rather than inferred from rendered markup.
 *
 * Two rules govern every string here:
 *
 *  1. **Nothing reveals whether an address is registered** (security §5). The
 *     `verification_sent` copy must read identically for a returning user and a
 *     first-time one, because it *is* identical — sign-in and sign-up are one
 *     operation (ATL-011).
 *  2. **No misleading security claims** (frontend §16). Atlas does not promise
 *     that a link is "secure", that an inbox is safe, or that anything is
 *     encrypted end to end.
 *
 * Tone follows frontend §23: calm, direct, transparent, nonjudgmental.
 */

import type { MagicLinkResultCode } from "./auth-result";

/**
 * Reasons a redirect can carry in the `reason` query parameter.
 *
 * `link_invalid_or_expired` and `unavailable` come from the ATL-011 callback;
 * `session_idle` and `session_expired` from the ATL-013 lifetime enforcement.
 */
export type SignInReasonCode =
  "link_invalid_or_expired" | "unavailable" | "session_idle" | "session_expired";

const REASON_CODES: ReadonlySet<string> = new Set<SignInReasonCode>([
  "link_invalid_or_expired",
  "unavailable",
  "session_idle",
  "session_expired",
]);

/**
 * Validates the `reason` parameter against the closed vocabulary.
 *
 * The value arrives from the URL, so it is untrusted input: rendering it directly
 * would be a reflected-content hole, and accepting an unknown value would let
 * anyone craft a link that puts arbitrary text on the sign-in screen. Anything
 * unrecognised resolves to `null` and no message is shown.
 */
export function parseSignInReason(value: string | null | undefined): SignInReasonCode | null {
  return typeof value === "string" && REASON_CODES.has(value) ? (value as SignInReasonCode) : null;
}

/** How prominently a message is presented. Never used as the only signal. */
export type MessageTone = "info" | "success" | "warning";

export interface AuthMessage {
  title: string;
  description: string;
  tone: MessageTone;
}

/**
 * Copy for the outcome of requesting a magic link.
 *
 * `verification_sent` is the load-bearing one. "If that address can receive a
 * link" is precise rather than evasive: Atlas genuinely does not check whether an
 * account exists before sending, so the sentence is true and gives away nothing.
 * Saying "we've sent you a link" would be a small lie for an address that cannot
 * receive one; saying "no account found" would be the disclosure §5 forbids.
 */
export const MAGIC_LINK_MESSAGES: Readonly<Record<MagicLinkResultCode, AuthMessage>> = {
  verification_sent: {
    title: "Check your email",
    description:
      "If that address can receive a sign-in link, one is on its way. The link works once and expires after an hour.",
    tone: "success",
  },
  invalid_email: {
    title: "Check the email address",
    description: "That does not look like an email address. Check it and try again.",
    tone: "warning",
  },
  rate_limited: {
    title: "Too many attempts",
    description:
      "Too many sign-in requests have been made recently. Wait a few minutes and try again.",
    tone: "warning",
  },
  unavailable: {
    title: "Sign-in is unavailable",
    description: "Something went wrong on our side, so no link was sent. Please try again shortly.",
    tone: "warning",
  },
};

/**
 * Copy for a redirect reason.
 *
 * The two session-lifetime reasons are separated because the recovery differs in
 * the user's mind even though the action is the same: "you were away" is
 * reassuring, "sessions end after 90 days" explains a sign-out that arrived with
 * no idle period and would otherwise look like a fault.
 */
export const SIGN_IN_REASON_MESSAGES: Readonly<Record<SignInReasonCode, AuthMessage>> = {
  link_invalid_or_expired: {
    title: "That link no longer works",
    description:
      "Sign-in links expire and can only be used once. Enter your email below to get a new one.",
    tone: "info",
  },
  unavailable: {
    title: "Sign-in is unavailable",
    description: "Something went wrong on our side. Please try again shortly.",
    tone: "warning",
  },
  session_idle: {
    title: "You were signed out",
    description: "Atlas signs you out after a period of inactivity. Sign in again to continue.",
    tone: "info",
  },
  session_expired: {
    title: "You were signed out",
    description: "Sessions end after 90 days, whatever the activity. Sign in again to continue.",
    tone: "info",
  },
};

/**
 * Why an account is needed (frontend §16: "explain why an account is needed").
 *
 * Deliberately factual about what Atlas is and is not. It does not claim to scan
 * anything, to delete anything on the user's behalf, or to encrypt end to end —
 * all claims the product honesty rules forbid.
 */
export const SIGN_IN_PURPOSE =
  "Atlas keeps a private record of the accounts and services connected to your digital identity. An account is needed so that record stays yours alone.";

/** Applies to both methods. States the mechanism plainly, promising nothing. */
export const SIGN_IN_METHOD_NOTE =
  "We email you a link to sign in. There is no password to remember.";
