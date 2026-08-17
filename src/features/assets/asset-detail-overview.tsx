import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { ASSET_CATEGORIES } from "@/lib/assets/categories";
import { AssetDetailSection, DetailFact, detailDate } from "./asset-detail-section";

/**
 * Section 2 · Overview (ATL-034, frontend §7).
 *
 * The only section that starts expanded: it is the answer to "what is this
 * service", and a detail page that opened entirely collapsed would make a user
 * click before learning anything.
 *
 * ## Provenance shown in full, because the asset actually has it
 *
 * `digital_assets` carries `source_type`, `source_label`, `confidence` and
 * `last_verified_at`, so all four appear here. The child records do not carry
 * the same set, and their sections say only what their own rows know — see
 * `DetailFact`, which drops an absent value rather than inventing a placeholder.
 *
 * ## The account identifier arrives as a slot
 *
 * Passed in as a node rather than a value, so this component never receives the
 * identifier in any form — masked or otherwise. ATL-035 owns that surface and
 * its audited reveal; keeping it behind a slot means this section stays a server
 * component, stays testable without a client boundary, and cannot leak a value
 * it never sees.
 */
const CATEGORY_LABELS = new Map(ASSET_CATEGORIES.map((entry) => [entry.id, entry.label]));

/** What the section reads. A subset, so it cannot see more than it renders. */
export interface AssetDetailOverviewAsset {
  serviceDomain: string | null;
  category: string;
  status: string;
  sourceType: string;
  sourceLabel: string | null;
  confidence: string;
  lastVerifiedAt: string | null;
  createdAt: string;
}

export interface AssetDetailOverviewProps {
  asset: AssetDetailOverviewAsset;
  /** ATL-035's masked identifier control, or nothing when none is stored. */
  accountIdentifier?: React.ReactNode;
}

export function AssetDetailOverview({ asset, accountIdentifier }: AssetDetailOverviewProps) {
  return (
    <AssetDetailSection heading="Overview" slot="asset-section-overview" defaultOpen>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={asset.status === "archived" ? "archived" : "active"} />
        <Badge tone="neutral">{CATEGORY_LABELS.get(asset.category) ?? asset.category}</Badge>
        {asset.sourceType === "demo" && <Badge tone="accent">Demo</Badge>}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <DetailFact label="Website" value={asset.serviceDomain} />

        <div>
          <dt className="text-body-sm text-text-muted">Account identifier</dt>
          <dd className="text-body-sm text-text-primary">{accountIdentifier ?? "Not recorded"}</dd>
        </div>

        {/*
          Provenance. `sourceLabel` is the user's own words about where the
          record came from and is shown only when they gave one.
        */}
        <DetailFact label="Source" value={asset.sourceType} />
        <DetailFact label="Source detail" value={asset.sourceLabel} />
        <DetailFact label="Confidence" value={asset.confidence} />

        {/*
          "Never" is stated plainly rather than left blank: it is a fact the
          user can act on, and it is what R-001 keys on. A blank would read as
          missing data instead of as an unreviewed record.
        */}
        <div>
          <dt className="text-body-sm text-text-muted">Last verified</dt>
          <dd className="text-body-sm text-text-primary">
            {detailDate(asset.lastVerifiedAt) ?? "Never"}
          </dd>
        </div>

        <DetailFact label="Added" value={detailDate(asset.createdAt)} />
      </dl>
    </AssetDetailSection>
  );
}
