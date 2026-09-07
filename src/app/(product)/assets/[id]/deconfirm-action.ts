"use server";

/**
 * Deconfirm Server Action for the asset detail page (ATL-211).
 *
 * Reverses a confirmed discovery candidate: soft-deletes the linked digital
 * asset, transitions the candidate to `rejected`, and inserts a rejection
 * fingerprint to suppress future re-surfacing.
 *
 * ## Security properties
 *
 * - `userId` comes from `requireVerifiedUser()` — never from the argument list
 *   (architecture §10).
 * - `candidateId` and `assetId` are server-bound at the RSC layer via
 *   `.bind(null, candidateId, assetId)` in `AssetDetailPage` (Server Component).
 *   They are NOT read from FormData — no hidden input can override them.
 * - The service re-verifies ownership through the candidate's user_id FK.
 * - Only `discovery`-sourced assets with a non-null `candidateId` expose this
 *   button — checked on the page before rendering `DeconfirmPanel`.
 *
 * ## Atomicity
 *
 * The deconfirm RPC is transactional (ATL-208): soft-delete, status transition,
 * and fingerprint insert all succeed or all fail.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * No user_id, candidate_id, or fingerprint value is logged.
 */

import { revalidatePath } from "next/cache";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { CandidateAdjudicationService } from "@/server/discovery/candidate-adjudication-service";
import { revalidateAssetViews } from "./asset-action-state";
import type { DeconfirmActionState } from "./deconfirm-state";

export type { DeconfirmActionState } from "./deconfirm-state";

/**
 * Deconfirms the discovery-sourced asset identified by the server-bound
 * `assetId` and `candidateId`. Both identifiers are bound at the RSC page
 * level — they are NOT read from FormData. The action receives only user
 * intent from the form (the submit itself).
 *
 * @param candidateId  Server-bound from `asset.candidateId` in the RSC page.
 * @param assetId      Server-bound from `asset.id` in the RSC page.
 * @param previous     Previous action state from `useActionState`.
 * @param _formData    Ignored — no identity values are expected in FormData.
 */
export async function deconfirmAssetAction(
  candidateId: string,
  assetId: string,
  previous: DeconfirmActionState,
  _formData: FormData,
): Promise<DeconfirmActionState> {
  const attempt = previous.attempt + 1;

  let user;
  try {
    user = await requireVerifiedUser();
  } catch {
    return { failure: "unavailable", attempt };
  }

  try {
    const service = CandidateAdjudicationService.create();
    await service.deconfirm(user.id, candidateId);

    revalidateAssetViews(assetId);
    revalidatePath("/assets");
    return { failure: null, attempt };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "candidate_not_found") return { failure: "not_found", attempt };
    if (code === "candidate_not_confirmed") return { failure: "not_confirmed", attempt };
    return { failure: "unavailable", attempt };
  }
}
