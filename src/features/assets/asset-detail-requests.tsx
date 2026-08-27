import { AssetDetailSection, DetailEmpty } from "./asset-detail-section";

/**
 * Section 6 · Requests (ATL-034, frontend §7) — still empty, for a narrower
 * reason than before.
 *
 * ## What changed, and what did not
 *
 * The requests subsystem now exists: ATL-056 created `data_requests`, ATL-057
 * enforced its lifecycle, and ATL-058 built Step 1 so a person can prepare a
 * deletion request from the header above. What does **not** exist is the list
 * that belongs in this section — `RequestService` has no per-asset read for it,
 * and ATL-065 owns request detail.
 *
 * So the copy changed and the shape did not. It no longer says Atlas cannot make
 * requests, because that stopped being true; it says none has been prepared for
 * this service yet and points at the control that prepares one.
 *
 * ## What the copy may not do
 *
 * It may not imply Atlas sends anything, that a request is pending, or that one
 * has been sent (security §11, frontend §9). It names the action a person can
 * take and nothing more.
 *
 * No record shape is defined and no placeholder rows are rendered. The list is
 * ATL-064/ATL-065's, and inventing one here would be designing those tickets by
 * accident.
 */
export function AssetDetailRequests() {
  return (
    <AssetDetailSection heading="Requests" slot="asset-section-requests">
      <DetailEmpty>
        No requests have been prepared for this service yet. Use “Request deletion” above to prepare
        one — Atlas drafts it for you to send yourself.
      </DetailEmpty>
    </AssetDetailSection>
  );
}
