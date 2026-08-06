import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import {
  parseOnboardingState,
  serializeOnboardingState,
  type OnboardingState,
} from "@/lib/onboarding/onboarding-state";

/**
 * Data access for `profiles` (ATL-015 created the table; ATL-016 is the first
 * ticket that needs to read or write it).
 *
 * Unlike the internal tables, `profiles` has real client policies — the owner
 * may select, insert, and update their own row. This repository is used with the
 * **service-role** client from server code, so ownership is filtered explicitly
 * in every query: RLS is not evaluated for that role, and a missing `user_id`
 * predicate would silently operate on somebody else's profile.
 */

export type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];

export interface ProfileRecord {
  id: string;
  displayName: string | null;
  privacyGoal: string | null;
  selectedCategories: string[];
  demoDataEnabled: boolean;
  onboardingCompletedAt: string | null;
  /**
   * Resumable onboarding progress (ATL-017).
   *
   * Parsed on the way out, never handed over raw: the column is `jsonb` with only
   * an "is an object" check, so callers would otherwise be reading unvalidated
   * storage. `parseOnboardingState` never throws, so a corrupt row degrades to a
   * usable flow instead of breaking every read of the profile.
   */
  onboardingState: OnboardingState;
}

function toRecord(row: ProfileRow): ProfileRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    privacyGoal: row.privacy_goal,
    selectedCategories: row.selected_categories,
    demoDataEnabled: row.demo_data_enabled,
    onboardingCompletedAt: row.onboarding_completed_at,
    onboardingState: parseOnboardingState(row.onboarding_state_json),
  };
}

/** Raised for any profile storage failure. Carries no database detail. */
export class ProfileStoreError extends Error {
  constructor() {
    super("profile store unavailable");
    this.name = "ProfileStoreError";
  }
}

/** The fields onboarding completion writes. Deliberately narrow. */
export interface OnboardingCompletion {
  privacyGoal: string | null;
  selectedCategories: string[];
  demoDataEnabled: boolean;
  completedAt: string;
}

export class ProfileRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  async find(userId: string): Promise<ProfileRecord | null> {
    const { data, error } = await this.db
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw new ProfileStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * Creates the profile row if it does not exist yet.
   *
   * A user authenticated by ATL-011 has an `auth.users` row but not necessarily
   * a profile, and onboarding is the first surface that needs one. Written as an
   * upsert with `ignoreDuplicates` so two concurrent first requests cannot race
   * into a primary-key violation — the second simply finds the row already there.
   */
  async ensure(userId: string): Promise<ProfileRecord> {
    const { error } = await this.db
      .from("profiles")
      .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });

    if (error) throw new ProfileStoreError();

    const profile = await this.find(userId);
    if (!profile) throw new ProfileStoreError();
    return profile;
  }

  /**
   * Records onboarding completion.
   *
   * Guarded on `onboarding_completed_at is null` so a repeated submission cannot
   * overwrite an earlier completion with a later timestamp — onboarding happens
   * once, and the first time is the true one. Returns false when the guard
   * rejected the update, which the caller treats as "already done" rather than
   * as an error.
   */
  async completeOnboarding(userId: string, completion: OnboardingCompletion): Promise<boolean> {
    const { data, error } = await this.db
      .from("profiles")
      .update({
        privacy_goal: completion.privacyGoal,
        selected_categories: completion.selectedCategories,
        demo_data_enabled: completion.demoDataEnabled,
        onboarding_completed_at: completion.completedAt,
        /**
         * Clear the resume state as part of the same update (ATL-017).
         *
         * Completion promotes every answer into its own column, so anything left
         * here is a duplicate of data now stored properly — and a stale one, since
         * nothing updates it afterwards. Keeping it would mean holding a second
         * copy of the user's choices for no purpose, which the data-minimisation
         * rule does not support. Same statement rather than a follow-up write, so
         * it cannot be left behind by a failure between the two.
         */
        onboarding_state_json: {},
      })
      .eq("id", userId)
      .is("onboarding_completed_at", null)
      .select("id");

    if (error) throw new ProfileStoreError();
    return (data ?? []).length > 0;
  }

  /**
   * Saves resumable progress (ATL-017).
   *
   * Guarded on `onboarding_completed_at is null`, matching `completeOnboarding`.
   * A late save from a tab left open on an earlier step would otherwise write
   * progress back onto a finished profile, and the product would then ask a
   * completed user to onboard again. Returns false when the guard declined,
   * which the caller treats as "already finished" rather than as an error.
   *
   * The state is re-validated here rather than trusted from the caller: this is
   * the last point before it becomes storage, and it arrived from a browser.
   */
  async saveOnboardingState(userId: string, state: OnboardingState): Promise<boolean> {
    const { data, error } = await this.db
      .from("profiles")
      .update({ onboarding_state_json: serializeOnboardingState(state) })
      .eq("id", userId)
      .is("onboarding_completed_at", null)
      .select("id");

    if (error) throw new ProfileStoreError();
    return (data ?? []).length > 0;
  }
}
