"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PERSONAL_FIELDS_COPY, PERSONAL_FIELD_KIND_LABELS } from "./personal-fields-copy";
import { PersonalFieldDelete } from "./personal-field-delete";
import { PersonalFieldForm } from "./personal-field-form";
import { PersonalFieldValue } from "./personal-field-value";
import { PersonalFieldsConsent } from "./personal-fields-consent";
import type {
  PersonalFieldButtonAction,
  PersonalFieldFormAction,
  PersonalFieldView,
} from "./personal-fields-view";

/**
 * Settings → Personal data (ATL-106, frontend §15).
 *
 * Renders the four things §15 asks for — a masked list, per-field reveal/edit/
 * delete, when each was last used, and an honest explanation of encryption and
 * AI usage — and nothing more. It is a section, not a page: ATL-074–ATL-077 own
 * the Settings shell, and this deliberately adds no navigation.
 *
 * ## Three states, and the difference between them is what the person may do
 *
 * `permitted` comes from `PersonalFieldService.isStoragePermitted`, resolved on
 * the server. The section does not re-derive it, hold a second copy, or infer it
 * from an error code — ATL-105 owns the consent decision and this reads it.
 *
 *   1. **Never granted** — the consent panel replaces the add form. Explaining
 *      first and asking second is the point: a control that only says "Allow"
 *      records agreement to something nobody was told.
 *   2. **Granted** — add, edit, reveal and delete are all available.
 *   3. **Withdrawn, with fields still stored** — the list, reveal and delete stay;
 *      add and edit are disabled behind an explanatory banner. This is the shape
 *      ATL-105's service already enforces, so the UI states it rather than
 *      inventing a stricter or looser rule. Hiding the list would leave values a
 *      person can neither see nor decide about; allowing edits would let writes
 *      continue after permission ended.
 *
 * The two states are distinguished by whether anything is stored: consent never
 * granted *and* nothing saved is a first run, so the panel leads. Withdrawn with
 * rows present is a different situation and gets different words.
 *
 * ## Every value arrives masked
 *
 * `fields` carries `maskedValue` from `listMasked`, which cannot return plaintext
 * at all. The full value reaches the browser only as the resolved return of the
 * reveal action, which audits before it answers.
 */

export interface PersonalFieldsSectionProps {
  fields: readonly PersonalFieldView[];
  /** From `isStoragePermitted`, resolved server-side. */
  permitted: boolean;
  addAction: PersonalFieldFormAction;
  editAction: PersonalFieldFormAction;
  deleteAction: PersonalFieldButtonAction;
}

/** Formats the last-used line, which is honest about never having been used. */
function lastUsedText(lastUsedAt: string | null): string {
  if (lastUsedAt === null) return PERSONAL_FIELDS_COPY.neverUsed;

  const formatted = new Date(lastUsedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${PERSONAL_FIELDS_COPY.lastUsedPrefix} ${formatted}`;
}

export function PersonalFieldsSection({
  fields,
  permitted,
  addAction,
  editAction,
  deleteAction,
}: PersonalFieldsSectionProps) {
  const [editing, setEditing] = useState<string | null>(null);

  const withdrawn = !permitted && fields.length > 0;
  const firstRun = !permitted && fields.length === 0;

  return (
    <section
      aria-labelledby="personal-data-heading"
      data-slot="personal-fields-section"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="personal-data-heading" className="text-heading-sm text-text-primary">
          {PERSONAL_FIELDS_COPY.sectionTitle}
        </h2>
        <p className="text-body-sm text-text-secondary">
          {PERSONAL_FIELDS_COPY.sectionDescription}
        </p>
      </div>

      {/*
        The two disclosures render in every state, including the withdrawn one.
        Someone deciding whether to delete a stored value needs to know how it is
        protected and what could reach the assistant just as much as someone
        deciding whether to save one.
      */}
      {!firstRun && (
        <div className="flex flex-col gap-2">
          <p
            className="text-body-sm text-text-secondary"
            data-slot="personal-fields-encryption-note"
          >
            {PERSONAL_FIELDS_COPY.encryptionNote}
          </p>
          <p className="text-body-sm text-text-secondary" data-slot="personal-fields-ai-note">
            {PERSONAL_FIELDS_COPY.aiUsageNote}
          </p>
        </div>
      )}

      {withdrawn && (
        <div
          data-slot="personal-fields-revoked-banner"
          className="flex flex-col gap-1 rounded-control border border-border-default bg-surface p-3"
        >
          <p className="text-label font-medium text-text-primary">
            {PERSONAL_FIELDS_COPY.revokedTitle}
          </p>
          <p className="text-body-sm text-text-secondary">{PERSONAL_FIELDS_COPY.revokedBody}</p>
        </div>
      )}

      {fields.length === 0 ? (
        firstRun ? (
          <PersonalFieldsConsent />
        ) : (
          <EmptyState
            title={PERSONAL_FIELDS_COPY.emptyTitle}
            description={PERSONAL_FIELDS_COPY.emptyBody}
          />
        )
      ) : (
        <ul className="flex flex-col gap-3" data-slot="personal-fields-list">
          {fields.map((field) => (
            <li
              key={field.id}
              data-slot="personal-field-row"
              className="flex flex-col gap-2 rounded-card border border-border-default bg-surface p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-label font-medium text-text-primary">{field.label}</span>
                  <span className="text-body-sm text-text-muted">
                    {PERSONAL_FIELD_KIND_LABELS[field.fieldKey]}
                  </span>
                </div>

                <PersonalFieldValue
                  masked={field.maskedValue}
                  fieldId={field.id}
                  label={field.label}
                />
              </div>

              <p className="text-body-sm text-text-muted" data-slot="personal-field-last-used">
                {lastUsedText(field.lastUsedAt)}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                {/*
                  Edit is offered only while writes are permitted. Rendering a
                  disabled trigger for a form that would be refused anyway tells
                  the person less than the banner above already does.
                */}
                {permitted && (
                  <Button
                    type="button"
                    variant="secondary"
                    data-slot="personal-field-edit-trigger"
                    aria-expanded={editing === field.id}
                    /** Named per row: the list can hold several details of one kind. */
                    aria-label={`${
                      editing === field.id
                        ? PERSONAL_FIELDS_COPY.editCancel
                        : PERSONAL_FIELDS_COPY.editAction
                    }: ${field.label}`}
                    onClick={() => setEditing(editing === field.id ? null : field.id)}
                  >
                    {editing === field.id
                      ? PERSONAL_FIELDS_COPY.editCancel
                      : PERSONAL_FIELDS_COPY.editAction}
                  </Button>
                )}

                <PersonalFieldDelete fieldId={field.id} label={field.label} action={deleteAction} />
              </div>

              {permitted && editing === field.id && (
                <PersonalFieldForm
                  mode="edit"
                  action={editAction}
                  fieldId={field.id}
                  currentLabel={field.label}
                  currentFieldKey={field.fieldKey}
                  onDone={() => setEditing(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {permitted && (
        <div className="flex flex-col gap-2">
          <h3 className="text-label font-medium text-text-primary">
            {PERSONAL_FIELDS_COPY.addTitle}
          </h3>
          <PersonalFieldForm mode="add" action={addAction} />
        </div>
      )}

      {/*
        Withdrawn *and* holding fields: the consent panel returns so permission can
        be given again, below the list rather than above it — the list is what the
        person came for, and the offer to re-enable is secondary.
      */}
      {withdrawn && <PersonalFieldsConsent disclosures={false} />}
    </section>
  );
}
