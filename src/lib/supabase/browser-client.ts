/**
 * Browser Supabase client (ATL-011).
 *
 * Uses the **anon key only**, which is RLS-constrained and designed to be public.
 * The service-role key bypasses RLS and must never reach a bundle (security §6,
 * enforced at boot by `service-role-must-differ-from-anon` in
 * `src/config/environment-isolation.ts`).
 *
 * Reads `process.env.NEXT_PUBLIC_*` directly rather than importing `publicEnv`:
 * `src/config/env.ts` is `server-only`, so importing it from a client component
 * would fail the build. Next.js inlines `NEXT_PUBLIC_` values at build time, and
 * the same variables are schema-validated server-side at boot, so a malformed
 * value fails there rather than silently here.
 *
 * Session storage is cookie-based via `@supabase/ssr`, so the server can read the
 * session too. It is deliberately not `localStorage` — browser storage is
 * prohibited (CLAUDE.md), and a token the server cannot see is a token the server
 * cannot verify.
 */

import { createBrowserClient } from "@supabase/ssr";

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // Names the variable, never a value (security §9).
    throw new Error(
      "Supabase browser client requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  return createBrowserClient(url, anonKey);
}
