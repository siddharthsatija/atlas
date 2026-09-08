/**
 * Service-role fixture helper for upgrade-onboarding E2E tests (ATL-214).
 *
 * Seeds a user's profile into the upgrade-onboarding state — the condition that
 * exists for pre-M13 users who completed onboarding before the identity_profile
 * step was introduced:
 *
 *   profiles.onboarding_completed_at      = <past timestamp>  (non-null)
 *   profiles.identity_profile_step_completed_at = NULL
 *
 * The layout gate redirects to /onboarding when EITHER marker is null.
 * The onboarding page sets isUpgradeMode = true when onboarding_completed_at
 * is non-null AND identity_profile_step_completed_at IS NULL.
 *
 * ## Usage pattern (ATL-214 §T4)
 *
 *   const email = await startFresh(page);          // creates user, lands on /onboarding
 *   const userId = await getUserIdByEmail(email);
 *   await seedUpgradeProfile(userId);              // set upgrade state
 *   await page.reload();                           // server fetches updated profile
 *   // onboarding page now renders in upgrade mode
 *
 * ## Teardown
 *
 * The test user is created by startFresh() (magic-link sign-in) and is cleaned
 * up by Supabase's own test-user sweep or left to expire.  No explicit delete
 * is required for the profile row — it is cascade-deleted with the auth user.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect } from "@playwright/test";
import type { Database } from "@/types/database.generated";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function admin(): SupabaseClient<Database> {
  expect(
    SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY must be set for E2E fixture helpers",
  ).not.toBe("");
  return createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Seeds a user's profile into upgrade-onboarding state.
 *
 * Sets onboarding_completed_at to 24 hours ago (simulating a pre-M13
 * completion) and leaves identity_profile_step_completed_at as NULL.
 *
 * Requires the profile row to already exist — call AFTER startFresh() has
 * created the user and the onboarding page has initialised the profile via
 * OnboardingService.start().
 */
export async function seedUpgradeProfile(userId: string): Promise<void> {
  const db = admin();
  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();

  const { error } = await db
    .from("profiles")
    .update({
      onboarding_completed_at: oneDayAgo,
      identity_profile_step_completed_at: null,
    } as never) // generated type does not reflect nullable timestamp
    .eq("id", userId);

  if (error) throw new Error(`seedUpgradeProfile: update failed: ${error.message}`);
}
