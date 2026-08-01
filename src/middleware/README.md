# middleware

Helpers for Next.js middleware. The root `middleware.ts` is **not** created yet: route
protection is owned by **ATL-012** and depends on ATL-011 (auth setup).

When that ticket lands, middleware will be responsible for:

- Verifying the session server-side for every `(product)` route (architecture §6.1)
- Redirecting unauthenticated users to sign-in, preserving the return path with no
  sensitive value in the URL (security §8)
- Emitting the **per-request CSP nonce** for the nonce-based policy in ATL-087 —
  the reason `next.config.ts` sets every other security header but not CSP
- Enforcing idle and absolute session lifetimes where the provider lacks native support

Client state is never authorization evidence. Middleware verifies; it does not trust.
