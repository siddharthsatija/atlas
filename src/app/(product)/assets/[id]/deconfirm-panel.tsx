"use client";

/**
 * Deconfirm panel for discovery-sourced assets (ATL-211).
 *
 * Shown only when the asset has `sourceType === "discovery"` and a non-null
 * `candidateId`. Allows the user to reverse their earlier confirmation —
 * the asset is soft-deleted and the candidate transitions to `rejected`,
 * suppressing future re-surfacing via a rejection fingerprint.
 *
 * ## Destructive action guard
 *
 * The panel opens a confirmation dialog before submitting. This prevents
 * an accidental single click from erasing the asset.
 *
 * ## RSC boundary and trust model
 *
 * This component is `"use client"` because it uses `useActionState` and
 * manages the dialog's open state. It does NOT import `deconfirmAssetAction`
 * directly. Instead, the RSC page (`AssetDetailPage`) binds both `candidateId`
 * and `assetId` into the Server Action via `.bind(null, candidateId, assetId)`
 * and passes the resulting bound action as the `deconfirmAction` prop.
 *
 * No identity values are present in FormData — the form carries only user
 * intent (the submit). A client-side tamper of FormData cannot reach or alter
 * the bound `candidateId` or `assetId`.
 */

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DeconfirmActionState } from "./deconfirm-state";
import { INITIAL_DECONFIRM_ACTION_STATE } from "./deconfirm-state";

/** A Server Action pre-bound to `candidateId` and `assetId` by the RSC page. */
export type BoundDeconfirmAction = (
  prev: DeconfirmActionState,
  formData: FormData,
) => Promise<DeconfirmActionState>;

export interface DeconfirmPanelProps {
  /** Pre-bound Server Action. Both candidateId and assetId are server-fixed. */
  deconfirmAction: BoundDeconfirmAction;
  serviceName: string;
}

const COPY = {
  trigger: "Remove from my services",
  dialogHeading: "Remove this service?",
  dialogBody:
    "This will remove the service from your dashboard and mark it as not yours. It cannot be undone from here.",
  confirm: "Remove",
  cancel: "Keep it",
  errorNotFound: "This service could not be found.",
  errorNotConfirmed: "This service has already been removed.",
  errorUnavailable: "Something went wrong. Please try again.",
} as const;

export function DeconfirmPanel({ deconfirmAction, serviceName }: DeconfirmPanelProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    deconfirmAction,
    INITIAL_DECONFIRM_ACTION_STATE,
  );

  const error =
    state.failure === "not_found"
      ? COPY.errorNotFound
      : state.failure === "not_confirmed"
        ? COPY.errorNotConfirmed
        : state.failure === "unavailable"
          ? COPY.errorUnavailable
          : null;

  return (
    <div data-slot="deconfirm-panel" className="rounded-card border border-border-default p-4">
      <p className="text-body-sm font-medium text-text-primary">Discovered service</p>
      <p className="mt-1 text-body-sm text-text-secondary">
        {serviceName} was discovered automatically. If this account is not yours, you can remove it.
      </p>

      {error && (
        <p role="alert" className="mt-2 text-body-sm text-danger">
          {error}
        </p>
      )}

      {!open ? (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setOpen(true)}>
          {COPY.trigger}
        </Button>
      ) : (
        <div className="mt-3 rounded-card border border-border-default bg-surface-raised p-3">
          <h3 className="text-body-sm font-medium text-text-primary">{COPY.dialogHeading}</h3>
          <p className="mt-1 text-body-sm text-text-secondary">{COPY.dialogBody}</p>
          <div className="mt-3 flex items-center gap-2">
            <form action={formAction}>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                loading={pending}
                disabled={pending}
              >
                {COPY.confirm}
              </Button>
            </form>
            <Button variant="tertiary" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              {COPY.cancel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
