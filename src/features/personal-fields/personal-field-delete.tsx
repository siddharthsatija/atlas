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
  DialogTrigger,
} from "@/components/ui/dialog";
import { PERSONAL_FIELDS_COPY } from "./personal-fields-copy";
import { INITIAL_ACTION_VIEW_STATE, type PersonalFieldButtonAction } from "./personal-fields-view";

/**
 * Deleting one personal detail, with explicit confirmation (ATL-106).
 *
 * The acceptance criterion asks for "explicit language", and CLAUDE.md requires
 * every destructive action to use explicit confirmation. So the dialog names the
 * consequence rather than asking a generic "Are you sure?": the value is
 * permanently deleted, cannot be recovered, and a later request cannot use it.
 *
 * The confirm button says what it does — "Delete permanently" — and the dismissal
 * says "Keep it" rather than "Cancel", because at the moment of a destructive
 * choice the safe option should describe the safe outcome.
 *
 * ## Deletion is not consent-gated, and that is deliberate
 *
 * `PersonalFieldService.remove` accepts a delete after consent is withdrawn.
 * Gating it would stop someone removing the very values their withdrawal was
 * about (ADR-002, security §14), so this control stays enabled in the withdrawn
 * state while add and edit do not.
 *
 * ## Danger styling is rare, and this earns it
 *
 * CLAUDE.md: "Danger styling is rare." Permanent deletion of restricted data is
 * the case it is reserved for, so the confirm button is the only `destructive`
 * control this section renders.
 */

export interface PersonalFieldDeleteProps {
  fieldId: string;
  /** The person's own label, so the dialog names what is going. */
  label: string;
  action: PersonalFieldButtonAction;
}

export function PersonalFieldDelete({ fieldId, label, action }: PersonalFieldDeleteProps) {
  const [open, setOpen] = useState(false);
  const [state, submit, pending] = useActionState(action, INITIAL_ACTION_VIEW_STATE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          data-slot="personal-field-delete-trigger"
          aria-label={`${PERSONAL_FIELDS_COPY.deleteAction}: ${label}`}
        >
          {PERSONAL_FIELDS_COPY.deleteAction}
        </Button>
      </DialogTrigger>

      <DialogContent data-slot="personal-field-delete-dialog">
        <DialogHeader>
          <DialogTitle>{PERSONAL_FIELDS_COPY.deleteTitle}</DialogTitle>
          <DialogDescription>{PERSONAL_FIELDS_COPY.deleteBody}</DialogDescription>
        </DialogHeader>

        {/*
          The label is echoed so the dialog is unambiguous about which row it acts
          on — the list can hold several details of the same kind, which is the
          reason labels exist at all.
        */}
        <p className="text-body-sm text-text-primary">{label}</p>

        <form action={submit}>
          <input type="hidden" name="fieldId" value={fieldId} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {PERSONAL_FIELDS_COPY.deleteCancel}
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {PERSONAL_FIELDS_COPY.deleteConfirm}
            </Button>
          </DialogFooter>
        </form>

        {state.failure !== null && (
          <p
            key={state.attempt}
            role="alert"
            data-slot="personal-field-delete-error"
            className="rounded-control bg-danger/10 p-3 text-body-sm text-danger"
          >
            {state.failure === "not_found"
              ? PERSONAL_FIELDS_COPY.failureNotFound
              : PERSONAL_FIELDS_COPY.failureUnavailable}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
