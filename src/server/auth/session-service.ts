import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Session revocation (ATL-013).
 *
 * Two scopes, and the difference matters to a user who suspects compromise:
 *
 *  - **Current device** (`local`) — clears this browser's session only. Other
 *    devices stay signed in. The everyday "sign out" action.
 *  - **All devices** (`global`) — revokes every refresh token for the user at the
 *    provider, so every other browser and device is signed out at its next
 *    request. The action a user takes after losing a laptop.
 *
 * Both return a closed result code. Provider errors never reach the caller, for
 * the same reason as ATL-011: the copy a user sees is chosen from a fixed
 * vocabulary, not forwarded from a third party.
 *
 * No `server-only` marker — like `auth-service.ts`, this is pure logic over an
 * injected client and reads no secret or request context. The marker sits on
 * `supabase-server-client.ts`, and keeping it off here is what allows these tests
 * to run in the unit project on every pull request.
 *
 * The session-management **UI** (active sessions, sign-out-all control) is
 * **ATL-075**. This ticket provides the operations it will call.
 */

export type SignOutScope = "local" | "global";

export type SignOutResultCode =
  /** The session was revoked. */
  | "signed_out"
  /**
   * The provider could not be reached or refused.
   *
   * Deliberately not fatal to the caller: local cookies are cleared regardless,
   * so the user is signed out of *this* browser even when the provider call
   * fails. Leaving someone apparently signed in because a network call failed is
   * the worse outcome, especially for the person who just lost a device.
   */
  | "unavailable";

export interface SignOutResult {
  code: SignOutResultCode;
  scope: SignOutScope;
}

/** Minimal client surface, so tests supply a double rather than a real client. */
export type SessionClient = {
  signOut: SupabaseClient["auth"]["signOut"];
};

/**
 * Revokes the session at the given scope.
 *
 * AUDIT SEAM (ATL-103): sign-out and especially sign-out-all are security events
 * and will emit audit records from here. Deliberately not written yet — the audit
 * writer and its per-subject hash chain are that ticket, and a partially written
 * chain is worse than no chain.
 */
export async function signOut(auth: SessionClient, scope: SignOutScope): Promise<SignOutResult> {
  try {
    const { error } = await auth.signOut({ scope });
    return { code: error ? "unavailable" : "signed_out", scope };
  } catch {
    return { code: "unavailable", scope };
  }
}

/** Signs out of this browser only. */
export function signOutCurrentDevice(auth: SessionClient): Promise<SignOutResult> {
  return signOut(auth, "local");
}

/**
 * Revokes every refresh token for the user.
 *
 * Not gated behind reauthentication. Security §5 requires reauthentication before
 * "session revocation", but read in context that protects revoking *someone
 * else's* session from the settings screen — the case ATL-075 builds. Requiring a
 * fresh sign-in before a user can sign themselves out everywhere would obstruct
 * exactly the person acting on a suspected compromise, and the action is purely
 * protective: its worst outcome is having to sign in again.
 */
export function signOutAllDevices(auth: SessionClient): Promise<SignOutResult> {
  return signOut(auth, "global");
}
