"use server";

/**
 * Discovery consent server actions for the onboarding flow (ATL-210).
 *
 * Isolated from settings/discovery-actions.ts because onboarding and Settings
 * have different revalidation targets and are called from different route trees.
 *
 * ## Consent type allowlist
 *
 * Only `discovery_hashed_query` and `discovery_identifying` are permitted here.
 * `discovery_connected_sources` is deferred per ADR-008 §11 and must never
 * reach the consent service from this surface.
 *
 * Type validation is performed BEFORE the auth check so that a request for a
 * disallowed type fails without touching the session or the database.
 */

import { requireVerifiedUser } from "@/server/auth/require-user";
import { DiscoveryConsentService } from "@/server/discovery/discovery-consent-service";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import type { DiscoveryConsentType } from "@/lib/consent";
import type {
  DiscoveryConsentActionState,
  DisclosureAcknowledgmentActionState,
} from "@/features/discovery";

const ALLOWED_CONSENT_TYPES = new Set<string>(["discovery_hashed_query", "discovery_identifying"]);

export async function grantDiscoveryConsentForOnboardingAction(
  consentType: DiscoveryConsentType,
  prev: DiscoveryConsentActionState,
): Promise<DiscoveryConsentActionState> {
  if (!ALLOWED_CONSENT_TYPES.has(consentType)) {
    return { failure: "unavailable", attempt: prev.attempt + 1 };
  }

  try {
    const user = await requireVerifiedUser();
    const db = createServiceRoleClient();
    const service = DiscoveryConsentService.create(db);
    await service.grantConsent(user.id, consentType);
    return { failure: null, attempt: prev.attempt + 1 };
  } catch {
    return { failure: "unavailable", attempt: prev.attempt + 1 };
  }
}

export async function acknowledgeDisclosureForOnboardingAction(
  fieldId: string,
  providerClass: string,
  disclosureContractVersion: string,
  prev: DisclosureAcknowledgmentActionState,
): Promise<DisclosureAcknowledgmentActionState> {
  if (!fieldId || !providerClass || !disclosureContractVersion) {
    return { failure: "unavailable", attempt: prev.attempt + 1 };
  }

  try {
    const user = await requireVerifiedUser();
    const db = createServiceRoleClient();
    const service = DiscoveryConsentService.create(db);
    await service.recordFirstDisclosureAcknowledgment(
      user.id,
      fieldId,
      providerClass,
      disclosureContractVersion,
    );
    return { failure: null, attempt: prev.attempt + 1 };
  } catch {
    return { failure: "unavailable", attempt: prev.attempt + 1 };
  }
}
