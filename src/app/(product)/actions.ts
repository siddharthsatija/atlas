"use server";

import { cookies } from "next/headers";
import { requireVerifiedUser } from "@/server/auth/require-user";
import {
  SIDEBAR_COLLAPSED_COOKIE,
  serializeSidebarCollapsed,
  sidebarPreferenceCookieOptions,
} from "@/lib/preferences/sidebar-preference";

/**
 * Server Actions for the product shell (ATL-006).
 *
 * Lives in the route group rather than `src/server/` because the layer boundaries
 * (eslint `import/no-restricted-paths`) forbid `src/components` importing from
 * `src/server` or `src/features`. The action is passed *into* the shell as a prop
 * by the layout, so the client component never imports server code at all —
 * which also means the sidebar can be tested with a plain spy rather than a mock
 * of the server module.
 */

/**
 * Persists the sidebar collapse preference.
 *
 * Deliberately takes a boolean and nothing else. There is no user ID parameter
 * and there could not be one: "never trust client-provided user IDs"
 * (CLAUDE.md). When ATL-015 moves this to `profiles`, the owner comes from the
 * server-side session, never from the caller.
 *
 * No `revalidatePath`. The client applies the new state immediately and the
 * cookie only needs to be correct for the *next* server render — revalidating
 * would re-render the whole product tree to reproduce a layout change the
 * browser has already made.
 */
export async function setSidebarCollapsed(collapsed: boolean): Promise<void> {
  /**
   * Authenticate before touching the argument (ATL-012, architecture §10:
   * "authenticate before reading body data when possible").
   *
   * Server Actions are independently invocable POST endpoints — being reachable
   * only from a protected page in the UI is not protection. The check is first so
   * an unauthenticated caller gets a redirect rather than a cookie write.
   */
  await requireVerifiedUser();

  const store = await cookies();

  store.set(
    SIDEBAR_COLLAPSED_COOKIE,
    serializeSidebarCollapsed(collapsed),
    // Secure everywhere except local HTTP development, where the browser would
    // reject the cookie and the preference would silently never persist.
    sidebarPreferenceCookieOptions(process.env.NODE_ENV === "production"),
  );
}
