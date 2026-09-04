"use client";

/**
 * First-disclosure acknowledgment dialog (ATL-210).
 *
 * Shown before a field is first shared with a discovery provider. The user must
 * read and acknowledge the disclosure notice before the run proceeds.
 *
 * ## Fail-closed
 *
 * If disclosure content cannot be loaded for the given provider class and
 * contract version, the acknowledge button is DISABLED. The user can only
 * cancel. This prevents silent disclosure without a readable notice.
 *
 * ## Cancel semantics
 *
 * Cancel has no side effects on consent state or field storage. It simply
 * closes the dialog without recording an acknowledgment.
 */

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { getDisclosureContent } from "@/lib/discovery/disclosure-content-map";
import type { DiscoveryProviderView, DisclosureAcknowledgmentActionState } from "./discovery-view";
import { INITIAL_DISCLOSURE_ACK_ACTION_STATE } from "./discovery-view";

export type DisclosureAcknowledgmentAction = (
  prev: DisclosureAcknowledgmentActionState,
  formData: FormData,
) => Promise<DisclosureAcknowledgmentActionState>;

const COPY = {
  heading: "Before we search this provider",
  acknowledgeButton: "I understand — continue",
  cancelButton: "Cancel",
  contentUnavailable:
    "Disclosure details for this provider are not available. The acknowledgment button is disabled until content can be loaded.",
  errorUnavailable: "Something went wrong. Please try again.",
} as const;

export interface FirstDisclosureDialogProps {
  provider: DiscoveryProviderView;
  fieldLabel: string;
  acknowledgeAction: DisclosureAcknowledgmentAction;
  onCancel: () => void;
}

export function FirstDisclosureDialog({
  provider,
  fieldLabel,
  acknowledgeAction,
  onCancel,
}: FirstDisclosureDialogProps) {
  const content = getDisclosureContent(
    provider.disclosureClass,
    provider.disclosureContractVersion,
  );
  const contentAvailable = content !== null;

  const [state, submitAck, pending] = useActionState(
    acknowledgeAction,
    INITIAL_DISCLOSURE_ACK_ACTION_STATE,
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="disclosure-dialog-heading"
      data-slot="first-disclosure-dialog"
      data-provider-class={provider.providerClass}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-card border border-border-default bg-surface p-6 shadow-lg">
        <h2 id="disclosure-dialog-heading" className="text-heading-md text-text-primary">
          {COPY.heading}
        </h2>

        <p className="mt-2 text-body-sm text-text-secondary">
          Atlas will share your <span className="font-medium">{fieldLabel}</span> with{" "}
          <span className="font-mono text-text-primary">{provider.providerClass}</span> to search
          for associated records.
        </p>

        {contentAvailable ? (
          <div
            data-slot="disclosure-content"
            className="mt-4 rounded-control border border-border-default bg-surface-subtle p-3 text-body-sm text-text-secondary"
          >
            <p className="font-medium text-text-primary">{content.title}</p>
            <p className="mt-1">{content.notice}</p>
          </div>
        ) : (
          <p
            role="alert"
            data-slot="disclosure-content-unavailable"
            className="mt-4 rounded-control bg-warning/10 p-3 text-body-sm text-warning"
          >
            {COPY.contentUnavailable}
          </p>
        )}

        {state.failure !== null && (
          <p
            key={state.attempt}
            role="alert"
            data-slot="disclosure-ack-error"
            className="mt-3 rounded-control bg-danger/10 p-3 text-body-sm text-danger"
          >
            {COPY.errorUnavailable}
          </p>
        )}

        <div className="mt-6 flex items-center gap-3">
          <form action={submitAck}>
            <Button
              type="submit"
              variant="primary"
              disabled={!contentAvailable || pending}
              data-slot="disclosure-acknowledge-button"
            >
              {COPY.acknowledgeButton}
            </Button>
          </form>
          <Button variant="tertiary" onClick={onCancel} data-slot="disclosure-cancel-button">
            {COPY.cancelButton}
          </Button>
        </div>
      </div>
    </div>
  );
}
