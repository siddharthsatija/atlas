import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/config/env";

/**
 * Server-side Supabase client (ATL-011).
 *
 * The session lives in cookies written by `@supabase/ssr`, which sets them
 * `HttpOnly`, `Secure` (outside local HTTP), and `SameSite=Lax` — the attributes
 * security §5 requires. `HttpOnly` is the important one: it keeps the session
 * token out of reach of any script on the page, so an XSS foothold cannot
 * exfiltrate it.
 *
 * `server-only` is not decoration. This module is the boundary between the
 * untrusted browser and a verified identity (architecture §5), and importing it
 * into a client bundle would be a serious mistake — the import fails the build
 * instead.
 */

/**
 * Client bound to the current request's cookies.
 *
 * `setAll` tolerates the write failing. Next.js forbids setting cookies while
 * rendering a Server Component, and Supabase attempts a write whenever it
 * refreshes a token. Swallowing it there is correct rather than lazy: the refresh
 * still happens in Route Handlers, Server Actions, and middleware, which *can*
 * write. Letting it throw would turn a routine refresh into a render failure.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Read-only cookie context (Server Component render). See above.
        }
      },
    },
  });
}
