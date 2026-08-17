"use server";

import { revalidatePath } from "next/cache";
import type { ApiErrorCode } from "@/lib/api/response-envelope";
import { isPersonalFieldKey } from "@/lib/personal-fields";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { ConsentService } from "@/server/consent/consent-service";
import { PersonalFieldService } from "@/server/personal-fields/personal-field-service";
import {
  type PersonalFieldActionState,
  type PersonalFieldFailure,
  type PersonalFieldFormState,
} from "./form-state";

/**
 * Server Actions for Settings → Personal data (ATL-106).
 *
 * A thin layer over ATL-105, deliberately. Nothing here masks, encrypts, audits,
 * checks consent or decides permission — `PersonalFieldService` owns all five, and
 * a second implementation of any of them would be a second place for the
 * behaviour to drift. What these add is the two things the service cannot know:
 * who is asking, and which cache to invalidate.
 *
 * ## The user id never comes from the form
 *
 * Every action reads it from `requireVerifiedUser` (architecture §10, CLAUDE.md
 * "never trust client-provided user IDs"). A `userId` field in the payload would
 * make every one of these an account-takeover primitive.
 *
 * ## Consent is granted here, and only through `ConsentService`
 *
 * ATL-105 refuses writes until `personal_fields_storage` exists and never creates
 * it, because consent is a user action rather than a side effect of persistence.
 * `grantPersonalFieldsConsentAction` is that user action: it is reachable only
 * from a submitted button, and it calls the one service that owns consent records.
 */

/** Reads one field as text. A `File` stringifies to `[object File]`, so reject it. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The service's codes, narrowed to the four these flows can surface. */
function toFailure(code: ApiErrorCode): PersonalFieldFailure {
  if (code === "CONSENT_REQUIRED") return "consent_required";
  if (code === "INVALID_REQUEST") return "invalid";
  if (code === "NOT_FOUND") return "not_found";
  return "unavailable";
}

/**
 * Only this route reads personal fields, so only this route is invalidated.
 *
 * Narrower than `revalidateAssetViews` on purpose: an asset appears on three
 * paths, a personal field on one. Invalidating more would be work with no reader.
 */
function revalidateSettings(): void {
  revalidatePath("/settings");
}

/**
 * Records `personal_fields_storage` consent (ATL-078, ADR-002).
 *
 * Reached only from the explicit control in the consent panel, so the record
 * describes something the person actively did — which is the whole property a
 * consent record exists to provide. No value is stored by this call.
 */
export async function grantPersonalFieldsConsentAction(
  previous: PersonalFieldActionState,
): Promise<PersonalFieldActionState> {
  const user = await requireVerifiedUser();
  const attempt = previous.attempt + 1;

  try {
    await ConsentService.create().grant(user.id, "personal_fields_storage");
  } catch {
    /**
     * The caught error is not inspected or returned. `ConsentService` writes an
     * audit event as part of granting, so a failure here can mean the consent row
     * or the audit chain; neither is something to explain to a person, and both
     * mean the same thing to them — nothing was recorded.
     */
    return { failure: "unavailable", attempt };
  }

  revalidateSettings();
  return { failure: null, attempt };
}

/** Saves a new field. Refused with `consent_required` until permission exists. */
export async function addPersonalFieldAction(
  previous: PersonalFieldFormState,
  formData: FormData,
): Promise<PersonalFieldFormState> {
  const user = await requireVerifiedUser();
  const attempt = previous.attempt + 1;

  const rawKey = text(formData, "fieldKey");
  const label = text(formData, "label");
  const value = text(formData, "value");

  /**
   * Validated against the vocabulary rather than trusted. An unrecognised key
   * would be refused by the check constraint anyway, but answering here keeps the
   * database as the second gate rather than the first.
   */
  if (!isPersonalFieldKey(rawKey)) {
    return { failure: "invalid", label: label || null, fieldKey: null, attempt };
  }

  const result = await PersonalFieldService.create().save(user.id, {
    fieldKey: rawKey,
    label,
    value,
  });

  if (!result.ok) {
    /** The label survives; the value does not. See `form-state.ts`. */
    return { failure: toFailure(result.code), label: label || null, fieldKey: rawKey, attempt };
  }

  revalidateSettings();
  return { failure: null, label: null, fieldKey: null, saved: true, attempt };
}

/**
 * Edits a label, a value, or both. Also gated — an edit writes restricted data
 * exactly as a save does.
 *
 * An omitted value means "leave it alone", which is why the field is only
 * forwarded when the person typed something. Forwarding an empty string would
 * make a blank input silently erase a stored value.
 */
export async function editPersonalFieldAction(
  previous: PersonalFieldFormState,
  formData: FormData,
): Promise<PersonalFieldFormState> {
  const user = await requireVerifiedUser();
  const attempt = previous.attempt + 1;

  const fieldId = text(formData, "fieldId");
  const label = text(formData, "label");
  const value = text(formData, "value");

  const result = await PersonalFieldService.create().edit(user.id, fieldId, {
    ...(label.length > 0 ? { label } : {}),
    ...(value.length > 0 ? { value } : {}),
  });

  if (!result.ok) {
    return { failure: toFailure(result.code), label: label || null, fieldKey: null, attempt };
  }

  revalidateSettings();
  return { failure: null, label: null, fieldKey: null, saved: true, attempt };
}

/**
 * Hard-deletes one field.
 *
 * **Not consent-gated**, matching the service: deletion is the safe direction, and
 * a gate would stop someone removing the very values their withdrawal was about
 * (ADR-002, security §14).
 */
export async function deletePersonalFieldAction(
  previous: PersonalFieldActionState,
  formData: FormData,
): Promise<PersonalFieldActionState> {
  const user = await requireVerifiedUser();
  const attempt = previous.attempt + 1;

  const result = await PersonalFieldService.create().remove(user.id, text(formData, "fieldId"));

  if (!result.ok) return { failure: toFailure(result.code), attempt };

  revalidateSettings();
  return { failure: null, attempt };
}

/** What the reveal control receives. Carries no reason for a refusal. */
export interface RevealPersonalFieldResult {
  ok: boolean;
  value: string | null;
}

/**
 * Returns one field's plaintext for a deliberate reveal (ATL-035, security §8).
 *
 * The audit event is written inside the service, before the value is returned.
 * There is no branch here that can produce a value without it.
 *
 * The failure code is deliberately dropped. "No such field", "not yours" and "the
 * audit log is down" are three different sentences, and telling them apart is
 * what makes a guessed id useful to someone who should not have one — the same
 * reasoning `revealAccountIdentifierAction` records.
 */
export async function revealPersonalFieldAction(
  fieldId: string,
): Promise<RevealPersonalFieldResult> {
  const user = await requireVerifiedUser();

  const result = await PersonalFieldService.create().reveal(user.id, fieldId);

  if (!result.ok) return { ok: false, value: null };

  return { ok: true, value: result.data };
}
