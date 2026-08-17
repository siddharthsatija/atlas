import { AssetDetailSection, DetailEmpty } from "./asset-detail-section";

/**
 * Section 6 · Requests (ATL-034, frontend §7) — deferred, and honest about it.
 *
 * ## Why the section exists with nothing in it
 *
 * There is no requests subsystem. `data_requests` has no migration, and three
 * places in the codebase already say so rather than pretend otherwise
 * (`privacy-score-service.ts`, `src/server/ai/README.md`,
 * `improvement-actions.test.ts`). ATL-056 and ATL-057 own it, in M8.
 *
 * The section is still rendered, in position 6, for the reason the ATL-005
 * placeholder routes and the asset card's disabled controls exist: the shape of
 * the page is a promise about where things live. Omitting it would move every
 * section below it, and M8 would then have to reopen the layout, the focus order
 * and the E2E selectors to put it back. Present-and-empty costs one collapsed
 * section now and one copy change later.
 *
 * ## What the copy may not do
 *
 * It may not imply Atlas can submit a request today, that one is pending, or
 * that anything has been sent. It states the capability is not built and names
 * what a user can do in the meantime, which is nothing here — so it says nothing
 * about what to do here.
 *
 * No record shape is defined, no placeholder rows are rendered, and no type
 * describing a request exists in this file. Inventing one would be designing
 * ATL-056 by accident, and the next ticket would inherit a model nobody chose.
 */
export function AssetDetailRequests() {
  return (
    <AssetDetailSection heading="Requests" slot="asset-section-requests">
      <DetailEmpty>
        Atlas cannot make data requests yet. When that arrives, correction and deletion requests for
        this service will appear here.
      </DetailEmpty>
    </AssetDetailSection>
  );
}
