import { AssetDetailOverview, type AssetDetailOverviewAsset } from "./asset-detail-overview";
import { AssetDetailInformation, type AssetDetailCategory } from "./asset-detail-information";
import { AssetDetailPermissions, type AssetDetailPermission } from "./asset-detail-permissions";
import { AssetDetailFindings, type AssetDetailFinding } from "./asset-detail-findings";
import { AssetDetailRequests } from "./asset-detail-requests";
import { AssetDetailActivity, type AssetDetailActivityEvent } from "./asset-detail-activity";
import { AssetDetailNotes } from "./asset-detail-notes";

/**
 * Sections 2–8 of the asset detail page, in frontend §7 order (ATL-034).
 *
 * ## Why the order lives here rather than in the route
 *
 * §7 fixes the order, and an order spread across a page file is an order nobody
 * can test without rendering the whole route — session, database and all. One
 * component that renders the seven in sequence makes the contract a unit test:
 * read the rendered headings, compare to §7, done.
 *
 * It also gives M8 a single place to turn Requests from deferred into real
 * without touching the route, and gives ATL-036 one place to find the sections
 * when archive lands.
 *
 * ## Section 1 is not here
 *
 * The identity header is always visible and is not a disclosure section, so it
 * belongs to the page's header region alongside the title and the actions, not
 * to this list.
 *
 * Every section is a server component. Nothing here holds state, and the
 * disclosure is the browser's — see `asset-detail-section.tsx`.
 */
export interface AssetDetailSectionsProps {
  asset: AssetDetailOverviewAsset & { notes: string | null };
  categories: AssetDetailCategory[];
  permissions: AssetDetailPermission[];
  /** Open and in-progress only — `FindingService.listFindingsForAsset`. */
  findings: AssetDetailFinding[];
  events: AssetDetailActivityEvent[];
  /** ATL-035's masked identifier control, passed through untouched. */
  accountIdentifier?: React.ReactNode;
}

export function AssetDetailSections({
  asset,
  categories,
  permissions,
  findings,
  events,
  accountIdentifier,
}: AssetDetailSectionsProps) {
  return (
    <div data-slot="asset-detail-sections" className="flex flex-col gap-4">
      <AssetDetailOverview asset={asset} {...(accountIdentifier ? { accountIdentifier } : {})} />
      <AssetDetailInformation categories={categories} />
      <AssetDetailPermissions permissions={permissions} />
      <AssetDetailFindings findings={findings} />
      <AssetDetailRequests />
      <AssetDetailActivity events={events} />
      <AssetDetailNotes notes={asset.notes} />
    </div>
  );
}
