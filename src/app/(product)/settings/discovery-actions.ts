"use server";

/**
 * Server actions for discovery consent in Settings (ATL-210).
 *
 * Grant and revoke are split because they have different auth/validation
 * requirements and revalidation targets. Both call revalidatePath on success
 * so the Settings page re-fetches consent state.
 */

import { revalidatePath } from "next/cache";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { DiscoveryConsentService } from "@/server/discovery/discovery-consent-service";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import type { DiscoveryConsentType } from "@/lib/consent";
import type { DiscoveryConsentActionState } from "@/features/discovery";

const ALLOWED_CONSENT_TYPES = new Set<string>(["discovery_hashed_query", "discovery_identifying"]);

export async function grantDiscoveryConsentAction(
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
    revalidatePath("/settings");
    return { failure: null, attempt: prev.attempt + 1 };
  } catch {
    return { failure: "unavailable", attempt: prev.attempt + 1 };
  }
}

export async function revokeDiscoveryConsentAction(
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
    await service.revokeConsent(user.id, consentType);
    revalidatePath("/settings");
    return { failure: null, attempt: prev.attempt + 1 };
  } catch {
    return { failure: "unavailable", attempt: prev.attempt + 1 };
  }
}
