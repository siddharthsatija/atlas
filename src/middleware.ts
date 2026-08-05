import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { buildSignInPath, isProtectedPath } from "@/lib/auth/return-path";
import {
  SESSION_SEEN_COOKIE,
  SESSION_STARTED_COOKIE,
  evaluateSessionLifetime,
  parseMarker,
  serializeMarker,
  sessionMarkerCookieOptions,
} from "@/lib/auth/session-lifetime";
import {
  CSP_NONCE_HEADER,
  CSP_REPORT_PATH,
  buildContentSecurityPolicy,
  buildReportToHeader,
  generateNonce,
} from "@/lib/security/content-security-policy";

/**
 * Route protection and session refresh (ATL-012).
 *
 * Runs before any product route renders, which is what makes "no flash of
 * protected content" structural rather than a matter of careful component
 * ordering: an unauthenticated request is redirected before React produces
 * anything at all. A client-side guard could only hide content that had already
 * been sent.
 *
 * It does **two** jobs, and the second is easy to overlook:
 *
 *  1. Redirect unauthenticated requests for protected paths to sign-in.
 *  2. Refresh the Supabase session cookie. Server Components cannot write
 *     cookies, so without a middleware refresh a session would expire mid-visit
 *     and the user would be bounced to sign-in while actively using the product.
 *
 * **This is not the only check.** `(product)/layout.tsx` verifies again on the
 * server. Middleware is a matcher-driven optimisation and a matcher is a
 * configuration file — one wrong glob silently unprotects a route. Authorization
 * that depends on routing configuration is authorization waiting to be
 * misconfigured, so the layout enforces it where the data actually renders.
 *
 * Reads `process.env` directly rather than importing `@/config/env`: that module
 * validates base64 key material with `Buffer`, which is not available in the Edge
 * runtime, and pulling the whole schema into every request would be wasteful even
 * where it works. The same variables are schema-validated at server boot, so a
 * malformed value fails there.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  /**
   * Content-Security-Policy (ATL-087).
   *
   * Wraps the routing and session work rather than being folded into it, because
   * the policy must reach **every** response this middleware can produce — the
   * pass-through, the sign-in redirect, and the session-expiry redirect. A
   * header applied at one return point is a header missing from the other two,
   * and the one that would be missing is on a redirect an attacker can trigger.
   *
   * The nonce is generated once per request and travels two ways: forward on the
   * request headers, so the root layout can put it on the scripts it renders,
   * and outward in the policy, so the browser accepts exactly those scripts.
   */
  const nonce = generateNonce();

  // `isDevelopment` comes from `process.env` for the same reason the Supabase
  // values do (see the module docstring): `@/config/env` validates base64 key
  // material with `Buffer`, which the Edge runtime does not provide.
  const policy = buildContentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV !== "production",
    reportUri: CSP_REPORT_PATH,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSP_NONCE_HEADER, nonce);

  /**
   * The policy goes on the **request** headers as well as the response, and this
   * is the line that makes nonce-based CSP work with App Router streaming.
   *
   * Next inspects the incoming `content-security-policy` for a nonce and, when
   * it finds one, stamps that nonce onto the bootstrap and flight-data scripts
   * it emits while streaming. Without it those scripts are un-nonced, the policy
   * rejects them, and the page arrives as inert HTML — the exact failure the
   * acceptance criterion asks to be demonstrated against.
   */
  requestHeaders.set("content-security-policy", policy);

  const response = await handleRequest(request, requestHeaders);

  response.headers.set("content-security-policy", policy);
  const reportTo = buildReportToHeader(CSP_REPORT_PATH);
  if (reportTo) response.headers.set("report-to", reportTo);

  return response;
}

async function handleRequest(request: NextRequest, requestHeaders: Headers): Promise<NextResponse> {
  // `response` is rebuilt as cookies are set so refreshed tokens reach the browser.
  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // Fail closed. A misconfigured environment must not silently serve protected
    // routes unauthenticated; boot validation reports the cause.
    return isProtectedPath(request.nextUrl.pathname) ? redirectToSignIn(request) : response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        // Rebuilt with the same forwarded headers, so the nonce survives a
        // session refresh. Dropping them here would leave the layout without a
        // nonce on exactly the requests that renew a token.
        response = NextResponse.next({ request: { headers: requestHeaders } });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  /**
   * `getUser()`, never `getSession()`.
   *
   * `getSession()` decodes whatever the cookie contains and returns it without
   * contacting the auth server — it is client state, and architecture §5 is
   * explicit that client state is not authorization evidence. `getUser()`
   * revalidates the token. It also performs the refresh this middleware exists to
   * carry out, so both jobs are done by the same call.
   */
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return isProtectedPath(request.nextUrl.pathname) ? redirectToSignIn(request) : response;
  }

  /**
   * Session lifetime enforcement (ATL-013).
   *
   * Runs only for an authenticated request, and only after `getUser()` has
   * confirmed the token — expiring a session we have not verified would be
   * acting on unverified input.
   *
   * On expiry the provider session is revoked as well as the cookies cleared.
   * Clearing cookies alone would leave a still-valid refresh token at the
   * provider, so the limit would be cosmetic: anyone holding that token could
   * keep using it.
   */
  const decision = evaluateSessionLifetime(
    {
      startedAt: parseMarker(request.cookies.get(SESSION_STARTED_COOKIE)?.value),
      lastSeenAt: parseMarker(request.cookies.get(SESSION_SEEN_COOKIE)?.value),
    },
    Date.now(),
  );

  if (decision.status !== "active") {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // Cookies are cleared regardless: a failed provider call must not leave
      // the user apparently signed in past the limit.
    }
    return expireSession(request, decision.status);
  }

  if (decision.markers) {
    const options = sessionMarkerCookieOptions(request.nextUrl.protocol === "https:");
    response.cookies.set(
      SESSION_STARTED_COOKIE,
      serializeMarker(decision.markers.startedAt),
      options,
    );
    response.cookies.set(
      SESSION_SEEN_COOKIE,
      serializeMarker(decision.markers.lastSeenAt),
      options,
    );
  }

  return response;
}

/**
 * Ends an expired session: clears the markers and sends the user to sign-in with
 * a neutral reason.
 *
 * The reason is a fixed vocabulary value, not a provider message, and says only
 * that the session ended — the same two codes for every user, disclosing nothing
 * about the account.
 */
function expireSession(
  request: NextRequest,
  status: "expired_idle" | "expired_absolute",
): NextResponse {
  const target = new URL(
    isProtectedPath(request.nextUrl.pathname)
      ? buildSignInPath(request.nextUrl.pathname)
      : "/sign-in",
    request.nextUrl.origin,
  );
  target.searchParams.set("reason", status === "expired_idle" ? "session_idle" : "session_expired");

  const response = NextResponse.redirect(target);
  response.cookies.delete(SESSION_STARTED_COOKIE);
  response.cookies.delete(SESSION_SEEN_COOKIE);
  return response;
}

function redirectToSignIn(request: NextRequest): NextResponse {
  // The return path is validated and truncated to its section by
  // `buildSignInPath`; the raw requested path never reaches the URL.
  const target = new URL(buildSignInPath(request.nextUrl.pathname), request.nextUrl.origin);
  return NextResponse.redirect(target);
}

export const config = {
  /**
   * Everything except static assets and the auth callback.
   *
   * Deliberately broad rather than an enumerated list of product paths: the
   * matcher decides only *where the middleware runs*, and `isProtectedPath`
   * decides what is protected. Keeping the protection rule in tested code rather
   * than in a glob is what makes it reviewable — and it means a new product
   * section is covered the moment it joins `NAV_ORDER`.
   *
   * `/auth/callback` is excluded because it is how a user *becomes*
   * authenticated; guarding it would deadlock sign-in.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|auth/callback|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
