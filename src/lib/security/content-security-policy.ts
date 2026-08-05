/**
 * Content-Security-Policy construction (ATL-087, security §18).
 *
 * Every other §18 header is a fixed string and lives in `next.config.ts`. CSP
 * cannot: a nonce-based policy needs a fresh random value per request, so it is
 * built here and applied by middleware. That split is why `next.config.ts` has
 * carried a comment deferring CSP to this ticket since ATL-001.
 *
 * Pure and framework-free so the policy can be asserted directly rather than
 * inferred from a rendered response. It reads no environment and holds no
 * secret, so it is safe to import anywhere.
 *
 * ## Why nonces rather than hashes or an allowlist
 *
 * An allowlist of hosts is the weakest of the three — a single permissive CDN on
 * the list re-opens script injection, and the list rots as dependencies change.
 * Hashes require knowing every inline script at build time, which App Router
 * streaming defeats: Next emits inline bootstrap and flight-data scripts whose
 * content depends on the request. A per-request nonce is the only option that
 * survives streaming, which is exactly what the acceptance criterion asks to be
 * demonstrated.
 *
 * `'strict-dynamic'` is included so scripts loaded *by* a nonced script inherit
 * trust. Without it, every chunk Next loads at runtime would need its own nonce,
 * which the framework does not do — the policy would break the moment a route
 * code-split.
 */

export interface CspOptions {
  nonce: string;
  /**
   * Development needs `'unsafe-eval'` for React Refresh and the Turbopack HMR
   * client, and a websocket connection for the dev server. Production gets
   * neither. The acceptance criterion is scoped the same way: "no unsafe-inline
   * **in production**".
   */
  isDevelopment: boolean;
  /** Where violations are posted. Omitted if not configured. */
  reportUri?: string | undefined;
}

/** Bytes of entropy per nonce. 128 bits — far beyond guessing. */
export const NONCE_BYTES = 16;

/**
 * Request header carrying the nonce from middleware to the render.
 *
 * A request header rather than a cookie or a context value: Server Components
 * can read request headers but cannot write them, so the value cannot be
 * influenced by anything downstream of middleware, and the browser never sees
 * it as a separate artefact.
 */
export const CSP_NONCE_HEADER = "x-atlas-csp-nonce";

/** Where violation reports are posted (ATL-087). */
export const CSP_REPORT_PATH = "/api/security/csp-report";

/**
 * Generates a per-request nonce.
 *
 * Uses Web Crypto rather than `node:crypto` because middleware runs on the Edge
 * runtime, where the Node module is unavailable. Base64 because that is the
 * encoding CSP expects in a `'nonce-…'` source expression.
 *
 * A nonce must be unpredictable and must never repeat across responses: a
 * reused nonce lets an attacker who observed one response inject a script that
 * passes the policy on the next.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Builds the policy string.
 *
 * Directives are ordered from most to least security-relevant so a reviewer
 * reads the script rules first.
 */
export function buildContentSecurityPolicy({
  nonce,
  isDevelopment,
  reportUri,
}: CspOptions): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    // Trust flows to scripts loaded by an already-trusted script. Required for
    // Next's runtime chunk loading; without it, code-splitting breaks the page.
    "'strict-dynamic'",
    // Ignored by browsers that honour nonces. Present only so a browser too old
    // to understand `strict-dynamic` degrades to host-based matching rather than
    // to no policy at all.
    "https:",
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
  ];

  /**
   * `'unsafe-inline'` is retained here and **only** here.
   *
   * Security §18 requires avoiding unsafe inline *scripts*, which `script-src`
   * above does absolutely. Styles are a different risk: the worst an injected
   * style achieves is defacement or, at a stretch, exfiltration through a
   * crafted selector — not code execution.
   *
   * It is kept because Next injects inline `<style>` during streaming that it
   * does not nonce, and a strict `style-src` renders production unstyled. Note
   * that a browser honouring the nonce **ignores** `'unsafe-inline'` entirely,
   * so this is a fallback for the un-nonced framework styles rather than a
   * blanket permission.
   */
  const styleSrc = ["'self'", `'nonce-${nonce}'`, "'unsafe-inline'"];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    "style-src": styleSrc,
    // Supabase avatars and any future remote image host must be added explicitly.
    "img-src": ["'self'", "blob:", "data:"],
    "font-src": ["'self'"],
    // Supabase (auth, database, storage) and, in development, the HMR socket.
    "connect-src": ["'self'", "https:", ...(isDevelopment ? ["ws:", "wss:"] : [])],
    // No plugins, no Flash, no applets.
    "object-src": ["'none'"],
    // Nothing may embed Atlas. The modern replacement for X-Frame-Options, which
    // `next.config.ts` also sets for browsers that predate this directive.
    "frame-ancestors": ["'none'"],
    // Restricts <base href>, which can otherwise re-point every relative URL on
    // the page — including script sources.
    "base-uri": ["'self'"],
    // Where this document may POST. Prevents an injected form exfiltrating to a
    // third party.
    "form-action": ["'self'"],
  };

  const parts = Object.entries(directives).map(
    ([directive, values]) => `${directive} ${values.join(" ")}`,
  );

  // Valueless directives. Not applied in development, where the dev server is
  // plain HTTP and upgrading would break it.
  if (!isDevelopment) parts.push("upgrade-insecure-requests");

  if (reportUri) {
    // `report-uri` is deprecated but still the only directive Safari honours;
    // `report-to` is the modern replacement. Both are emitted so violations are
    // reported across the browser matrix rather than only in Chromium.
    parts.push(`report-uri ${reportUri}`);
    parts.push("report-to csp-endpoint");
  }

  return parts.join("; ");
}

/**
 * The `Report-To` header value pairing with `report-to csp-endpoint`.
 *
 * Separate from the policy because it is its own header; returning null when
 * unconfigured keeps the caller from emitting an empty one.
 */
export function buildReportToHeader(reportUri?: string): string | null {
  if (!reportUri) return null;

  return JSON.stringify({
    group: "csp-endpoint",
    max_age: 10886400,
    endpoints: [{ url: reportUri }],
  });
}
