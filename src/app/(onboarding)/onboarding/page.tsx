import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { OnboardingService } from "@/server/onboarding/onboarding-service";
import { PersonalFieldService } from "@/server/personal-fields/personal-field-service";
import { OnboardingFlow } from "./onboarding-flow";
import { saveOnboardingProgressAction } from "./actions";
import { DiscoveryConsentService } from "@/server/discovery/discovery-consent-service";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { getUiVisibleProviders } from "@/lib/discovery/discovery-provider-registry";
import type { DiscoveryConsentState } from "@/features/discovery";

/**
 * Onboarding (ATL-016, ATL-209, frontend §17, PRD §9.1).
 *
 * A Server Component that resolves questions before rendering:
 *
 * 1. **Has this user finished everything?** `onboardingCompletedAt` is set AND
 *    `identityProfileStepCompletedAt` is set → redirect to `/overview`. Both
 *    must be set: ATL-209 added the second marker so pre-M13 users who completed
 *    the old flow still see the identity-profile step before they reach the product.
 *
 * 2. **Is this an upgrade-mode user?** `onboardingCompletedAt` is set but
 *    `identityProfileStepCompletedAt` is null → the user completed onboarding
 *    before ATL-209 landed. They see only the identity-profile step. On
 *    completion, `completeIdentityProfileStepAction(true)` redirects them to
 *    `/overview`.
 *
 * 3. **New user** — neither marker is set. The full onboarding flow runs,
 *    including the identity-profile step in its position between `starting_point`
 *    and `ready`.
 *
 * ## Identity profile data
 *
 * The identity-profile step needs the user's current fields and their storage
 * consent state, both resolved server-side so the correct panel renders on the
 * first paint. A returning user who navigated back after saving a field would
 * otherwise see the "no fields yet" state until client-side fetching completes.
 *
 * The profile row is created here on first arrival (via `OnboardingService.start`).
 * A user authenticated by ATL-011 has an `auth.users` row but not necessarily a
 * profile.
 */

export const metadata: Metadata = { title: "Set up Atlas" };

/** Reads the session and the profile, so this route is dynamic by nature. */
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await requireVerifiedUser();
  const profile = await OnboardingService.create().start(user.id);

  /**
   * ATL-209 completion gate.
   *
   * Both markers must be set to consider the user fully past onboarding. A
   * pre-M13 user who completed `onboarding_completed_at` but not
   * `identity_profile_step_completed_at` falls through to the upgrade-mode branch
   * below, not this redirect.
   */
  if (profile.onboardingCompletedAt !== null && profile.identityProfileStepCompletedAt !== null) {
    redirect("/overview");
  }

  /**
   * ATL-209 upgrade mode.
   *
   * Pre-M13 users land here with `onboardingCompletedAt` set but
   * `identityProfileStepCompletedAt` null. They see only the identity-profile
   * step; the rest of the flow is bypassed entirely.
   */
  const isUpgradeMode =
    profile.onboardingCompletedAt !== null && profile.identityProfileStepCompletedAt === null;

  /**
   * Load identity-profile data.
   *
   * Resolved on every visit — the step renders on the first paint without a
   * loading state, and a returning user who already saved some fields sees them
   * immediately rather than seeing the empty state and then a flash of content.
   *
   * If `listMasked` fails (storage error), the step starts empty. The user can
   * still add fields; the missing ones will reappear on the next page visit.
   */
  const pf = PersonalFieldService.create();
  const [isStoragePermitted, maskedResult] = await Promise.all([
    pf.isStoragePermitted(user.id),
    pf.listMasked(user.id),
  ]);

  const identityProfileFields = maskedResult.ok
    ? maskedResult.data.map((f) => ({
        id: f.id,
        fieldKey: f.fieldKey,
        label: f.label,
        maskedValue: f.maskedValue,
        includeInDiscovery: f.includeInDiscovery,
      }))
    : [];

  // ATL-210: Resolve active discovery providers and consent state.
  // Empty in ship state — activates when ATL-217 registers a provider.
  const activeDiscoveryProviders = getUiVisibleProviders();
  const uniqueConsentTypes = Array.from(
    new Set(activeDiscoveryProviders.map((p) => p.consentType)),
  );

  const discoveryConsentStateByType: Record<string, DiscoveryConsentState> = {};
  if (activeDiscoveryProviders.length > 0) {
    const db = createServiceRoleClient();
    const discoveryService = DiscoveryConsentService.create(db);
    const consentResults = await Promise.all(
      uniqueConsentTypes.map(async (consentType) => {
        try {
          const granted = await discoveryService.hasActiveConsent(user.id, consentType);
          return { consentType, granted };
        } catch {
          return { consentType, granted: false };
        }
      }),
    );
    for (const result of consentResults) {
      discoveryConsentStateByType[result.consentType] = {
        consentType: result.consentType,
        granted: result.granted,
        grantedAt: null,
      };
    }
  }

  // Map provider metadata to view model for OnboardingFlow.
  const activeProviderViews = activeDiscoveryProviders.map((p) => ({
    providerClass: p.providerClass,
    consentType: p.consentType,
    disclosureClass: p.disclosureClass,
    disclosureContractVersion: p.disclosureContractVersion,
  }));

  return (
    <OnboardingFlow
      {...(isUpgradeMode
        ? {}
        : {
            initialState: profile.onboardingState,
            onStateChange: saveOnboardingProgressAction,
          })}
      isStoragePermitted={isStoragePermitted}
      identityProfileFields={identityProfileFields}
      isUpgradeMode={isUpgradeMode}
      activeDiscoveryProviders={activeProviderViews}
      discoveryConsentStateByType={discoveryConsentStateByType}
    />
  );
}
