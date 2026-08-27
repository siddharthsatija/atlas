"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isPersonalFieldKey } from "@/lib/personal-fields";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { AssetService } from "@/server/assets/asset-service";
import { PersonalFieldService } from "@/server/personal-fields/personal-field-service";
import { RequestService } from "@/server/requests/request-service";
import { selectableFields, checkRecipient } from "@/lib/requests/request-draft";
import type { FieldCaptureFormState, RequestReviewFormState } from "./form-state";

/**
 * Server Actions for Step 1 of the request flow (ATL-058).
 *
 * A thin layer, deliberately. Nothing here encrypts, decides what may be
 * approved, or writes a timeline entry — `RequestService.createDraft` owns all
 * three, and a second implementation of any would be a second place for the
 * behaviour to drift. What these add is the two things the service cannot know:
 * who is asking, and where to send them next.
 *
 * ## The user id never comes from the form
 *
 * Every action reads it from `requireVerifiedUser` (architecture §10, CLAUDE.md
 * "never trust client-provided user IDs"). A `userId` field in the payload would
 * make each of these an account-takeover primitive.
 *
 * ## The selection is re-resolved server-side
 *
 * The submitted ids are untrusted. Rather than believing them, the action rebuilds
 * the offered list from the person's own vault — through the same
 * `selectableFields` the page rendered — and intersects. A tampered submission
 * naming another person's field, or a second field of a key the checklist only
 * offered once, is dropped without being told which it was.
 */

/** Reads one field as text. A `File` stringifies to `[object File]`, so reject it. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Reads a repeated field, dropping anything that is not a string. */
function texts(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((value): value is string => typeof value === "string");
}

/**
 * Creates the draft Step 1 prepared, then sends the person onward.
 *
 * Redirects on success rather than returning a state, because Step 2 is a
 * different surface and there is nothing for this step to re-render. `redirect`
 * throws, so nothing after it runs — which is why the failure paths all return
 * before it.
 */
export async function createRequestDraftAction(
  previous: RequestReviewFormState,
  formData: FormData,
): Promise<RequestReviewFormState> {
  const user = await requireVerifiedUser();
  const attempt = previous.attempt + 1;

  const assetId = text(formData, "assetId");

  /**
   * Validated here as well as in the service, so the person gets the specific
   * sentence — "enter an address" reads differently from "that will not work",
   * and the service returns one code for both.
   */
  const recipient = checkRecipient(text(formData, "recipient"));
  if (!recipient.ok) {
    return {
      failure: recipient.problem === "missing" ? "missing_recipient" : "invalid_recipient",
      attempt,
    };
  }

  /**
   * Ownership first, alone. The asset read resolves whether this person may act
   * on this service at all, and answering `NOT_FOUND` before touching the vault
   * keeps a guessed id from costing two round trips — the reasoning the asset
   * detail page records.
   */
  const asset = await AssetService.create().getAsset(user.id, assetId);
  if (!asset.ok) return { failure: "not_found", attempt };

  const stored = await PersonalFieldService.create().listMasked(user.id);

  /**
   * A vault read failure is not a reason to refuse the request: FR-08 makes every
   * field optional, so a draft with none is valid. The person loses the chance to
   * include a detail they could have, which is worse than nothing but far better
   * than losing the request — and they can add it in Step 2's return path.
   */
  const offered = stored.ok
    ? selectableFields(
        stored.data.map((field) => ({
          id: field.id,
          fieldKey: field.fieldKey,
          label: field.label,
          maskedValue: field.maskedValue,
          updatedAt: field.updatedAt,
        })),
      )
    : [];

  const submitted = new Set(texts(formData, "selectedFieldIds"));
  const included = offered.filter((field) => submitted.has(field.id));

  const created = await RequestService.create().createDraft({
    userId: user.id,
    assetId,
    requestType: "deletion",
    recipient: recipient.recipient,
    includedFieldKeys: included.map((field) => field.fieldKey),
    fieldIds: included.map((field) => field.id),
  });

  if (!created.ok) {
    return {
      failure: created.code === "NOT_FOUND" ? "not_found" : "unavailable",
      attempt,
    };
  }

  /**
   * The asset page shows a Requests section and the list page will count them, so
   * both are stale the moment this lands.
   */
  revalidatePath(`/assets/${assetId}`);
  revalidatePath("/requests");

  /**
   * Step 2 is ATL-059/ATL-060. Until it exists the person lands back on the
   * service, where the draft they just created is visible — an honest
   * destination rather than a route that would 404.
   */
  redirect(`/assets/${assetId}`);
}

/**
 * Saves a personal field mid-flow (ADR-002, FR-13).
 *
 * "Collected just-in-time — first requested during the first draft flow, never
 * during onboarding." This is that capture, and it is the same
 * `PersonalFieldService.save` Settings calls: consent-gated, fail-closed, and
 * recording consent on the first save. Nothing here creates consent itself.
 */
export async function captureFieldAction(
  previous: FieldCaptureFormState,
  formData: FormData,
): Promise<FieldCaptureFormState> {
  const user = await requireVerifiedUser();
  const attempt = previous.attempt + 1;

  const rawKey = text(formData, "fieldKey");
  const label = text(formData, "label");
  const value = text(formData, "value");

  if (!isPersonalFieldKey(rawKey)) {
    return { failure: "invalid", label: label || null, fieldKey: null, attempt };
  }

  const saved = await PersonalFieldService.create().save(user.id, {
    fieldKey: rawKey,
    label,
    value,
  });

  if (!saved.ok) {
    /** The label survives; the value does not. See `form-state.ts`. */
    return {
      failure:
        saved.code === "CONSENT_REQUIRED"
          ? "consent_required"
          : saved.code === "INVALID_REQUEST"
            ? "invalid"
            : "unavailable",
      label: label || null,
      fieldKey: rawKey,
      attempt,
    };
  }

  /**
   * Re-renders Step 1 so the new field appears in the checklist — unticked, like
   * every other. Saving a detail is not approving it (ADR-002): the person still
   * has to choose to include it.
   *
   * Revalidated by route pattern rather than by concrete path: this action is
   * submitted from `PersonalFieldForm`, which is reused unchanged from Settings
   * and carries no asset id. Passing the pattern invalidates whichever instance
   * the person is on, which is the one that needs it. Settings → Personal data is
   * a different route and is unaffected.
   */
  revalidatePath("/assets/[id]/request", "page");

  return { failure: null, label: null, fieldKey: null, saved: true, attempt };
}
