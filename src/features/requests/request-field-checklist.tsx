"use client";

import { Label } from "@/components/ui/label";
import { PERSONAL_FIELD_KIND_LABELS, PersonalFieldValue } from "@/features/personal-fields";
import type { PersonalFieldKey } from "@/lib/personal-fields";
import { REQUEST_REVIEW_COPY } from "./request-review-copy";
import type { SelectableField } from "./request-review-view";

/**
 * The per-field include checkboxes (ATL-058, frontend §10, FR-08, ADR-002).
 *
 * ## Unchecked by default is a security property
 *
 * FR-08, ADR-002 and frontend §10 all say it, and it is not a UX preference: a
 * checked box would mean Atlas had decided to send someone's identity details to
 * a third party without being asked. `checked` is driven entirely by the caller's
 * selection set, which starts empty — there is no default, no "remember last
 * time", and no pre-tick derived from what the service is thought to hold.
 *
 * ## Values are masked, and revealing one is audited
 *
 * Each row renders `PersonalFieldValue` — ATL-106's binding over the ATL-009
 * `SensitiveValue` primitive. The full value reaches the browser only as the
 * resolved return of `revealPersonalFieldAction`, which writes
 * `personal_field.revealed` before it answers. So the checklist can show *which*
 * detail a box refers to without putting anyone's phone number in the DOM.
 *
 * ## One row per key
 *
 * The caller has already reduced the vault to one field per key (D1,
 * `selectableFields`). Where a key had alternatives, the copy says so rather than
 * letting the person wonder why their other address is missing.
 *
 * A native `<input type="checkbox">` rather than a custom control, for the reason
 * `personal-field-form.tsx` gives about its `<select>`: the platform control is
 * keyboard- and screen-reader-correct without any of the work a bespoke one would
 * need, and there is no design-system checkbox to reuse.
 */

export interface RequestFieldChecklistProps {
  fields: SelectableField[];
  /** Ids currently ticked. Empty on a first visit. */
  selectedIds: ReadonlySet<string>;
  onToggle: (fieldId: string, include: boolean) => void;
  /** Keys with more than one stored field, so the note can be shown. */
  hiddenAlternativeKeys: PersonalFieldKey[];
  /**
   * Changes on every submission, and the checkboxes are keyed on it.
   *
   * React 19 calls `requestFormReset` on a form whose action has returned, which
   * resets the DOM state of every input inside it. A controlled checkbox whose
   * `checked` prop did not change in that render is not re-synced, so after a
   * refused submission the boxes appear empty while the component still believes
   * them ticked — and the hidden inputs would still submit them. Shown and sent
   * would disagree, which on a control that decides what gets disclosed is the
   * worst place for them to.
   *
   * Keying on the attempt remounts each input, so `checked` is reapplied from
   * state. Cheaper and narrower than lifting the selection out of the form.
   */
  resetKey: number;
}

export function RequestFieldChecklist({
  fields,
  selectedIds,
  onToggle,
  hiddenAlternativeKeys,
  resetKey,
}: RequestFieldChecklistProps) {
  const hidden = new Set(hiddenAlternativeKeys);

  return (
    <section aria-labelledby="request-fields-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 id="request-fields-heading" className="text-label font-medium text-text-primary">
          {REQUEST_REVIEW_COPY.fieldsTitle}
        </h3>
        <p className="text-body-sm text-text-secondary">{REQUEST_REVIEW_COPY.fieldsDescription}</p>
      </div>

      {fields.length === 0 ? (
        <p className="text-body-sm text-text-secondary" data-slot="request-fields-empty">
          {REQUEST_REVIEW_COPY.fieldsEmpty}
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-slot="request-field-list">
          {fields.map((field) => {
            const inputId = `include-field-${field.id}`;

            return (
              <li
                key={field.id}
                data-slot="request-field-row"
                className="flex flex-col gap-2 rounded-control border border-border-default bg-surface p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <input
                      key={`${field.id}-${resetKey}`}
                      type="checkbox"
                      id={inputId}
                      name="fieldIds"
                      value={field.id}
                      checked={selectedIds.has(field.id)}
                      onChange={(event) => onToggle(field.id, event.target.checked)}
                      className="size-4 rounded-input border border-border-strong accent-accent"
                    />
                    <Label htmlFor={inputId}>
                      {field.label}
                      <span className="ml-2 text-body-sm text-text-muted">
                        {PERSONAL_FIELD_KIND_LABELS[field.fieldKey]}
                      </span>
                    </Label>
                  </div>

                  <PersonalFieldValue
                    masked={field.maskedValue}
                    fieldId={field.id}
                    label={field.label}
                  />
                </div>

                {hidden.has(field.fieldKey) && (
                  <p
                    className="text-body-sm text-text-muted"
                    data-slot="request-field-alternatives"
                  >
                    {REQUEST_REVIEW_COPY.hiddenAlternatives}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
