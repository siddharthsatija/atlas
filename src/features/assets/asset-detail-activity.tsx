import { AssetDetailSection, DetailEmpty, detailDate } from "./asset-detail-section";

/**
 * Section 7 · Activity (ATL-034, frontend §7).
 *
 * Fed by `ActivityEventRepository.listForEntity(userId, "asset", id)` — the
 * entity-scoped read ATL-069 built for exactly this (frontend §13's entity
 * links), so nothing new is queried here.
 *
 * ## `summary` is rendered as stored
 *
 * ATL-069 writes the sentence at emit time, through the redaction utility, and
 * the metadata allowlist bounds what can reach the row. So the safe thing to
 * render is the stored string. Re-deriving a sentence here from `eventType` and
 * `metadata` would be a second template set to keep in step with the first, and
 * the copy would drift the first time one of them changed.
 */
export interface AssetDetailActivityEvent {
  id: string;
  summary: string;
  occurredAt: string;
}

export function AssetDetailActivity({ events }: { events: AssetDetailActivityEvent[] }) {
  return (
    <AssetDetailSection heading="Activity" slot="asset-section-activity">
      {events.length === 0 ? (
        <DetailEmpty>No activity recorded for this service yet.</DetailEmpty>
      ) : (
        <ul data-slot="asset-activity" className="flex flex-col gap-2">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-body-sm text-text-secondary">{event.summary}</span>
              <span className="text-body-sm text-text-muted">{detailDate(event.occurredAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </AssetDetailSection>
  );
}
