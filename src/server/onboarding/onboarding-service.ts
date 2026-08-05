import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { isAssetCategory } from "@/lib/assets/categories";
import { isPrivacyGoal, isStartingPoint } from "@/lib/onboarding/onboarding-steps";
import { ConsentService } from "@/server/consent/consent-service";
import { ActivityWriter } from "@/server/activity/activity-writer";
import { ProfileRepository, type ProfileRecord } from "@/server/repositories/profile-repository";
import { logger } from "@/lib/telemetry/logger";

/**
 * Onboarding completion (ATL-016).
 *
 * Owns the *end* of the flow: validating what the user chose, capturing
 * AI-processing consent, and marking the profile complete. The step-by-step
 * journey is UI state; saving and resuming it is **ATL-017**, and this service
 * deliberately never touches `onboarding_state_json`.
 *
 * ## Everything it collects is a choice from a fixed set
 *
 * The privacy goal, the categories, and the starting point are all validated
 * against the vocabularies in `src/lib/onboarding` and `src/lib/assets`. An
 * unrecognised value is dropped rather than stored — onboarding must request no
 * sensitive fields, and the strongest way to hold that line is for there to be
 * no field a free value could travel in.
 *
 * ## Ordering
 *
 * Consent is recorded **before** the profile is marked complete. If the consent
 * write fails, onboarding stays incomplete and the user is asked again; the
 * reverse ordering could leave a completed profile with no consent row, and the
 * AI features would then be gated by a record that does not exist. A consent row
 * for a user who never finished onboarding is harmless — they simply agreed.
 */

export interface CompleteOnboardingInput {
  userId: string;
  /** Chosen goal, or null if the step was skipped. */
  privacyGoal?: string | null;
  /** Chosen categories. Unknown ids are discarded. */
  selectedCategories?: string[];
  /** `demo` or `own`, or null if skipped. */
  startingPoint?: string | null;
  /**
   * Whether the user agreed to AI processing.
   *
   * Explicit rather than assumed: the acceptance criterion requires consent to
   * be *captured*, and a default of true would make the record meaningless.
   */
  aiProcessingConsent: boolean;
}

export interface CompleteOnboardingResult {
  profile: ProfileRecord;
  /** False when onboarding was already complete — a repeat submission. */
  newlyCompleted: boolean;
}

export class OnboardingService {
  private readonly profiles: ProfileRepository;
  private readonly consent: ConsentService;
  private readonly activity: ActivityWriter;

  constructor(db: SupabaseClient<Database>, consent?: ConsentService, activity?: ActivityWriter) {
    this.profiles = new ProfileRepository(db);
    this.consent = consent ?? new ConsentService(db);
    this.activity = activity ?? new ActivityWriter(db);
  }

  static create(): OnboardingService {
    const db = createServiceRoleClient();
    return new OnboardingService(db, new ConsentService(db), new ActivityWriter(db));
  }

  /** The profile as onboarding needs it, creating the row on first visit. */
  async start(userId: string): Promise<ProfileRecord> {
    return this.profiles.ensure(userId);
  }

  async complete(input: CompleteOnboardingInput): Promise<CompleteOnboardingResult> {
    await this.profiles.ensure(input.userId);

    // Validated against the vocabularies rather than trusted. A skipped step
    // arrives as null, which is a legitimate answer and stored as one.
    const privacyGoal =
      input.privacyGoal && isPrivacyGoal(input.privacyGoal) ? input.privacyGoal : null;

    const selectedCategories = [
      ...new Set((input.selectedCategories ?? []).filter(isAssetCategory)),
    ];

    const startingPoint =
      input.startingPoint && isStartingPoint(input.startingPoint) ? input.startingPoint : null;

    /**
     * Consent first (ATL-078), and only when the user actually agreed.
     *
     * Declining is a real answer: the acceptance criterion is that AI is
     * unusable *without* consent, not that onboarding cannot finish without it.
     * No row is written for a decline, so the ATL-078 gate — which treats
     * silence as denial — reaches the same conclusion without a record implying
     * the user was asked twice.
     */
    if (input.aiProcessingConsent) {
      await this.consent.grant(input.userId, "ai_processing");
    }

    const newlyCompleted = await this.profiles.completeOnboarding(input.userId, {
      privacyGoal,
      selectedCategories,
      demoDataEnabled: startingPoint === "demo",
      completedAt: new Date().toISOString(),
    });

    if (newlyCompleted) {
      /**
       * Activity only, no audit event.
       *
       * Security §12's audit inventory does not list onboarding, and inventing
       * an entry for it would widen a security record on a hunch. The consent
       * grant above *is* audited, through ATL-078, which is the part of
       * onboarding that has security meaning.
       *
       * Best effort: a missing timeline row must not undo a completed
       * onboarding, which is the same trade `emitEvent` makes.
       */
      try {
        await this.activity.write({
          userId: input.userId,
          type: "onboarding.completed",
          metadata: { count: selectedCategories.length, isDemo: startingPoint === "demo" },
        });
      } catch {
        logger.error("activity.write_failed", { operation: "onboarding.complete", count: 1 });
      }
    }

    const profile = await this.profiles.find(input.userId);
    if (!profile) throw new Error("profile disappeared during onboarding");

    return { profile, newlyCompleted };
  }
}
