"use server";

import { redirect } from "next/navigation";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { OnboardingService } from "@/server/onboarding/onboarding-service";
import type { OnboardingState } from "@/lib/onboarding/onboarding-state";
import type { CompleteOnboardingState } from "./form-state";

/**
 * Onboarding Server Actions (ATL-016).
 *
 * A Server Action rather than a route handler: Next.js applies origin checking,
 * and there is no browser-initiated request shape here that a form cannot
 * express (`src/app/api/README.md`).
 *
 * The user id comes from `requireVerifiedUser`, never from the form. Architecture
 * §10 is explicit that a client-supplied `user_id` is never authority, and a
 * completion action that trusted one would let anyone finish anyone's onboarding.
 */

/**
 * Finishes onboarding and sends the user to the dashboard.
 *
 * Choices arrive as form fields so the flow works without JavaScript — the whole
 * journey is a sequence of forms, which is also what makes the back button
 * behave the way a user expects.
 */
export async function completeOnboardingAction(
  _previous: CompleteOnboardingState,
  formData: FormData,
): Promise<CompleteOnboardingState> {
  const user = await requireVerifiedUser();

  const privacyGoal = formData.get("privacyGoal");
  const startingPoint = formData.get("startingPoint");

  try {
    await OnboardingService.create().complete({
      userId: user.id,
      privacyGoal: typeof privacyGoal === "string" && privacyGoal ? privacyGoal : null,
      // Unknown ids are discarded by the service; passing them through keeps the
      // action free of vocabulary knowledge it would otherwise duplicate.
      selectedCategories: formData.getAll("categories").filter((v) => typeof v === "string"),
      startingPoint: typeof startingPoint === "string" && startingPoint ? startingPoint : null,
      // An unchecked checkbox is absent from the payload, so this is false unless
      // the user actively agreed — which is what makes the consent record mean
      // something.
      aiProcessingConsent: formData.get("aiProcessingConsent") === "on",
    });
  } catch {
    // Nothing about the failure is shown: the user can only retry, and a
    // provider message would tell them nothing they can act on.
    return { error: "unavailable" };
  }

  // Outside the try: `redirect` signals by throwing, and catching it here would
  // turn a successful completion into an error banner.
  redirect("/overview");
}

/**
 * Saves resumable progress (ATL-017).
 *
 * Called as the user moves between steps, so a refresh, a closed tab, or a
 * return the next day resumes where they left off instead of starting over.
 *
 * ## Never blocks the interaction
 *
 * Failures are swallowed and the caller does not await the result. Stepping
 * forward is a local state change that must feel instant; making it wait on a
 * round trip — or worse, fail because one did — trades a working flow for a
 * saved position. A dropped save costs the user their place if they leave, which
 * is exactly the situation they were in before this ticket.
 *
 * This mirrors the ATL-006 sidebar preference: apply immediately, persist
 * optimistically, never let persistence gate the UI.
 *
 * The user id comes from the session, never the payload (architecture §10), and
 * the state is validated by the service against the same vocabularies the
 * completion path uses.
 */
export async function saveOnboardingProgressAction(state: OnboardingState): Promise<void> {
  try {
    const user = await requireVerifiedUser();
    await OnboardingService.create().saveProgress(user.id, state);
  } catch {
    /**
     * Deliberately silent, and deliberately not logged with any of the state.
     * The values are non-sensitive by construction, but a save that fails on
     * every step would otherwise write a line per step per user for a fault the
     * user never sees. The service already logs storage failures.
     */
  }
}
