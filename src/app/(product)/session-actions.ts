"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createSupabaseServerClient } from "@/server/auth/supabase-server-client";
import { signOutAllDevices, signOutCurrentDevice } from "@/server/auth/session-service";
import { SIGN_IN_PATH } from "@/lib/auth/return-path";
import { SESSION_SEEN_COOKIE, SESSION_STARTED_COOKIE } from "@/lib/auth/session-lifetime";

/**
 * Sign-out Server Actions (ATL-013).
 *
 * Server Actions rather than route handlers: Next.js gives actions origin
 * checking, so a cross-site POST cannot sign a user out. A `GET /sign-out` route
 * would be worse still — any `<img>` tag on any page could trigger it.
 *
 * The controls that call these live in Settings → Security, which is **ATL-075**.
 * This ticket provides the operations; that one provides the screen.
 *
 * Neither action verifies a session first, and that is deliberate. Signing out is
 * idempotent and protective: an expired or already-revoked session should still
 * clear local cookies and land the user at sign-in, not error. Guarding it would
 * mean a user with a half-broken session could not complete the one action that
 * would fix it.
 */

/** Clears the lifetime markers (ATL-013) alongside the provider's own cookies. */
async function clearSessionMarkers(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_STARTED_COOKIE);
  store.delete(SESSION_SEEN_COOKIE);
}

/**
 * Signs out of this browser.
 *
 * Redirects unconditionally, whatever the provider returned: the local session is
 * gone either way, and reporting a provider failure here would leave the user
 * staring at an error on a page they no longer have access to.
 */
export async function signOutAction(): Promise<never> {
  const supabase = await createSupabaseServerClient();
  await signOutCurrentDevice(supabase.auth);
  await clearSessionMarkers();

  redirect(SIGN_IN_PATH);
}

/**
 * Revokes every session for this user, on every device.
 *
 * The provider invalidates all refresh tokens, so other browsers lose access at
 * their next request rather than when their access token happens to expire.
 */
export async function signOutAllDevicesAction(): Promise<never> {
  const supabase = await createSupabaseServerClient();
  await signOutAllDevices(supabase.auth);
  await clearSessionMarkers();

  redirect(SIGN_IN_PATH);
}
