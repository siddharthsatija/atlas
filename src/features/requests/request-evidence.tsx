import { Badge } from "@/components/ui/badge";
import { REQUEST_REVIEW_COPY } from "./request-review-copy";
import type { EvidenceItem } from "./request-review-view";

/**
 * "Information believed to be held", with its sources and confidence
 * (ATL-058, frontend §10, PRD §9.3).
 *
 * ## Believed, not known
 *
 * Every word here is hedged on purpose. Atlas performs no scanning and makes no
 * external checks (ADR-001, PRD): this list is what the *person* recorded about
 * the service, with the confidence §11.1 derived from its source and age. So the
 * heading says "believed to hold" and the warning says Atlas is not confident —
 * neither claims Atlas verified anything, because it did not.
 *
 * The same three facts the asset detail page shows (`asset-detail-information.tsx`),
 * rendered again here rather than linked to, because a person about to tell a
 * service what it holds should not have to leave the flow to see what they are
 * about to assert.
 */

export interface RequestEvidenceProps {
  evidence: EvidenceItem[];
  /** True when the asset or any category is `low` (D5). */
  uncertain: boolean;
}

export function RequestEvidence({ evidence, uncertain }: RequestEvidenceProps) {
  return (
    <section aria-labelledby="request-evidence-heading" className="flex flex-col gap-3">
      <h3 id="request-evidence-heading" className="text-label font-medium text-text-primary">
        {REQUEST_REVIEW_COPY.evidenceTitle}
      </h3>

      {evidence.length === 0 ? (
        <p className="text-body-sm text-text-secondary" data-slot="request-evidence-empty">
          {REQUEST_REVIEW_COPY.evidenceEmpty}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-slot="request-evidence-list">
          {evidence.map((item) => (
            <li
              key={item.label}
              className="flex flex-wrap items-center gap-2"
              data-slot="request-evidence-item"
            >
              <span className="text-body-sm text-text-primary">{item.label}</span>
              {/*
                Confidence is shown as a badge with its own text, never colour
                alone — design system §11 and the accessibility checklist both
                require the label to carry the meaning.
              */}
              <Badge>{item.confidence} confidence</Badge>
              {item.source ? (
                <span className="text-body-sm text-text-muted">from {item.source}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {uncertain && (
        <div
          data-slot="request-evidence-warning"
          /**
           * `role="note"` rather than `role="alert"`: this is present on first
           * render, and an alert announces on *change*. Announcing it as an alert
           * would interrupt a screen-reader user reading the list it refers to.
           */
          role="note"
          className="flex flex-col gap-1 rounded-control border border-warning/30 bg-warning/10 p-3"
        >
          <p className="text-label font-medium text-text-primary">
            {REQUEST_REVIEW_COPY.uncertainTitle}
          </p>
          <p className="text-body-sm text-text-secondary">{REQUEST_REVIEW_COPY.uncertainBody}</p>
        </div>
      )}
    </section>
  );
}
