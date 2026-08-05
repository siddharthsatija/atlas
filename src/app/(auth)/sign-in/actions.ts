"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/config/env";
import { createSupabaseServerClient } from "@/server/auth/supabase-server-client";
import { signInWithGoogle, signInWithMagicLink } from "@/server/auth/auth-service";
import type { MagicLinkFormState } from "./form-state";
import {
  RETURN_PATH_COOKIE,
  returnPathCookieOptions,
  toSafeReturnPath,
} from "@/lib/auth/return-path";
import {
  RATE_LIMIT_POLICIES,
  RateLimiter,
  clientAddressFrom,
  type RateLimitIdentifier,
} from "@/server/rate-limit/rate-limit";

/**
 * Sign-in Server Actions (ATL-014).
 *
 * Server Actions rather than a route handler: Next.js applies origin checking, so
 * a cross-site POST cannot trigger a sign-in email for an arbitrary address.
 *
 * Both actions do the same three things — validate the return path, remember it,
 * hand off to the ATL-011 service — and neither interprets a provider response.
 * The result is one of ATL-011's closed codes, and the screen renders copy for it.
 */

/**
 * The caller's address as a rate-limit identifier, or nothing.
 *
 * An unidentifiable caller contributes no key rather than a shared placeholder:
 * bucketing everyone whose address cannot be read under one counter would let a
 * single one of them exhaust the window for all the others.
 */
function addressIdentifier(requestHeaders: Headers): RateLimitIdentifier[] {
  const address = clientAddressFrom(requestHeaders);
  return address ? [{ kind: "ip", value: address }] : [];
}

/** Absolute URL the provider returns to. Must be an allowlisted redirect target. */
function callbackUrl(): string {
  return new URL("/auth/callback", env.NEXT_PUBLIC_APP_URL).toString();
}

/**
 * Stores the validated return path for the callback to consume.
 *
 * Validation happens here, on the way in, and again in the callback on the way
 * out. Double validation is not redundant: the cookie round-trips through the
 * browser, and a value that has left the server is untrusted input when it
 * returns.
 */
async function rememberReturnPath(rawNext: FormDataEntryValue | null): Promise<void> {
  const safe = typeof rawNext === "string" ? toSafeReturnPath(rawNext) : null;
  const store = await cookies();

  if (safe === null) {
    // Clear any stale value rather than leaving a previous attempt's target in
    // place, which would send the user somewhere they did not ask for.
    store.delete(RETURN_PATH_COOKIE);
    return;
  }

  store.set(RETURN_PATH_COOKIE, safe, returnPathCookieOptions(env.ATLAS_ENV !== "local"));
}

/**
 * Requests a magic link.
 *
 * Returns a result code rather than redirecting: the user stays on the page and
 * sees the verification state, which is what lets them retry without losing their
 * place. The address is never echoed back in a URL.
 */
export async function requestMagicLinkAction(
  previous: MagicLinkFormState,
  formData: FormData,
): Promise<MagicLinkFormState> {
  const email = formData.get("email");
  await rememberReturnPath(formData.get("next"));

  const attempt = previous.attempt + 1;

  if (typeof email !== "string") {
    return { code: "invalid_email", attempt };
  }

  /**
   * Rate limit before contacting the provider (ATL-086, security §5).
   *
   * Keyed on the caller's address *and* the requested email, because the two
   * catch different attacks: one host spraying many addresses trips the IP key,
   * while a distributed attempt bombing a single inbox trips the address key.
   *
   * Checked here rather than after the provider call so a refused attempt costs
   * nothing downstream and sends no mail. The result is the existing
   * `rate_limited` code from ATL-011, so the screen already has copy for it and
   * the response stays indistinguishable from any other outcome — a limit
   * message that behaved differently for registered addresses would be the
   * enumeration oracle security §5 forbids.
   */
  const limit = await RateLimiter.create().check(RATE_LIMIT_POLICIES.signIn, [
    ...addressIdentifier(await headers()),
    { kind: "email", value: email.trim().toLowerCase() },
  ]);

  if (!limit.allowed) {
    return { code: "rate_limited", attempt };
  }

  const supabase = await createSupabaseServerClient();
  const result = await signInWithMagicLink(supabase.auth, {
    email,
    redirectTo: callbackUrl(),
  });

  return { code: result.code, attempt };
}

/**
 * Starts Google sign-in.
 *
 * Optional per security §5, so an unconfigured provider sends the user back to
 * the sign-in screen with the neutral `unavailable` reason rather than to an
 * error page. The consent URL is built server-side and redirected to here — it is
 * never handed to the browser to navigate itself.
 */
export async function startGoogleSignInAction(formData: FormData): Promise<never> {
  await rememberReturnPath(formData.get("next"));

  const supabase = await createSupabaseServerClient();
  const result = await signInWithGoogle(supabase.auth, { redirectTo: callbackUrl() });

  if (result.code !== "redirect_ready" || !result.url) {
    redirect("/sign-in?reason=unavailable");
  }

  redirect(result.url);
}
