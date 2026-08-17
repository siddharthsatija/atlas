import { AssetDetailSection, DetailEmpty } from "./asset-detail-section";

/**
 * Section 8 · Notes (ATL-034, frontend §7).
 *
 * The user's own free text, rendered with `whitespace-pre-wrap` so the line
 * breaks they typed survive. It is displayed as text and never as markup — React
 * escapes it — which matters because this is the one field on the page whose
 * contents Atlas did not shape.
 *
 * Editing belongs to ATL-033's form, which already owns validation and the
 * length limit. This section reads.
 */
export function AssetDetailNotes({ notes }: { notes: string | null }) {
  return (
    <AssetDetailSection heading="Notes" slot="asset-section-notes">
      {notes === null || notes.trim() === "" ? (
        <DetailEmpty>No notes for this service.</DetailEmpty>
      ) : (
        <p data-slot="asset-notes" className="text-body-sm whitespace-pre-wrap text-text-primary">
          {notes}
        </p>
      )}
    </AssetDetailSection>
  );
}
