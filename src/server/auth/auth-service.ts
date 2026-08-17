import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  isPlausibleEmail,
  readErrorStatus,
  toCallbackResultCode,
  toMagicLinkResultCode,
  toSessionCheckStatus,
  type SessionCheckStatus,
  type CallbackResult,
  type MagicLinkResult,
  type OAuthStartResult,
} from "@/lib/auth/auth-result";
import { logger } from "@/lib/telemetry/logger";

/**
 * Authentication operations (ATL-011).
 *
 * The two documented MVP methods and nothing else: **email magic link** (primary)
 * and **optional Google OAuth** (security §5). Passwords are not implemented and
 * must not be added here — §5 specifies a passwordless method, and a password
 * field would introduce credential storage, reset flows, and breach exposure the
 * specification deliberately avoids.
 *
 * Every function returns a closed result code. No provider error, message, or
 * status reaches the caller (`src/lib/auth/auth-result.ts` explains why).
 *
 * **No `server-only` marker, deliberately.** This module reads no secret, no
 * environment variable, and no request context — it is pure logic over an injected
 * `AuthClient`. The marker belongs on `supabase-server-client.ts`, which does read
 * those things, and it is applied there. Marking this file too would push its tests
 * into the integration project, which is gated off pull requests until ATL-027 —
 * and registration-neutrality is exactly the logic that must be verified on every
 * change. The layer boundaries in `eslint.config.mjs` already prevent
 * `src/components` importing anything under `src/server`.
 *
 * Scope boundaries:
 *   - Route protection is **ATL-012**. Nothing here guards a route.
 *   - Sign-out and session lifetimes are **ATL-013**.
 *   - The sign-in, verification, and expired-link screens are **ATL-014**.
 *   - Audit events for sign-in are **ATL-103**; the seam is noted below.
 */

/** The minimal client surface these operations need, so tests can supply a double. */
export type AuthClient = Pick<SupabaseClient["auth"], "signInWithOtp" | "signInWithOAuth"> & {
  exchangeCodeForSession: SupabaseClient["auth"]["exchangeCodeForSession"];
  getUser: SupabaseClient["auth"]["getUser"];
};

export interface MagicLinkOptions {
  email: string;
  /** Absolute URL the emailed link returns to. Must be an allowlisted redirect. */
  redirectTo: string;
}

/**
 * Sends a magic link.
 *
 * **`shouldCreateUser: true` is the security decision here, not a convenience.**
 * It makes sign-in and sign-up the same operation, so a first-time address and a
 * returning one follow an identical code path: same provider call, same work, same
 * response, same timing. That is what makes "we've sent a link if that address can
 * receive one" genuinely non-revealing rather than merely worded carefully — with
 * `shouldCreateUser: false` an unknown address would return faster and with a
 * different provider error, and the neutral wording would be a fig leaf over an
 * observable difference.
 *
 * Rate limiting is enforced by the provider today (`supabase/config.toml`
 * `[auth.rate_limit]`) and by the application in **ATL-086**; `rate_limited` is
 * already part of the result type so that ticket needs no signature change.
 */
export async function signInWithMagicLink(
  auth: AuthClient,
  { email, redirectTo }: MagicLinkOptions,
): Promise<MagicLinkResult> {
  const normalized = email.trim().toLowerCase();

  // A format check, deliberately not an account lookup — it cannot leak
  // registration status because it never consults the database.
  if (!isPlausibleEmail(normalized)) {
    return { code: "invalid_email" };
  }

  try {
    const { error } = await auth.signInWithOtp({
      email: normalized,
      options: { shouldCreateUser: true, emailRedirectTo: redirectTo },
    });

    return { code: toMagicLinkResultCode(error) };
  } catch {
    // A thrown transport failure, distinct from a returned AuthError.
    return { code: "unavailable" };
  }
}

/**
 * Begins Google OAuth and returns the consent URL.
 *
 * Optional per §5 — the application must work fully without it, so this returns
 * `unavailable` rather than throwing when the provider is not configured.
 *
 * **Identity linking:** both methods resolve to one identity per email. Supabase
 * links a Google identity to an existing user when the provider asserts the same
 * address *and* has verified it. Atlas relies on that verified-email assertion
 * rather than linking on address equality itself: linking on an unverified address
 * would let anyone who can create an account at an identity provider claim an
 * existing Atlas account by asserting its email. `skipBrowserRedirect` keeps the
 * redirect under server control instead of letting the SDK navigate.
 */
export async function signInWithGoogle(
  auth: AuthClient,
  { redirectTo }: { redirectTo: string },
): Promise<OAuthStartResult> {
  try {
    const { data, error } = await auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        skipBrowserRedirect: true,
        // Ask Google for the address so the verified-email link above can happen.
        scopes: "email profile",
      },
    });

    if (error || !data?.url) return { code: "unavailable" };
    return { code: "redirect_ready", url: data.url };
  } catch {
    return { code: "unavailable" };
  }
}

/**
 * Exchanges a callback code for a session, setting the session cookies.
 *
 * Used by both flows: the magic link and the OAuth return land on the same
 * callback with the same code parameter, so there is one consumption path and one
 * failure mode to reason about.
 */
export async function completeAuthCallback(
  auth: AuthClient,
  code: string,
): Promise<CallbackResult> {
  if (code.trim().length === 0) return { code: "link_invalid_or_expired" };

  try {
    const { error } = await auth.exchangeCodeForSession(code);
    return { code: toCallbackResultCode(error) };
  } catch {
    return { code: "unavailable" };
  }
}

/**
 * The verified current user, or `null`.
 *
 * Uses `getUser()`, which revalidates the token with the auth server, rather than
 * `getSession()`, which returns whatever the cookie contains. Only the former is
 * authorization evidence (architecture §5: "client state is not authorization
 * evidence" — and a cookie is client state until the server has checked it).
 *
 * ATL-012 builds route protection on top of this; ATL-011 only provides it.
 */
export async function getVerifiedUser(auth: AuthClient) {
  const result = await verifySession(auth);
  return result.status === "authenticated" ? result.user : null;
}

/**
 * The result of verifying the current session (ATL-111).
 *
 * `user` exists only on the authenticated branch, so a caller cannot read it
 * without having handled the other two — the discrimination is enforced by the
 * type rather than by remembering to check.
 */
export type SessionCheck =
  | { status: "authenticated"; user: User }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

/**
 * Verifies the session and says which of the three things happened (ATL-111).
 *
 * `getVerifiedUser` above is now a projection of this, kept because "the user or
 * nothing" is genuinely all some callers need. What it must never again be is
 * the *only* option: for anything that redirects, the difference between "no
 * session" and "could not check" is the difference between a correct sign-out
 * and telling a signed-in user a falsehood.
 *
 * A thrown error and a returned one are both provider failures and are treated
 * identically. `supabase-js` returns an `AuthRetryableFetchError` for a network
 * failure rather than throwing, but a DNS failure, an aborted request, or a
 * malformed response can still throw, and a `catch` that returned "no session"
 * would reintroduce the defect through the back door.
 */
/**
 * Classifies a `getUser()` failure and, when no verdict was reached, records
 * which kind of silence it was.
 *
 * ## Why the log lives here rather than at the throw site
 *
 * `require-user.ts` already logs `auth.provider_unavailable`, but by then the
 * error object is gone — only the mapped status survives the call. A 429, a 500
 * and a connection that never left Node were therefore indistinguishable in the
 * logs, which is the gap this closes. Classification itself is unchanged:
 * `toSessionCheckStatus` decides, exactly as before.
 *
 * ## What is recorded, and what cannot be
 *
 * Only two allowlisted fields carry the diagnosis — the numeric HTTP status when
 * the provider supplied one, and a constant naming the class otherwise. The
 * error's message, body, headers and any token or address inside them are never
 * read. `LOG_FIELD_POLICY` would drop an unknown key anyway, so this is enforced
 * by the logger as well as by intent.
 */
function classifySessionFailure(error: unknown): Exclude<SessionCheckStatus, "authenticated"> {
  const status = toSessionCheckStatus(error);

  /** A 4xx is a verdict, not an outage. It redirects, and needs no log. */
  if (status !== "unavailable") return status;

  const providerStatus = readErrorStatus(error);

  logger.error("auth.verify_unavailable", {
    /*
      `auth.session`, not `auth.verify_session`: `LOG_FIELD_POLICY` requires
      `operation` to match /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/, so an underscore
      makes the field fail redaction and vanish from the record. The existing
      call in `require-user.ts` passes `auth.verify_session` and has therefore
      been logging no operation at all — worth a separate follow-up, and not
      changed here.
    */
    operation: "auth.session",
    provider: "auth",
    providerAvailable: false,
    ...(providerStatus === undefined ? {} : { status: providerStatus }),
    errorCode:
      providerStatus === undefined ? "PROVIDER_STATUS_NONE" : `PROVIDER_STATUS_${providerStatus}`,
  });

  return status;
}

export async function verifySession(auth: AuthClient): Promise<SessionCheck> {
  try {
    const { data, error } = await auth.getUser();

    if (error) return { status: classifySessionFailure(error) };

    // No error and no user is the provider answering plainly: there is no
    // session. This is the ordinary signed-out path and must keep redirecting.
    return data.user ? { status: "authenticated", user: data.user } : { status: "unauthenticated" };
  } catch (error) {
    return { status: classifySessionFailure(error) };
  }
}
