"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PersonalFieldForm } from "@/features/personal-fields";
import { hasUncertainEvidence } from "@/lib/requests/request-draft";
import { REQUEST_REVIEW_COPY } from "./request-review-copy";
import { RequestEvidence } from "./request-evidence";
import { RequestFieldChecklist } from "./request-field-checklist";
import { RequestRecipient } from "./request-recipient";
import {
  INITIAL_REVIEW_STATE,
  type CreateDraftAction,
  type FieldCaptureAction,
  type RequestReviewData,
  type RequestReviewFormState,
} from "./request-review-view";

/**
 * Step 1 of the request flow (ATL-058, frontend §10, PRD §9.3).
 *
 * Review what the service is believed to hold, choose what to include about
 * yourself, and say where the request should go. Submitting creates the draft;
 * ATL-059 writes its body and ATL-060 edits it.
 *
 * ## Where the selection lives before submit
 *
 * In React state, in this component, and nowhere else. Not the URL — security §8
 * forbids sensitive values in paths and query strings, and a ticked box naming a
 * personal field is exactly that. Not `localStorage` or `sessionStorage`, which
 * would leave a record of what someone was about to disclose on a shared machine
 * after they abandoned the flow. And not an interim database row: an abandoned
 * review should leave nothing behind, which is why the draft is created on
 * submit rather than on open (D3).
 *
 * Once the draft exists **the row is the source of truth**. `restoredFieldKeys`
 * and `restoredRecipient` are how a person returns to this step from Step 2, read
 * back through `RequestService.readDraftReview` — so there is exactly one place
 * this state can live at any moment, and no second mechanism to keep in sync.
 *
 * ## A dialog, on its own route
 *
 * Frontend §10 calls this a modal and requires escape, focus trap, keyboard
 * navigation and draft preservation. `Dialog` (ATL-009, Radix) provides the first
 * three. The fourth is why it sits on `/assets/[id]/request` rather than opening
 * over the detail page: a modal whose state vanishes on refresh preserves
 * nothing, and Steps 2 and 3 need somewhere to land.
 *
 * ## Deletion only
 *
 * `request_type` supports correction and the asset header offers both controls,
 * but only deletion is wired (D7). OQ-04 resolved disputed *findings* as
 * correction-not-compensation and routes corrections through editing the
 * underlying record; a correction request is a dedicated follow-up, and the
 * header still says so.
 */

export interface RequestReviewDialogProps {
  data: RequestReviewData;
  /** Creates the draft. Redirects on success, so it returns only failures. */
  createDraft: CreateDraftAction;
  /** Saves a new personal field mid-flow, recording consent (ADR-002). */
  captureField: FieldCaptureAction;
  /** Where Cancel goes back to — the asset the request is about. */
  cancelHref: string;
}

const FAILURE_COPY: Record<NonNullable<RequestReviewFormState["failure"]>, string> = {
  missing_recipient: REQUEST_REVIEW_COPY.failureMissingRecipient,
  invalid_recipient: REQUEST_REVIEW_COPY.failureInvalidRecipient,
  not_found: REQUEST_REVIEW_COPY.failureNotFound,
  unavailable: REQUEST_REVIEW_COPY.failureUnavailable,
};

export function RequestReviewDialog({
  data,
  createDraft,
  captureField,
  cancelHref,
}: RequestReviewDialogProps) {
  const [state, submit, pending] = useActionState(createDraft, INITIAL_REVIEW_STATE);

  /**
   * Selections start from whatever the stored draft holds, which is empty on a
   * first visit — so "unchecked by default" (FR-08, ADR-002) is what an empty
   * `restoredFieldKeys` produces, not a separate rule this component applies.
   *
   * Keyed by field **id** because that is what the checkboxes submit and what
   * `markUsed` stamps; the restored keys are resolved to ids once, here, against
   * the fields actually on offer.
   */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const restored = new Set(data.restoredFieldKeys);
    return new Set(
      data.offeredFields.filter((field) => restored.has(field.fieldKey)).map((field) => field.id),
    );
  });

  const [capturing, setCapturing] = useState(false);

  const uncertain = hasUncertainEvidence(data.assetConfidence, data.evidence);
  const recipientInvalid =
    state.failure === "invalid_recipient" || state.failure === "missing_recipient";

  const toggle = (fieldId: string, include: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (include) next.add(fieldId);
      else next.delete(fieldId);
      return next;
    });
  };

  return (
    <Dialog open>
      <DialogContent data-slot="request-review-dialog">
        <DialogHeader>
          <DialogTitle>
            {REQUEST_REVIEW_COPY.title}: {data.serviceName}
          </DialogTitle>
          <DialogDescription>{REQUEST_REVIEW_COPY.description}</DialogDescription>
        </DialogHeader>

        <form action={submit} className="flex flex-col gap-5" data-slot="request-review-form">
          {/*
            Which service this request is about. Carried in the form rather than
            read from the URL by the action, because a Server Action has no route
            params — and the action re-resolves ownership against it regardless,
            so a tampered value buys nothing.
          */}
          <input type="hidden" name="assetId" value={data.assetId} />

          <RequestEvidence evidence={data.evidence} uncertain={uncertain} />

          <RequestFieldChecklist
            fields={data.offeredFields}
            selectedIds={selectedIds}
            onToggle={toggle}
            hiddenAlternativeKeys={data.hiddenAlternativeKeys}
            resetKey={state.attempt}
          />

          {/*
            Just-in-time capture (ADR-002, FR-13): "collected just-in-time —
            first requested during the first draft flow, never during onboarding."
            Offered only when the vault is writable, because `save` is
            consent-gated and ATL-105 fails closed — rendering a form whose
            submission would be refused tells the person less than not offering
            it. The form is `PersonalFieldForm` unchanged, so saving here records
            consent exactly as saving in Settings does.
          */}
          {data.vaultWritable &&
            (capturing ? (
              <section
                aria-labelledby="request-capture-heading"
                data-slot="request-field-capture"
                className="flex flex-col gap-2 rounded-control border border-border-default bg-surface p-3"
              >
                <h3
                  id="request-capture-heading"
                  className="text-label font-medium text-text-primary"
                >
                  {REQUEST_REVIEW_COPY.addFieldTitle}
                </h3>
                <p className="text-body-sm text-text-secondary">
                  {REQUEST_REVIEW_COPY.addFieldDescription}
                </p>
                <PersonalFieldForm
                  mode="add"
                  action={captureField}
                  onDone={() => setCapturing(false)}
                />
              </section>
            ) : (
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  data-slot="request-capture-trigger"
                  onClick={() => setCapturing(true)}
                >
                  {REQUEST_REVIEW_COPY.addFieldToggle}
                </Button>
              </div>
            ))}

          <RequestRecipient
            defaultValue={data.restoredRecipient ?? ""}
            invalid={recipientInvalid}
          />

          {/*
            The chosen ids travel as hidden inputs rather than as the checkboxes'
            own submission, because the checkboxes are controlled and a person may
            have scrolled past them — this way what is submitted is exactly what
            the component believes is selected, and the two cannot disagree.
          */}
          {[...selectedIds].map((id) => (
            <input key={id} type="hidden" name="selectedFieldIds" value={id} />
          ))}

          <p className="text-body-sm text-text-secondary" data-slot="request-draft-only">
            {REQUEST_REVIEW_COPY.draftOnlyNotice}
          </p>

          {state.failure !== null && (
            <p
              key={state.attempt}
              role="alert"
              data-slot="request-review-error"
              className="rounded-control bg-danger/10 p-3 text-body-sm text-danger"
            >
              {FAILURE_COPY[state.failure]}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" asChild>
              <a href={cancelHref}>{REQUEST_REVIEW_COPY.cancel}</a>
            </Button>
            <Button type="submit" disabled={pending}>
              {REQUEST_REVIEW_COPY.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
