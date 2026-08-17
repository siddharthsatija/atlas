import Link from "next/link";
import { SeverityBadge } from "@/components/ui/severity-badge";
import { AssetDetailSection, DetailEmpty } from "./asset-detail-section";

/**
 * Section 5 · Findings (ATL-034, frontend §7).
 *
 * ## Open and in-progress only, and the copy says so
 *
 * Fed by `FindingService.listFindingsForAsset`, which is restricted to
 * `OPEN_FINDING_STATUSES` — a decision the partial index
 * `privacy_findings_asset_open_idx` records in the schema itself ("a resolved
 * finding does not belong in that section").
 *
 * That makes the empty state load-bearing. **"No open findings for this
 * service."** — not "No findings". A user who has resolved three findings on
 * this service has a history; a bare "No findings" would tell them they never
 * had any, which is both false and quietly discouraging about work they did.
 *
 * Footprint-wide findings (`asset_id` null, today only R-008) never appear here.
 * They are about the whole footprint, and attributing one to a single service
 * would misstate what the rule found.
 *
 * ## Titles link to the finding, not to a local expansion
 *
 * The finding panel (ATL-041) is the place a finding is read, resolved and
 * dismissed. Rebuilding any of that here would be a second implementation of a
 * surface that already exists.
 */
export interface AssetDetailFinding {
  id: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  status: string;
}

export function AssetDetailFindings({ findings }: { findings: AssetDetailFinding[] }) {
  return (
    <AssetDetailSection
      heading="Findings"
      slot="asset-section-findings"
      meta={findings.length > 0 ? `${findings.length} open` : undefined}
    >
      {findings.length === 0 ? (
        <DetailEmpty>No open findings for this service.</DetailEmpty>
      ) : (
        <ul data-slot="asset-findings" className="flex flex-col gap-3">
          {findings.map((finding) => (
            <li key={finding.id} className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={finding.severity} />
              <Link
                href={`/insights?finding=${finding.id}`}
                className="text-body-sm text-accent underline underline-offset-2"
              >
                {finding.title}
              </Link>
              {finding.status === "in_progress" && (
                <span className="text-body-sm text-text-muted">In progress</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </AssetDetailSection>
  );
}
