import "server-only";

import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "./supabase-server-client";
import { getVerifiedUser } from "./auth-service";
import { SIGN_IN_PATH, buildSignInPath } from "@/lib/auth/return-path";

/**
 * Server-side session enforcement (ATL-012).
 *
 * The authoritative check. Middleware redirects earlier and avoids rendering
 * work, but its coverage is decided by a matcher glob, and a route accidentally
 * excluded from that glob would render protected content with no error anywhere.
 * This runs where the data is actually assembled, so protection does not depend
 * on routing configuration being correct.
 *
 * Built on `getVerifiedUser` from ATL-011, which calls `getUser()` and therefore
 * revalidates the token with the auth server rather than trusting the cookie.
 */

/**
 * Returns the verified user, or redirects to sign-in.
 *
 * `redirect()` throws, so this never returns for an unauthenticated request —
 * callers can treat the result as always present. That control flow is why the
 * check must come *before* any data access in a layout or action: there is no
 * path where a caller can accidentally continue with a null user.
 *
 * @param returnPath Path to preserve for after sign-in. Validated and truncated
 *   to its top-level section by `buildSignInPath`; unsafe values are dropped.
 */
export async function requireVerifiedUser(returnPath?: string): Promise<User> {
  const supabase = await createSupabaseServerClient();
  const user = await getVerifiedUser(supabase.auth);

  if (!user) {
    redirect(returnPath === undefined ? SIGN_IN_PATH : buildSignInPath(returnPath));
  }

  return user;
}
