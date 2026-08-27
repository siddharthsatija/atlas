import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RequestReviewDialog, type RequestReviewData } from "@/features/requests";
import { DATA_CATEGORIES } from "@/lib/assets/data-categories";
import { keysWithHiddenAlternatives, selectableFields } from "@/lib/requests/request-draft";
import type { SelectableField } from "@/lib/requests/request-draft";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { AssetService } from "@/server/assets/asset-service";
import { PersonalFieldService } from "@/server/personal-fields/personal-field-service";
import { captureFieldAction, createRequestDraftAction } from "./actions";

export const metadata: Metadata = { title: "Request deletion" };

const CATEGORY_LABELS = new Map(DATA_CATEGORIES.map((entry) => [entry.id, entry.label]));

/**
 * Step 1 of the request flow (ATL-058, frontend §10, PRD §9.3).
 *
 * A route rather than a modal opened over the asset page, for a reason frontend
 * §10 itself supplies: it requires draft preservation, and a modal whose state
 * vanishes on refresh preserves nothing. The dialog still provides §10's escape,
 * focus trap and keyboard semantics; this gives it somewhere to live, and gives
 * ATL-059's Step 2 somewhere to land.
 *
 * ## The ownership read runs first, alone
 *
 * `getAsset` resolves ownership and answers `notFound()` on its own, exactly as
 * the asset detail page does and for the same reason it records: a guessed or
 * foreign id should cost one round trip, not several. Only once the asset is
 * known to be this person's does the vault read run.
 *
 * ## A server component, because that is what keeps the plaintext away
 *
 * Both reads happen here. `listMasked` cannot return a full value at all, so the
 * checklist receives masks; the only path to a plaintext is the audited reveal
 * action, called from the browser in response to a click. Nothing on this page
 * can put a stored value into the RSC payload.
 */
export default async function RequestReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: assetId } = await params;
  const user = await requireVerifiedUser();

  const asset = await AssetService.create().getAsset(user.id, assetId);
  if (!asset.ok) notFound();

  const [details, stored, vaultWritable] = await Promise.all([
    AssetService.create().listAssetDetails(user.id, assetId),
    PersonalFieldService.create().listMasked(user.id),
    PersonalFieldService.create().isStoragePermitted(user.id),
  ]);

  /**
   * A failed read degrades rather than blanking the step.
   *
   * The evidence list is context, not a precondition: a person can still send a
   * request to a service whose categories Atlas could not load — the request
   * simply asks what they hold. And FR-08 makes every personal field optional, so
   * an unreadable vault costs the chance to include one, not the request itself.
   */
  const categories = details.ok ? details.data.dataCategories : [];

  const fields: SelectableField[] = stored.ok
    ? stored.data.map((field) => ({
        id: field.id,
        fieldKey: field.fieldKey,
        label: field.label,
        maskedValue: field.maskedValue,
        updatedAt: field.updatedAt,
      }))
    : [];

  const data: RequestReviewData = {
    assetId,
    serviceName: asset.data.serviceName,
    assetConfidence: asset.data.confidence,
    evidence: categories.map((category) => ({
      label: CATEGORY_LABELS.get(category.category) ?? category.category,
      confidence: category.confidence,
      source: category.source,
    })),
    /** Reduced to one per key here, so the component renders what it is given (D1). */
    offeredFields: selectableFields(fields),
    hiddenAlternativeKeys: keysWithHiddenAlternatives(fields),
    vaultWritable,
    /**
     * Empty on a first visit. There is no draft yet — D3 creates the row on
     * submit — so there is nothing to restore, and an empty selection is exactly
     * what "unchecked by default" means (FR-08, ADR-002).
     *
     * `RequestService.readDraftReview` is the read path that fills these when
     * ATL-060 returns someone to this step from Step 2.
     */
    restoredFieldKeys: [],
    restoredRecipient: null,
  };

  return (
    <RequestReviewDialog
      data={data}
      createDraft={createRequestDraftAction}
      captureField={captureFieldAction}
      cancelHref={`/assets/${assetId}`}
    />
  );
}
