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
/**
 * Shared with the detail page's archive and restore actions (ATL-036), so the
 * failure vocabulary and the attempt semantics have one definition rather than
 * two free to drift.
 */
import { rejected, text, toActionState } from "../asset-action-state";
import type { AssetActionState, EditAssetState } from "./form-state";
import type { AssetResult } from "@/server/assets/asset-service";

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
export async function setAssetStatusAction(
  previous: AssetActionState,
  formData: FormData,
): Promise<AssetActionState> {
  const user = await requireVerifiedUser();
  const assetId = text(formData, "assetId");
  const status = text(formData, "status");

  // Was a silent `return`, which rendered as a button that did nothing. Only a
  // tampered or stale form can reach it, and it still deserves an answer.
  if (!isAssetStatus(status) || status === "archived") return rejected(previous);

  const result = await AssetService.create().setAssetStatus(user.id, assetId, status);
  return toActionState(previous, result, assetId);
}

/**
 * Records an explicit review. The only thing that moves `last_verified_at`.
 *
 * `last_verified_at` feeds R-001 and ADR-004's freshness factor, so a review
 * that silently failed did not merely disappoint the user — it left the score
 * and the findings engine reasoning about a date the user believes they
 * updated.
 */
export async function markReviewedAction(
  previous: AssetActionState,
  formData: FormData,
): Promise<AssetActionState> {
  const user = await requireVerifiedUser();
  const assetId = text(formData, "assetId");

  const result = await AssetService.create().markReviewed(user.id, assetId);
  return toActionState(previous, result, assetId);
}

/** Adds or removes what the service stores about the user, and what it may do. */
export async function editAssetChildrenAction(
  previous: AssetActionState,
  formData: FormData,
): Promise<AssetActionState> {
  const user = await requireVerifiedUser();
  const service = AssetService.create();
  const assetId = text(formData, "assetId");
  const intent = text(formData, "intent");

  const result = await runChildIntent(service, user.id, assetId, intent, formData);

  return result === null ? rejected(previous) : toActionState(previous, result, assetId);
}

/**
 * Dispatches one child operation, or `null` when the submission is not one of
 * the five this form can make.
 *
 * Split out so the action above has a single place where a result is inspected.
 * Previously each branch called the service and threw its result away, which is
 * five copies of the same defect rather than one.
 */
async function runChildIntent(
  service: AssetService,
  userId: string,
  assetId: string,
  intent: string,
  formData: FormData,
): Promise<AssetResult<unknown> | null> {
  if (intent === "add-category") {
    const category = text(formData, "category");
    return isDataCategory(category)
      ? await service.addDataCategory(userId, assetId, category)
      : null;
  }

  if (intent === "remove-category") {
    return await service.removeDataCategory(userId, assetId, text(formData, "categoryId"));
  }

  if (intent === "add-permission") {
    const permissionType = text(formData, "permissionType");
    const scope = text(formData, "scope");
    return isPermissionType(permissionType) && isPermissionScope(scope)
      ? await service.addPermission(userId, assetId, permissionType, scope)
      : null;
  }

  if (intent === "revoke-permission") {
    return await service.setPermissionStatus(
      userId,
      assetId,
      text(formData, "permissionId"),
      "revoked",
    );
  }

  if (intent === "remove-permission") {
    return await service.removePermission(userId, assetId, text(formData, "permissionId"));
  }

  return null;
}
