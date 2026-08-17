import { Badge } from "@/components/ui/badge";
import { PERMISSION_TYPES } from "@/lib/assets/permissions";
import { AssetDetailSection, DetailEmpty, DetailFact, detailDate } from "./asset-detail-section";

/**
 * Section 4 · Permissions (ATL-034, frontend §7).
 *
 * ## The mirror image of Information held
 *
 * `asset_permissions` stores `last_verified_at` but carries **no** source or
 * confidence column — verified against the ATL-029 migration. So this section
 * shows a verified date and no provenance, exactly the inverse of the section
 * above it. The two are inconsistent because the tables are, and inventing the
 * missing halves to make the page look uniform would be inventing product
 * behaviour.
 *
 * ## Broad scope is flagged, not scored
 *
 * `scope` is ADR-004's binary. The badge states what is recorded; it does not
 * restate the score's judgement of it, which the score surfaces already own.
 */
/**
 * Widened to `Map<string, string>` deliberately.
 *
 * `PERMISSION_TYPES` is `as const`, so an inferred map would be keyed by the
 * literal union — and `permission_type` is a *pattern-checked* text column, not
 * an enum, so the database can hold a value outside that union. Looking up a
 * `string` and falling back to the raw value is what keeps an unrecognised
 * permission visible instead of throwing at the type boundary.
 */
const PERMISSION_LABELS = new Map<string, string>(
  PERMISSION_TYPES.map((entry) => [entry.id, entry.label]),
);

export interface AssetDetailPermission {
  id: string;
  permissionType: string;
  scope: string;
  status: string;
  lastVerifiedAt: string | null;
}

export function AssetDetailPermissions({ permissions }: { permissions: AssetDetailPermission[] }) {
  return (
    <AssetDetailSection
      heading="Permissions"
      slot="asset-section-permissions"
      meta={permissions.length > 0 ? `${permissions.length} recorded` : undefined}
    >
      {permissions.length === 0 ? (
        <DetailEmpty>No permissions are recorded for this service yet.</DetailEmpty>
      ) : (
        <ul data-slot="asset-permissions" className="flex flex-col gap-4">
          {permissions.map((record) => (
            <li key={record.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body-sm font-medium text-text-primary">
                  {PERMISSION_LABELS.get(record.permissionType) ?? record.permissionType}
                </span>
                {record.scope === "broad" && <Badge tone="warning">Broad access</Badge>}
                {record.status === "revoked" && <Badge tone="neutral">Revoked</Badge>}
                {record.status === "unknown" && <Badge tone="neutral">Status unknown</Badge>}
              </div>

              {/*
                No Source and no Confidence rows: the table has neither column.
                A verified date is all this record can honestly claim.
              */}
              <dl className="grid gap-3 sm:grid-cols-2">
                <DetailFact label="Last verified" value={detailDate(record.lastVerifiedAt)} />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </AssetDetailSection>
  );
}
