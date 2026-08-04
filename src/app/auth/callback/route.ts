import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/server/auth/supabase-server-client";
import { completeAuthCallback } from "@/server/auth/auth-service";
import { RETURN_PATH_COOKIE, SIGN_IN_PATH, resolvePostSignInPath } from "@/lib/auth/return-path";

/**
 * Authentication callback (ATL-011).
 *
 * The single landing point for both documented methods: the emailed magic link
 * and the Google OAuth return arrive here with a `code` parameter and are consumed
 * by the same exchange. One consumption path means one place where session cookies
 * are written and one failure mode to reason about.
 *
 * The path is `/auth/callback` — a literal segment, not the `(auth)` route group,
 * which contributes no URL segment. It matches `additional_redirect_urls` already
 * configured in `supabase/config.toml` (ATL-003).
 *
 * ROUTE-HANDLER JUSTIFICATION (`src/app/api/README.md`): the provider redirects
 * the browser here with a query parameter, which only a route handler can receive.
 * A Server Action cannot be a redirect target.
 *
 * `dynamic = "force-dynamic"` because this reads the request and writes cookies —
 * a cached auth callback would be a session-fixation hazard.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Default destination after a successful sign-in.
 *
 * Used when there is no remembered return path. The URL's own `next` parameter is
 * still ignored — honouring it would make this an open redirect, and this callback
 * is reachable by anything that follows links in email. The return path instead
 * comes from a cookie this origin set before the round trip (ATL-014), and is
 * revalidated by `resolvePostSignInPath` because it has been through the browser.
 */
const DEFAULT_POST_SIGN_IN_PATH = "/overview";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  /**
   * The provider can return its own error (a cancelled Google consent, an expired
   * link). It is not forwarded: `error_description` is provider text that may name
   * the account, and distinguishing "cancelled" from "expired" tells a holder of a
   * stolen link whether it was ever valid. Both collapse to one neutral code.
   */
  if (!code) {
    return redirectTo(request, SIGN_IN_PATH, "link_invalid_or_expired");
  }

  const supabase = await createSupabaseServerClient();
  const result = await completeAuthCallback(supabase.auth, code);

  if (result.code === "session_established") {
    // AUDIT SEAM (ATL-103): a successful sign-in is a security event and will
    // emit an audit record here. Deliberately not written yet — the audit writer
    // and its hash chain are that ticket, and a half-written chain is worse than
    // none.
    const destination = resolvePostSignInPath(
      request.cookies.get(RETURN_PATH_COOKIE)?.value,
      DEFAULT_POST_SIGN_IN_PATH,
    );

    const response = NextResponse.redirect(new URL(destination, url.origin));
    // Consumed once. Leaving it would redirect a later sign-in to a stale target.
    response.cookies.delete(RETURN_PATH_COOKIE);
    return response;
  }

  return redirectTo(request, SIGN_IN_PATH, result.code);
}

function redirectTo(request: NextRequest, path: string, reason: string): NextResponse {
  const target = new URL(path, new URL(request.url).origin);
  target.searchParams.set("reason", reason);
  return NextResponse.redirect(target);
}
