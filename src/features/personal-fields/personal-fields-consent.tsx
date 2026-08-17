"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { grantPersonalFieldsConsentAction } from "@/app/(product)/settings/actions";
import { PERSONAL_FIELDS_COPY } from "./personal-fields-copy";
import { INITIAL_ACTION_VIEW_STATE, type PersonalFieldConsentAction } from "./personal-fields-view";

/**
 * The consent panel for Settings → Personal data (ATL-106, ADR-002).
 *
 * ATL-105 refuses every write until `personal_fields_storage` exists, and never
 * creates the record itself — consent is a user action, not a side effect of
 * persistence. This is that user action, and the only place in the section where
 * it happens.
 *
 * ## Why all four sentences are here before the button
 *
 * A consent control that only says "Allow" records agreement to something the
 * person was never told. So the panel states, in order: why permission is needed
 * at all, what gets stored, how the encryption actually works — server-side, not
 * end-to-end, per ADR-003's explicit instruction that documentation must not
 * claim otherwise — and that no field reaches the AI assistant without separate
 * per-request approval.
 *
 * The wording lives in `personal-fields-copy.ts` so the promises can be asserted
 * by tests rather than restated in JSX where one could be softened alone.
 *
 * ## Granting takes effect immediately
 *
 * The action revalidates `/settings`, so the section re-renders with add and edit
 * enabled on the same interaction. No second step, and no stale disabled form.
 */

export interface PersonalFieldsConsentProps {
  /** Overridable so tests drive the flow without a server. */
  action?: PersonalFieldConsentAction;
  /**
   * Whether the panel carries the encryption and AI disclosures itself.
   *
   * True on a first run, where the panel is the only thing on screen and the
   * sentences have to be read before the button. False when the section already
   * shows them above the list — printing each sentence twice on one page makes
   * both easier to skip, and a reader who sees the same promise in two places has
   * to work out whether they are the same promise.
   */
  disclosures?: boolean;
}

export function PersonalFieldsConsent({
  action = grantPersonalFieldsConsentAction,
  disclosures = true,
}: PersonalFieldsConsentProps) {
  const [state, submit, pending] = useActionState(action, INITIAL_ACTION_VIEW_STATE);

  return (
    <div
      data-slot="personal-fields-consent"
      className="flex flex-col gap-3 rounded-card border border-border-default bg-surface p-4"
    >
      <h3 className="text-heading-sm text-text-primary">{PERSONAL_FIELDS_COPY.consentTitle}</h3>

      <p className="text-body-sm text-text-secondary">{PERSONAL_FIELDS_COPY.consentWhy}</p>
      <p className="text-body-sm text-text-secondary">{PERSONAL_FIELDS_COPY.consentWhatIsStored}</p>
      {disclosures && (
        <>
          <p
            className="text-body-sm text-text-secondary"
            data-slot="personal-fields-encryption-note"
          >
            {PERSONAL_FIELDS_COPY.encryptionNote}
          </p>
          <p className="text-body-sm text-text-secondary" data-slot="personal-fields-ai-note">
            {PERSONAL_FIELDS_COPY.aiUsageNote}
          </p>
        </>
      )}

      <form action={submit}>
        <Button type="submit" disabled={pending} data-slot="personal-fields-grant-consent">
          {PERSONAL_FIELDS_COPY.consentGrant}
        </Button>
      </form>

      {/*
        Durable rather than a toast. Frontend §19: "toasts confirm temporary
        events; durable status appears in the page" — a consent write that failed
        stays failed until the person tries again, and a faded toast is
        indistinguishable from the silence this is here to remove.
      */}
      {state.failure !== null && (
        <p
          key={state.attempt}
          role="alert"
          data-slot="personal-fields-consent-error"
          className="rounded-control bg-danger/10 p-3 text-body-sm text-danger"
        >
          {PERSONAL_FIELDS_COPY.failureUnavailable}
        </p>
      )}
    </div>
  );
}
