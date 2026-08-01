import type { NextConfig } from "next";

/**
 * Security headers.
 *
 * Baseline required by docs/03-security-and-access.md §18. Content-Security-Policy is
 * deliberately NOT set here: it requires a nonce-based policy generated per request in
 * middleware, which is owned by ATL-087. Adding a static CSP now would either be
 * unsafe (unsafe-inline) or break streaming.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  typescript: {
    // Never ignore type errors: typecheck is a required CI gate (architecture §19).
    ignoreBuildErrors: false,
  },

  // Next 16 removed the `eslint` config key: linting is no longer part of `next build`.
  // The lint gate runs as its own required CI step instead (architecture §19).

  // Stable since Next 16 — was previously under `experimental`.
  typedRoutes: true,

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
