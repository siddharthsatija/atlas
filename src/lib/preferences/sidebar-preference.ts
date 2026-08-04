/**
 * Sidebar collapse preference (ATL-006).
 *
 * Frontend §3 requires the collapse state to "persist preference per user".
 * `profiles` (ATL-015) and sessions (ATL-012) are both M2 — after this ticket —
 * so there is no authenticated user to key a row against and no migration to
 * write against. ATL-006 depends only on ATL-005.
 *
 * The preference is therefore stored in a **cookie written by a Server Action and
 * read by a Server Component**. That is the server-side option available today:
 *
 *   - It is not browser storage. `localStorage`/`sessionStorage` are prohibited
 *     (CLAUDE.md, lint-enforced); cookies are the documented mechanism in
 *     security §5, and this one is `HttpOnly`, so client script cannot read it.
 *   - The value is resolved during server rendering, so the sidebar arrives in
 *     the correct state — no expanded-then-collapsed flash on every navigation,
 *     which a client-state approach cannot avoid.
 *   - It survives sessions, which is what "persists across sessions" requires.
 *
 * **Migration path (ATL-015):** once `profiles` exists, this moves to a column and
 * the cookie becomes a pre-authentication fallback. The read/write surface is these
 * two functions plus the action, so the change is contained.
 *
 * This module is deliberately pure — no `next/headers`, no I/O — so the encoding
 * rules are unit-testable and `lib/` stays a leaf layer.
 */

/**
 * Cookie name. Prefixed and explicit about being a UI preference, so it is
 * obviously not a credential to anyone reading a request.
 */
export const SIDEBAR_COLLAPSED_COOKIE = "atlas.ui.sidebar-collapsed";

/** Frontend §3 requires persistence across sessions, so this outlives one. */
export const SIDEBAR_PREFERENCE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Cookie attributes.
 *
 * `httpOnly` even though this is not a secret: nothing client-side needs to read
 * it (the server resolves the state during render), so withholding it costs
 * nothing and keeps the value out of any script that runs on the page.
 *
 * `sameSite: "lax"` because a UI preference has no business travelling with
 * cross-site requests.
 */
export function sidebarPreferenceCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecure,
    path: "/",
    maxAge: SIDEBAR_PREFERENCE_MAX_AGE_SECONDS,
  };
}

/** Serialises the preference. Kept explicit rather than relying on `String()`. */
export function serializeSidebarCollapsed(collapsed: boolean): string {
  return collapsed ? "1" : "0";
}

/**
 * Reads the preference from a raw cookie value.
 *
 * Anything other than the exact stored encoding — absent, malformed, tampered —
 * resolves to `false` (expanded). A cookie is user-controlled input, so this
 * accepts only what it writes and defaults to the state that shows the most
 * information rather than the least.
 */
export function parseSidebarCollapsed(value: string | undefined): boolean {
  return value === "1";
}
