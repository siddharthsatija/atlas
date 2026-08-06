"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { AssetService } from "@/server/assets/asset-service";
import {
  parseCreateAssetForm,
  preservedValues,
  readCreateAssetForm,
} from "@/lib/assets/asset-form";
import { isAssetStatus } from "@/lib/assets/asset-fields";
import { isDataCategory } from "@/lib/assets/data-categories";
import { isPermissionScope, isPermissionType } from "@/lib/assets/permissions";
import type { EditAssetState } from "./form-state";

/**
 * Edit-asset Server Actions (ATL-033).
 *
 * Four separate actions rather than one, because the ticket's acceptance
 * criteria draw the lines: `last_reviewed` moves "on explicit review action, not
 * on every save", and status changes emit their own activity. Folding them into
 * one save would make both impossible to express.
 *
 * Every action takes the user id from `requireVerifiedUser`, never from the
 * form (architecture §10), and the service re-checks ownership underneath.
 */

/**
 * Reads one field as text.
 *
 * `FormData.get` returns `string | File`, and a `File` stringifies to
 * `[object File]` — which would sail through as a plausible-looking id. Anything
 * that is not a string is treated as absent.
 */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Saves the metadata fields. Deliberately cannot touch status or the review date. */
export async function saveAssetAction(
  previous: EditAssetState,
  formData: FormData,
): Promise<EditAssetState> {
  const user = await requireVerifiedUser();
  const assetId = text(formData, "assetId");

  const fields = readCreateAssetForm(formData);
  const attempt = previous.attempt + 1;
  const parsed = parseCreateAssetForm(fields);

  if (!parsed.success || !parsed.values) {
    return { errors: parsed.errors, failure: null, values: preservedValues(fields), attempt };
  }

  const result = await AssetService.create().updateAsset(user.id, assetId, {
    serviceName: parsed.values.serviceName,
    category: parsed.values.category,
    serviceDomain: parsed.values.serviceDomain ?? null,
    notes: parsed.values.notes ?? null,
  });

  if (!result.ok) {
    return {
      errors: {},
      failure: result.code === "NOT_FOUND" ? "not_found" : "unavailable",
      values: preservedValues(fields),
      attempt,
    };
  }

  revalidatePath(`/assets/${assetId}`);
  revalidatePath("/assets");
  redirect(`/assets/${assetId}`);
}

/**
 * Changes the lifecycle status.
 *
 * `archived` is refused by the service's own signature — archiving is ATL-036's,
 * with the undo affordance and the copy explaining it is not deletion from the
 * external service.
 */
export async function setAssetStatusAction(formData: FormData): Promise<void> {
  const user = await requireVerifiedUser();
  const assetId = text(formData, "assetId");
  const status = text(formData, "status");

  if (!isAssetStatus(status) || status === "archived") return;

  await AssetService.create().setAssetStatus(user.id, assetId, status);
  revalidatePath(`/assets/${assetId}`);
}

/** Records an explicit review. The only thing that moves `last_verified_at`. */
export async function markReviewedAction(formData: FormData): Promise<void> {
  const user = await requireVerifiedUser();
  const assetId = text(formData, "assetId");

  await AssetService.create().markReviewed(user.id, assetId);
  revalidatePath(`/assets/${assetId}`);
}

/** Adds or removes what the service stores about the user, and what it may do. */
export async function editAssetChildrenAction(formData: FormData): Promise<void> {
  const user = await requireVerifiedUser();
  const service = AssetService.create();
  const assetId = text(formData, "assetId");
  const intent = text(formData, "intent");

  if (intent === "add-category") {
    const category = text(formData, "category");
    if (isDataCategory(category)) await service.addDataCategory(user.id, assetId, category);
  } else if (intent === "remove-category") {
    await service.removeDataCategory(user.id, assetId, text(formData, "categoryId"));
  } else if (intent === "add-permission") {
    const permissionType = text(formData, "permissionType");
    const scope = text(formData, "scope");
    if (isPermissionType(permissionType) && isPermissionScope(scope)) {
      await service.addPermission(user.id, assetId, permissionType, scope);
    }
  } else if (intent === "revoke-permission") {
    await service.setPermissionStatus(user.id, assetId, text(formData, "permissionId"), "revoked");
  } else if (intent === "remove-permission") {
    await service.removePermission(user.id, assetId, text(formData, "permissionId"));
  }

  revalidatePath(`/assets/${assetId}`);
}
