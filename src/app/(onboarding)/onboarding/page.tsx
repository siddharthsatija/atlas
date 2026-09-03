import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { OnboardingService } from "@/server/onboarding/onboarding-service";
import { OnboardingFlow } from "./onboarding-flow";
import { saveOnboardingProgressAction } from "./actions";

/**
 * Onboarding (ATL-016, frontend §17, PRD §9.1).
 *
 * A Server Component that resolves one question before rendering: has this user
 * already finished? Someone who navigates back to `/onboarding` after completing
 * it is sent to the dashboard rather than shown the flow again — otherwise
 * finishing a second time would overwrite their earlier answers, and the
 * completion timestamp would drift later on every visit.
 *
 * The profile row is created here on first arrival. A user authenticated by
 * ATL-011 has an `auth.users` row but not necessarily a profile, and this is the
 * first surface that needs one.
 */

export const metadata: Metadata = { title: "Set up Atlas" };

/** Reads the session and the profile, so this route is dynamic by nature. */
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await requireVerifiedUser();
  const profile = await OnboardingService.create().start(user.id);

  if (profile.onboardingCompletedAt !== null) redirect("/overview");

  /**
   * Saved progress is resolved here, on the server (ATL-017).
   *
   * The flow therefore renders at the resumed step on the first paint. Fetching
   * it after mount would show the introduction and then jump, which reads as the
   * product losing the user's place and then finding it again.
   *
   * `profile.onboardingState` is already parsed by the repository, so a corrupt
   * row arrives here as a usable state rather than as a value this page has to
   * defend against.
   */
  return (
    <OnboardingFlow
      initialState={profile.onboardingState}
      onStateChange={saveOnboardingProgressAction}
    />
  );
}
