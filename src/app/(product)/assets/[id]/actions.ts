"use server";

import { requireVerifiedUser } from "@/server/auth/require-user";
import { AssetService } from "@/server/assets/asset-service";
import { createAiPolicyService } from "@/server/ai/composition";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import {
  presentAssetSummary,
  type ResolvedEvidence,
} from "@/server/ai/presentation/explanation-presenter";
import { DATA_CATEGORIES } from "@/lib/assets/data-categories";
import { PERMISSION_TYPES } from "@/lib/assets/permissions";
import { text, toActionState } from "./asset-action-state";
import type { AssetActionState } from "./edit/form-state";
import type { AssistantState } from "@/lib/ai/explanation-view";

/**
 * Asset detail Server Actions (ATL-035).
 *
 * ## Why an action rather than a route
 *
 * The value travels in a POST body and never in a URL, a query string, or a
 * path segment — ATL-035's third criterion. A `GET /api/assets/{id}/identifier`
 * would put the *request* for a restricted value into browser history, referrer
 * headers, and access logs even if the response body stayed clean. Next.js also
 * applies its own origin check to actions, which a hand-rolled route would have
 * to reimplement (`src/app/api/README.md`).
 *
 * ## This module exports one async function, and that is a constraint
 *
 * A `"use server"` module may export only async functions. Exporting a constant
 * from one throws at module evaluation, invisibly to tsc, ESLint and Vitest, and
 * surfaces only as a broken request — the failure ATL-032 spent a build
 * reproducing. Anything else this route needs goes in a sibling module.
 */

/** The shape returned to the browser. Carries a value only on the success path. */
export interface RevealIdentifierResult {
  ok: boolean;
  value: string | null;
}

/**
 * Reveals one asset's account identifier for its owner.
 *
 * The user id comes from the verified session, never the argument list —
 * architecture §10 — and the service re-checks ownership underneath, answering
 * `NOT_FOUND` identically for an asset that does not exist and one belonging to
 * somebody else.
 *
 * The audit event is written before the value is returned, inside the service.
 * There is no branch here that can produce a value without it.
 */
export async function revealAccountIdentifierAction(
  assetId: string,
): Promise<RevealIdentifierResult> {
  const user = await requireVerifiedUser();

  const result = await AssetService.create().revealAccountIdentifier(user.id, assetId);

  /**
   * The failure code is deliberately not returned. "Not found", "not yours" and
   * "the audit log is down" are three different sentences, and telling them
   * apart is exactly what makes a guessed id useful to someone who should not
   * have one. The component shows one refusal for all of them.
   */
  if (!result.ok) return { ok: false, value: null };

  return { ok: true, value: result.data };
}

/**
 * Asks Atlas to summarise one saved service (ATL-054).
 *
 * ## The argument list is one id, and that is the security property
 *
 * The user id comes from `requireVerifiedUser` — architecture §10, "never trust
 * client-provided user IDs". A caller can name an asset and nothing else, and
 * naming somebody else's produces `not_found`: `listAssetDetails` finds nothing
 * for this user, the policy layer returns before retrieval, and no provider call
 * is made. That refusal is byte-identical to the one for an id that names no row
 * at all, so a guessed id tells its guesser nothing.
 *
 * ## Why the details are fetched here as well as inside the policy layer
 *
 * They serve different purposes and must not be shared. The policy layer's fetch
 * builds the **context sent to the model**; this one builds the **labels shown to
 * the user**, and the two carry deliberately different information — retrieval
 * sends category and permission *codes* under stable ids, while the panel shows
 * "Financial" and "Share your data". Passing the display labels into the context
 * would put presentation strings in front of the model; passing the context
 * entries into the panel would show a user raw vocabulary ids.
 *
 * Both fetches are ownership-scoped by the same service method, so neither can
 * widen the other.
 *
 * ## No account identifier, here or in context
 *
 * The masked value has its own audited reveal path (ATL-035) and the plaintext is
 * Restricted under security §8. Neither appears in the evidence list, and
 * retrieval already excludes it.
 */
export async function summarizeAssetAction(assetId: string): Promise<AssistantState> {
  const user = await requireVerifiedUser();

  const details = await AssetService.create().listAssetDetails(user.id, assetId);

  if (!details.ok) {
    return details.code === "NOT_FOUND" ? { status: "not_found" } : { status: "unavailable" };
  }

  const { asset, dataCategories, permissions } = details.data;

  /**
   * The same rows retrieval sent, resolved to the user's own words.
   *
   * Ids are joined by the presenter and dropped when unmatched, so a citation the
   * model invented cannot reach the panel even before the invariant layer — which
   * has already rejected it — is considered.
   */
  const evidence: ResolvedEvidence[] = [
    { id: asset.id, label: asset.serviceName, href: `/assets/${asset.id}` },
    ...dataCategories.map((record) => ({
      id: record.id,
      label:
        DATA_CATEGORIES.find((entry) => entry.id === record.category)?.label ?? record.category,
      href: `/assets/${asset.id}/edit`,
    })),
    ...permissions.map((record) => ({
      id: record.id,
      label:
        PERMISSION_TYPES.find((entry) => entry.id === record.permissionType)?.label ??
        record.permissionType,
      href: `/assets/${asset.id}/edit`,
    })),
  ];

  const result = await createAiPolicyService(createServiceRoleClient()).answer({
    /** From the session, never from the caller's argument. */
    userId: user.id,
    purpose: "summarize_asset",
    subjectId: assetId,
    /**
     * No question is sent. The user pressed a button rather than typing, so
     * there is no message to relay, and inventing one ("summarise this service")
     * would put words in their mouth that the prompt already says.
     */
    userMessage: undefined,
  });

  /**
   * The service name reaches the disclosure from the **row Atlas fetched**, not
   * from the model's answer. A name taken from model output could be
   * hallucinated, and the sentence it appears in is a privacy claim.
   */
  return presentAssetSummary({ result, evidence, subjectName: asset.serviceName });
}

/**
 * Archives one service (ATL-036).
 *
 * ## What this action does not do
 *
 * It does not decide anything. `AssetService.archiveAsset` already owns the
 * transition, and through `afterMutation` it owns the activity event, the
 * findings recompute (R-006 reads archived assets) and the score recalculation
 * (ADR-004 counts an archived asset as an addressed one). Emitting any of those
 * here would give each of them two sources, and the second would be the one
 * nobody remembered to update.
 *
 * ## The transition guard is the service's, and stays there
 *
 * `archiveAsset` passes an expected status of `active` to `setStatus`, so a
 * second archive matches no row and returns `NOT_FOUND` rather than writing
 * again. That is optimistic concurrency, and it is why this action needs no
 * check of its own: two tabs racing produce one archive and one honest refusal.
 *
 * ## Identity
 *
 * The user id comes from `requireVerifiedUser` — architecture §10, "never trust
 * client-provided user IDs". The form carries an asset id and nothing else, and
 * the service re-checks ownership underneath.
 */
export async function archiveAssetAction(
  previous: AssetActionState,
  formData: FormData,
): Promise<AssetActionState> {
  const user = await requireVerifiedUser();
  const assetId = text(formData, "assetId");

  const result = await AssetService.create().archiveAsset(user.id, assetId);

  return toActionState(previous, result, assetId);
}

/**
 * Restores an archived service (ATL-036). The inverse of `archiveAssetAction`.
 *
 * Reached two ways: the undo offered immediately after archiving, and the
 * durable control on a service that is already archived. Both call this, because
 * "undo" and "restore" are the same operation viewed from different distances —
 * giving undo its own path would mean a second way to reach `active`, and a
 * second place for the activity event to be right or wrong.
 *
 * The guard mirrors archive's: an expected status of `archived`, so restoring a
 * service that is already active answers `NOT_FOUND` instead of writing.
 */
export async function restoreAssetAction(
  previous: AssetActionState,
  formData: FormData,
): Promise<AssetActionState> {
  const user = await requireVerifiedUser();
  const assetId = text(formData, "assetId");

  const result = await AssetService.create().restoreAsset(user.id, assetId);

  return toActionState(previous, result, assetId);
}
