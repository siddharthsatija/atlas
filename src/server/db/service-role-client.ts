import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/config/env";
import type { Database } from "@/types/database.generated";

/**
 * Service-role database client (ATL-084).
 *
 * **Bypasses Row Level Security.** It exists for the internal tables that have
 * no client policies at all — `user_encryption_keys` today, `audit_events` with
 * ADR-006 — where the grant is the only gate and every access is server-side by
 * definition.
 *
 * Rules that come with using it (security §6):
 *
 *   - `server-only`, so an accidental client import fails the build rather than
 *     shipping an RLS-bypassing key to a browser.
 *   - Never used for user-owned tables that have policies. Those go through the
 *     request-scoped client in `@/server/auth/supabase-server-client`, so RLS
 *     stays the enforcement mechanism rather than something application code
 *     re-implements and eventually gets wrong.
 *   - Ownership is filtered explicitly in every query here, because the database
 *     will not do it for this client.
 *
 * No session is persisted and no token is refreshed: this client acts as the
 * service, never on behalf of a user.
 */
export function createServiceRoleClient(): SupabaseClient<Database> {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
