"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DISMISSAL_REASONS,
  dismissalReasonLabel,
  type DismissalReason,
} from "@/lib/findings/dismissal-reasons";

/**
 * Dismissal and its undo (ATL-043).
 *
 * Inline in the ATL-041 drawer, alongside ATL-042's resolve flow and built the
 * same way — three states in one component, no nested dialog, failures that
 * never cost the user their input.
 *
 * ## What differs from resolve, and why
 *
 * **The reason is optional.** Frontend §5.4 says so, and it changes the control:
 * nothing is pre-selected, but Confirm is enabled from the start. Requiring a
 * reason would make the user justify a decision they are entitled to make
 * without one.
 *
 * **The score consequence is stated, not implied.** ADR-004 keeps a dismissed
 * finding's full deduction until the underlying condition clears, and the OQ-04
 * amendment makes that a rule. A user who dismisses expecting their score to
 * improve has been misled by silence, so the panel says plainly that it will
 * not, and says why.
 *
 * **Undo is offered instead of the flow once the finding is dismissed**, with no
 * time limit. §19 prefers undo for dismissal, and an unbounded one needs no
 * timer, no expiry job, and nothing timing-dependent to test.
 */

export interface DismissState {
  failure: "already_closed" | "not_found" | "unavailable" | null;
  reason: DismissalReason | null;
  dismissed?: boolean;
  attempt: number;
}

export interface RestoreState {
  failure: "already_closed" | "not_found" | "unavailable" | null;
  restored?: boolean;
  attempt: number;
}

/** The honest answer to "will this help my score?", shown wherever dismissal is. */
export const DISMISSAL_SCORE_NOTE =
  "Dismissing does not improve your privacy score. The deduction stays until the underlying " +
  "situation actually changes.";

const DISMISS_FAILURES: Record<NonNullable<DismissState["failure"]>, string> = {
  already_closed: "This finding has already been closed. Nothing was changed.",
  not_found: "This finding is no longer available. Nothing was changed.",
  unavailable: "Something went wrong. Nothing was changed — please try again.",
};

const RESTORE_FAILURES: Record<NonNullable<RestoreState["failure"]>, string> = {
  already_closed: "This finding is not dismissed, so there is nothing to restore.",
  not_found: "This finding is no longer available. Nothing was changed.",
  unavailable: "Something went wrong. Nothing was changed — please try again.",
};

export interface FindingDismissProps {
  findingId: string;
  /** The finding's own title, so every control is named for what it acts on. */
  title: string;
  dismiss: {
    action: (state: DismissState, formData: FormData) => Promise<DismissState>;
    initialState: DismissState;
  };
  restore: {
    action: (state: RestoreState, formData: FormData) => Promise<RestoreState>;
    initialState: RestoreState;
  };
  /** The finding's current status, which decides which half of this renders. */
  status: string;
}

export function FindingDismiss({
  findingId,
  title,
  dismiss,
  restore,
  status,
}: FindingDismissProps) {
  const [dismissState, submitDismiss, dismissing] = useActionState(
    dismiss.action,
    dismiss.initialState,
  );
  const [restoreState, submitRestore, restoring] = useActionState(
    restore.action,
    restore.initialState,
  );
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<DismissalReason | null>(dismiss.initialState.reason);

  const chosen = selected ?? dismissState.reason;

  /**
   * Undo returns the panel to rest, not to the flow it just undid.
   *
   * `choosing` is set when the user opens the dismissal form and, before this,
   * was cleared only by Cancel. It therefore survived a dismissal: the
   * `isDismissed` branch above hid it, but the moment a restore succeeded that
   * branch stopped matching and the stale `true` fell through to the form —
   * dropping the user back into "Why are you dismissing this?" immediately after
   * they had undone exactly that. Verified in a browser: the finding was open,
   * the status badge read `open`, and the dismissal form was on screen.
   *
   * ## Why an edge trigger rather than a derived value
   *
   * `choosing && !restoreState.restored` would read correctly once and then
   * never let the user dismiss again — `restored` stays true for the life of the
   * component, so the form could never reopen. The same is true of an
   * unconditional `if (restored && choosing) setChoosing(false)` during render,
   * which additionally spins: every attempt to reopen is undone on the next
   * render.
   *
   * So this fires **once per completed restore**, keyed on the attempt counter
   * the action already increments (`restoreFindingAction`). After it runs, the
   * counter matches and `choosing` is left alone, so dismissing again behaves
   * exactly as it did before the undo.
   *
   * Setting state during render is React's documented way to adjust state when
   * an input changes; it re-renders immediately without committing the
   * intermediate output, and needs no effect and no timer.
   */
  const [seenRestoreAttempt, setSeenRestoreAttempt] = useState(restore.initialState.attempt);

  if (restoreState.attempt !== seenRestoreAttempt) {
    setSeenRestoreAttempt(restoreState.attempt);
    /** Only a *successful* restore returns to rest. A failure leaves the panel as it was. */
    if (restoreState.restored) setChoosing(false);
  }

  /**
   * Dismissed either on arrival or just now, and not since restored.
   *
   * Read from both the route's data and this render's own results, so the panel
   * is correct immediately after either action without waiting for
   * revalidation to come back.
   */
  const isDismissed = (status === "dismissed" || dismissState.dismissed) && !restoreState.restored;

  if (isDismissed) {
    return (
      <div data-slot="dismiss-restore" className="flex flex-col gap-2">
        <p className="text-body-sm text-text-secondary">
          You dismissed this finding
          {chosen ? `: ${dismissalReasonLabel(chosen)}.` : "."} It stays in your Dismissed view, and
          you can bring it back at any time.
        </p>

        {restoreState.failure && (
          <p
            key={restoreState.attempt}
            role="alert"
            data-slot="restore-error"
            className="rounded-control bg-danger/10 p-3 text-body-sm text-danger"
          >
            {RESTORE_FAILURES[restoreState.failure]}
          </p>
        )}

        <form action={submitRestore}>
          <input type="hidden" name="findingId" value={findingId} />
          <Button
            type="submit"
            variant="secondary"
            disabled={restoring}
            data-slot="restore-confirm"
            aria-label={`Restore: ${title}`}
          >
            Restore this finding
          </Button>
        </form>

        <span aria-live="polite" className="sr-only">
          {restoring ? "Restoring this finding" : ""}
        </span>
      </div>
    );
  }

  if (status === "resolved") {
    /**
     * Nothing to offer. §11.1's lifecycle is one-way out of `resolved`, and undo
     * here is deliberately not the inverse of *resolution* — that assertion has
     * already been counted by ADR-004's protective-actions factor.
     */
    return null;
  }

  if (!choosing) {
    return (
      <Button
        variant="tertiary"
        data-slot="dismiss-start"
        onClick={() => setChoosing(true)}
        aria-label={`Dismiss: ${title}`}
      >
        Dismiss
      </Button>
    );
  }

  return (
    <form action={submitDismiss} data-slot="dismiss-form" className="flex flex-col gap-3">
      <input type="hidden" name="findingId" value={findingId} />

      {/*
        Keyed on `attempt` for the reason ATL-042 documents: React resets a form
        once its action completes, clearing the radios in the DOM, so the group
        is remounted to re-apply the choice a failed submission returned.

        Namespaced, because the error alert below is a sibling wanting the same
        remount-per-attempt behaviour. Both previously used the bare `attempt`,
        so after the first failure two children of this form carried the key `1`
        and React warned that children "may be duplicated and/or omitted" — which
        here could have reconciled the radio group into the alert and lost the
        user's reason on retry, the very thing the key exists to protect (#87).
      */}
      <fieldset key={`reason-${String(dismissState.attempt)}`} className="flex flex-col gap-2">
        <legend className="text-label font-medium text-text-primary">
          Why are you dismissing this? <span className="text-text-muted">(optional)</span>
        </legend>

        {DISMISSAL_REASONS.map((entry) => (
          <label
            key={entry.id}
            className="grid grid-cols-[auto_1fr] items-start gap-x-2 text-body-sm"
          >
            <input
              type="radio"
              name="reason"
              value={entry.id}
              checked={chosen === entry.id}
              onChange={() => setSelected(entry.id)}
              className="mt-1"
            />
            <span className="text-text-primary">{entry.label}</span>
            <span className="col-start-2 text-text-muted">{entry.description}</span>
          </label>
        ))}
      </fieldset>

      {/*
        The one thing a user is most likely to assume wrongly, said before they
        act rather than after (ADR-004, OQ-04).
      */}
      <p data-slot="dismiss-score-note" className="text-body-sm text-text-secondary">
        {DISMISSAL_SCORE_NOTE}
      </p>

      {dismissState.failure && (
        /*
          Keyed on `attempt` so a second identical failure remounts the alert: a
          live region announces a *change*, and the same sentence replacing
          itself is not one. Namespaced against the fieldset above — see #87.
        */
        <p
          key={`error-${String(dismissState.attempt)}`}
          role="alert"
          data-slot="dismiss-error"
          className="rounded-control bg-danger/10 p-3 text-body-sm text-danger"
        >
          {DISMISS_FAILURES[dismissState.failure]}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Enabled from the start: the reason is optional, so there is nothing to wait for. */}
        <Button
          type="submit"
          variant="secondary"
          disabled={dismissing}
          data-slot="dismiss-confirm"
          aria-label={`Confirm dismissal: ${title}`}
        >
          Dismiss this finding
        </Button>
        <Button
          type="button"
          variant="tertiary"
          data-slot="dismiss-cancel"
          onClick={() => setChoosing(false)}
        >
          Cancel
        </Button>
      </div>

      <span aria-live="polite" className="sr-only">
        {dismissing ? "Dismissing this finding" : ""}
      </span>
    </form>
  );
}
