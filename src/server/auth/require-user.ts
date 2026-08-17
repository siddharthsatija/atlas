import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "./supabase-server-client";
import { verifySession, type SessionCheck } from "./auth-service";
import { SIGN_IN_PATH, buildSignInPath } from "@/lib/auth/return-path";
import { logger } from "@/lib/telemetry/logger";

/**
 * Raised when the auth provider could not be reached (ATL-111).
 *
 * A distinct type so a caller that needs to tell "could not check" from any
 * other server fault can, and so this file's intent is legible at the throw
 * site. The boundary that catches it does not read it: Next scrubs server error
 * messages before they reach the client, leaving only `digest`, so the recovery
 * page is the shared calm one either way. The message here is for the server
 * log, and it carries no session, token, or account detail.
 */
export class AuthProviderUnavailableError extends Error {
  constructor() {
    super("auth provider unavailable");
    this.name = "AuthProviderUnavailableError";
  }
}

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
/**
 * The verified session for the current request, read at most once (#131).
 *
 * ## Why this exists
 *
 * `requireVerifiedUser` is called from fifteen places — every product layout,
 * every page, and every Server Action — and each call previously opened its own
 * connection to the auth provider. One navigation therefore issued several
 * independent `GET /user` requests. Under sustained load the local GoTrue
 * container exhausted its ephemeral ports dialling Postgres and answered 500
 * (`connect: cannot assign requested address`), which ATL-111 correctly reports
 * as an outage. Fewer round trips is the right behaviour in production too: a
 * single render has no reason to re-verify the same cookie four times.
 *
 * ## Why this is safe to cache, verified rather than assumed
 *
 * React's `cache` keeps **no module-global store**. It reads the memo table from
 * the active cache dispatcher on every call
 * (`react/cjs/react.react-server.development.js:576`), and in the RSC server
 * that table is `resolveRequest().cache` — a `Map` allocated in the constructor
 * of each per-request `Request` object
 * (`react-server-dom-turbopack-server.node.development.js:6072` and `:1114`),
 * reached through an `AsyncLocalStorage` (`:5951`).
 *
 * Two consequences follow, and they are the whole safety argument:
 *
 *   1. **No two requests can share a result**, because there is no shared store
 *      for one to reach. The table dies with the `Request` that owns it.
 *   2. **Outside an active request the cache is a no-op, not a shared
 *      fallback** — with no dispatcher, `cache` calls straight through
 *      (`react.react-server.development.js:577`). The failure mode is "no
 *      saving", never "someone else's user".
 *
 * Every request therefore still verifies its own session independently. What is
 * removed is redundant verification *within* a request that has already been
 * verified once.
 *
 * ## Server Actions do not benefit, and that is left alone
 *
 * An action runs before the render `Request` exists, so `resolveRequest()`
 * returns null and this is a pass-through there. Six of the fifteen call sites
 * are actions; they keep exactly their present behaviour and their present cost.
 * Reshaping action execution to make caching apply would be changing product
 * semantics to suit an optimisation, which is the wrong trade.
 *
 * ## What is deliberately *not* inside the cache
 *
 * Only the client construction and the resulting `SessionCheck` value. The log,
 * the throw, the redirect and `returnPath` all stay in `requireVerifiedUser`, so
 * every call site keeps its own side effects: three callers still log three
 * times, and one caller's `returnPath` can never be served to another.
 */
const readVerifiedSession = cache(async (): Promise<SessionCheck> => {
  const supabase = await createSupabaseServerClient();
  return verifySession(supabase.auth);
});

export async function requireVerifiedUser(returnPath?: string): Promise<User> {
  const result = await readVerifiedSession();

  if (result.status === "unavailable") {
    /**
     * Not a redirect (ATL-111).
     *
     * Sending this user to `/sign-in` would state something Atlas does not
     * know. Their cookie is intact and their session is probably still valid —
     * the only fact established is that the auth server could not be reached.
     * Throwing hands the request to ATL-010's route boundary, which keeps them
     * inside the product with a retry, leaves every cookie untouched, and
     * revokes nothing.
     *
     * It is still a refusal: nothing below this line renders, so an unverified
     * token never becomes authorization evidence (architecture §5).
     */
    logger.error("auth.provider_unavailable", {
      operation: "auth.verify_session",
      provider: "auth",
      providerAvailable: false,
    });
    throw new AuthProviderUnavailableError();
  }

  if (result.status === "unauthenticated") {
    redirect(returnPath === undefined ? SIGN_IN_PATH : buildSignInPath(returnPath));
  }

  return result.user;
}
