"use server";

import { redirect } from "next/navigation";
import { isPersonalFieldKey, type PersonalFieldKey } from "@/lib/personal-fields";
import { maskValue } from "@/lib/formatting/mask";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { ConsentService } from "@/server/consent/consent-service";
import { OnboardingService } from "@/server/onboarding/onboarding-service";
import { PersonalFieldService } from "@/server/personal-fields/personal-field-service";
import type { PersonalFieldActionViewState } from "@/features/personal-fields";

/**
 * Server Actions for the Identity Profile onboarding step (ATL-209).
 *
 * Isolated from `settings/actions.ts` by design. A Settings server-action
 * module must not become a dependency of the onboarding route: the two routes
 * have different revalidation targets, different error vocabularies, and
 * different audiences (new user vs. settings user). Coupling them would mean
 * a settings change could silently alter onboarding behaviour, or vice versa.
 *
 * ## Consent path
 *
 * `grantStorageConsentForOnboardingAction` goes directly to `ConsentService`,
 * not through `settings/actions.grantPersonalFieldsConsentAction`. Both use
 * the same underlying service — the isolation is at the action boundary, not
 * in the service.
 *
 * ## Field mutations return the modified state directly
 *
 * Unlike settings (which calls `revalidatePath`), onboarding actions return
 * structured results so the client can update its local field list without a
 * server round-trip for the full page. The wizard step is self-contained: there
 * is no product page to revalidate, and the flow holds its own state.
 *
 * ## User id never comes from the form
 *
 * Every action reads it from `requireVerifiedUser` (architecture §10).
 */

/** A field as the onboarding step renders it after a successful save. */
export interface OnboardingFieldData {
  id: string;
  fieldKey: PersonalFieldKey;
  label: string;
  maskedValue: string;
  includeInDiscovery: boolean;
}

/** ------------------------------------------------------------------ */
/** Consent                                                              */
/** ------------------------------------------------------------------ */

/**
 * Records `personal_fields_storage` consent from the onboarding flow.
 *
 * Uses the same `PersonalFieldActionViewState` shape as the settings consent
 * action so that the existing `PersonalFieldsConsent` component can accept it
 * via its `action` prop — the component is agnostic about which route granted.
 */
export async function grantStorageConsentForOnboardingAction(
  previous: PersonalFieldActionViewState,
): Promise<PersonalFieldActionViewState> {
  const user = await requireVerifiedUser();
  const attempt = previous.attempt + 1;

  try {
    await ConsentService.create().grant(user.id, "personal_fields_storage");
  } catch {
    return { failure: "unavailable", attempt };
  }

  return { failure: null, attempt };
}

/** ------------------------------------------------------------------ */
/** Field mutations                                                      */
/** ------------------------------------------------------------------ */

export type SaveFieldResult =
  | { ok: true; field: OnboardingFieldData }
  | { ok: false; failure: "invalid" | "consent_required" | "unavailable" };

/**
 * Adds one identity-profile field from the onboarding step.
 *
 * Field type is restricted to the four discovery-relevant keys
 * (email, full_name, phone, address). The `username` and `other` keys are
 * excluded from the ATL-209 onboarding UI; the schema and service still support
 * them so existing storage is unaffected.
 */
export async function saveOnboardingFieldAction(
  fieldKey: PersonalFieldKey,
  label: string,
  value: string,
): Promise<SaveFieldResult> {
  const user = await requireVerifiedUser();

  const ALLOWED_KEYS: ReadonlySet<PersonalFieldKey> = new Set([
    "email",
    "full_name",
    "phone",
    "address",
  ]);

  if (!isPersonalFieldKey(fieldKey) || !ALLOWED_KEYS.has(fieldKey)) {
    return { ok: false, failure: "invalid" };
  }

  const trimmedLabel = label.trim();
  const trimmedValue = value.trim();

  if (!trimmedLabel || !trimmedValue) {
    return { ok: false, failure: "invalid" };
  }

  const result = await PersonalFieldService.create().save(user.id, {
    fieldKey,
    label: trimmedLabel,
    value: trimmedValue,
  });

  if (!result.ok) {
    if (result.code === "CONSENT_REQUIRED") return { ok: false, failure: "consent_required" };
    return { ok: false, failure: "unavailable" };
  }

  const field = result.data;
  return {
    ok: true,
    field: {
      id: field.id,
      fieldKey: field.fieldKey,
      label: field.label,
      maskedValue: maskValue(trimmedValue),
      includeInDiscovery: field.includeInDiscovery,
    },
  };
}

export type SetDiscoveryResult = { ok: boolean };

/**
 * Toggles `include_in_discovery` on one field from the onboarding step.
 *
 * Not consent-gated (matching the service). Not revalidating: the caller updates
 * its local state from the returned result.
 */
export async function setOnboardingFieldDiscoveryAction(
  fieldId: string,
  enabled: boolean,
): Promise<SetDiscoveryResult> {
  const user = await requireVerifiedUser();

  const result = await PersonalFieldService.create().setIncludeInDiscovery(
    user.id,
    fieldId,
    enabled,
  );

  return { ok: result.ok };
}

export type RemoveFieldResult =
  | { ok: true }
  | { ok: false; fieldInUse: boolean; failure: "field_in_use" | "not_found" | "unavailable" };

/**
 * Deletes one identity-profile field from the onboarding step.
 *
 * Uses `removeField()` (not `remove()`) so in-progress discovery invocations
 * block deletion. The truthful copy for the `FIELD_IN_USE` case lives in
 * `onboarding-copy.ts` under `identity_profile.fieldInUseError`.
 */
export async function removeOnboardingFieldAction(fieldId: string): Promise<RemoveFieldResult> {
  const user = await requireVerifiedUser();

  const result = await PersonalFieldService.create().removeField(user.id, fieldId);

  if (!result.ok) {
    if (result.code === "FIELD_IN_USE")
      return { ok: false, fieldInUse: true, failure: "field_in_use" };
    if (result.code === "NOT_FOUND") return { ok: false, fieldInUse: false, failure: "not_found" };
    return { ok: false, fieldInUse: false, failure: "unavailable" };
  }

  return { ok: true };
}

/** ------------------------------------------------------------------ */
/** Step completion                                                      */
/** ------------------------------------------------------------------ */

/**
 * Records Identity Profile step completion and routes accordingly.
 *
 * For **upgrade-mode users** (pre-M13, already have `onboarding_completed_at`):
 * redirects to `/overview` after stamping the completion marker. The caller
 * never sees the redirect — Next.js throws it and React's error boundary handles
 * the navigation.
 *
 * For **new users** (still in the full onboarding flow): stamps the marker and
 * returns without redirecting. The caller is responsible for advancing to the
 * next step (`ready`).
 *
 * Both paths are idempotent: if the marker is already set (repeat submission or
 * concurrent tab), `markIdentityProfileStepComplete` writes 0 rows and the
 * caller is not told — the outcome is the same regardless.
 *
 * @param isUpgradeMode - true when the user completed onboarding before M13.
 */
export async function completeIdentityProfileStepAction(isUpgradeMode: boolean): Promise<void> {
  const user = await requireVerifiedUser();
  await OnboardingService.create().completeIdentityProfileStep(user.id);
  if (isUpgradeMode) redirect("/overview");
}
