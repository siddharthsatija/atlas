import { Badge } from "@/components/ui/badge";
import { DATA_CATEGORIES } from "@/lib/assets/data-categories";
import { AssetDetailSection, DetailEmpty, DetailFact } from "./asset-detail-section";

/**
 * Section 3 · Information held (ATL-034, frontend §7).
 *
 * ## No "last verified", because the table has no such column
 *
 * `asset_data_categories` stores `source` and `confidence` but **not**
 * `last_verified_at` — verified against the ATL-028 migration. So this section
 * shows source and confidence and stops. Rendering a verified date here would
 * mean either inventing one or borrowing the parent asset's, and the second is
 * worse: it would tell the user that Atlas had confirmed *this category* on a
 * date when it had only confirmed the service.
 *
 * `sensitivity` is derived by the database from `category`, never supplied, so
 * it is shown as a fact rather than as something the user set.
 */
const CATEGORY_LABELS = new Map(DATA_CATEGORIES.map((entry) => [entry.id, entry.label]));

export interface AssetDetailCategory {
  id: string;
  category: string;
  sensitivity: string;
  description: string | null;
  source: string | null;
  confidence: string;
}

export function AssetDetailInformation({ categories }: { categories: AssetDetailCategory[] }) {
  return (
    <AssetDetailSection
      heading="Information held"
      slot="asset-section-information"
      meta={categories.length > 0 ? `${categories.length} recorded` : undefined}
    >
      {categories.length === 0 ? (
        <DetailEmpty>No categories of data are recorded for this service yet.</DetailEmpty>
      ) : (
        <ul data-slot="asset-categories" className="flex flex-col gap-4">
          {categories.map((record) => (
            <li key={record.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body-sm font-medium text-text-primary">
                  {CATEGORY_LABELS.get(record.category) ?? record.category}
                </span>
                {record.sensitivity === "high" && <Badge tone="warning">High sensitivity</Badge>}
              </div>

              {record.description && (
                <p className="text-body-sm text-text-secondary">{record.description}</p>
              )}

              <dl className="grid gap-3 sm:grid-cols-2">
                <DetailFact label="Source" value={record.source} />
                <DetailFact label="Confidence" value={record.confidence} />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </AssetDetailSection>
  );
}
