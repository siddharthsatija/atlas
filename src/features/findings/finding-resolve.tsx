"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  RESOLUTION_ACTIONS,
  resolutionActionLabel,
  type ResolutionAction,
} from "@/lib/findings/resolution-actions";

/**
 * The inline resolution flow (ATL-042).
 *
 * Inside the ATL-041 drawer, never over it. Frontend §19 reserves modals for
 * "focused, contained tasks" and resolving is not destructive, so a second
 * dialog would be the wrong weight — and nesting two Radix focus traps is where
 * keyboard bugs live. The flow expands in place instead.
 *
 * ## Three states, one component
 *
 *   1. **Idle.** A single "Resolve" button. Nothing is selected and nothing can
 *      be submitted, so the confirm control does not exist yet.
 *   2. **Choosing.** A required radio group of `RESOLUTION_ACTIONS`, the chosen
 *      action echoed back in words, and Confirm — disabled until something is
 *      chosen, because ATL-042 requires the action to be *selected*, not
 *      defaulted.
 *   3. **Resolved.** What was recorded, stated plainly.
 *
 * A radio group rather than a select: five options with descriptions, all
 * visible at once, is what a group is for, and it keeps every option reachable
 * by arrow keys without opening anything.
 *
 * ## Failures never reset the form
 *
 * The action returns the selection with every failure and this component seeds
 * from it, so a store outage does not cost the user their decision (frontend
 * §19). Dismiss (ATL-043) and Ask Atlas (ATL-053) are separate flows in the same
 * panel and are untouched by this one.
 */

export interface ResolveState {
  failure: "action_required" | "already_closed" | "not_found" | "unavailable" | null;
  /**
   * Typed from `lib/`, not widened to `string`: the route's state uses the same
   * union, so the two are structurally identical and the action can be passed
   * straight through under `exactOptionalPropertyTypes`.
   */
  action: ResolutionAction | null;
  resolved?: boolean;
  attempt: number;
}

/** What the user is told, per outcome. Never a provider message or a code. */
const FAILURE_MESSAGES: Record<NonNullable<ResolveState["failure"]>, string> = {
  action_required: "Choose what you did before confirming.",
  already_closed: "This finding has already been closed. Nothing was changed.",
  not_found: "This finding is no longer available. Nothing was changed.",
  unavailable: "Something went wrong. Nothing was changed — please try again.",
};

export interface FindingResolveProps {
  findingId: string;
  /** The finding's own title, so every control is named for the finding it acts on. */
  title: string;
  action: (state: ResolveState, formData: FormData) => Promise<ResolveState>;
  initialState: ResolveState;
  /** True when the finding is already resolved or dismissed. */
  closed: boolean;
}

export function FindingResolve({
  findingId,
  title,
  action,
  initialState,
  closed,
}: FindingResolveProps) {
  const [state, submit, pending] = useActionState(action, initialState);
  const [choosing, setChoosing] = useState(false);

  /**
   * Seeded from the returned state, so a failed submission keeps the choice.
   * The local value is what the radios bind to; the action's value is what
   * survives a round trip.
   */
  const [selected, setSelected] = useState<ResolutionAction | null>(initialState.action);
  const chosen = selected ?? state.action;

  if (state.resolved) {
    return (
      <div
        data-slot="resolve-result"
        className="rounded-control border border-success/20 bg-success/10 p-3"
      >
        <p className="text-body-sm font-medium text-text-primary">Resolved</p>
        <p className="text-body-sm text-text-secondary">
          {chosen ? `Recorded as: ${resolutionActionLabel(chosen)}` : "Recorded."}
        </p>
      </div>
    );
  }

  if (closed) {
    // Terminal already. §11.1's lifecycle is one-way, so there is nothing to
    // offer — showing an enabled Resolve would promise a transition that the
    // service would refuse.
    return null;
  }

  if (!choosing) {
    return (
      <Button
        variant="secondary"
        data-slot="resolve-start"
        onClick={() => setChoosing(true)}
        aria-label={`Resolve: ${title}`}
      >
        Resolve
      </Button>
    );
  }

  return (
    <form action={submit} data-slot="resolve-form" className="flex flex-col gap-3">
      <input type="hidden" name="findingId" value={findingId} />

      {/*
        Keyed on `attempt`, the same technique `asset-create-form.tsx` uses.
        React resets a form once its action completes, which clears the radios
        in the DOM; remounting the group re-applies `chosen`, so a failed
        submission keeps the user's selection visible rather than silently
        losing it.

        Namespaced, because the error alert below is a sibling and wants the
        same remount-per-attempt behaviour for its own reason. Both previously
        used the bare `attempt`, so after the first failure two children of this
        form carried the key `1` and React warned that children "may be
        duplicated and/or omitted". `attempt` was never the problem — one
        identifier naming two distinct siblings was (#87).
      */}
      <fieldset key={`reason-${String(state.attempt)}`} className="flex flex-col gap-2">
        <legend className="text-label font-medium text-text-primary">What did you do?</legend>

        {/*
          A grid rather than nested spans: the label's own text has to be a
          direct child for the control to be reliably named by it, and the grid
          is what keeps the description under the option instead of beside it.
          Both lines stay inside the label, so a radio's accessible name is the
          option *and* what it means.
        */}
        {RESOLUTION_ACTIONS.map((entry) => (
          <label
            key={entry.id}
            className="grid grid-cols-[auto_1fr] items-start gap-x-2 text-body-sm"
          >
            <input
              type="radio"
              name="action"
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
        The selection echoed back before submission, so confirming is a decision
        about something stated rather than about a radio the user hopes is still
        checked.
      */}
      <p data-slot="resolve-summary" className="text-body-sm text-text-secondary">
        {chosen
          ? `You are recording: ${resolutionActionLabel(chosen)}`
          : "Choose what you did to resolve this."}
      </p>

      {state.failure && (
        /*
          Keyed on `attempt` so a second identical failure remounts the alert: a
          live region announces a *change*, and the same sentence replacing
          itself is not one. Namespaced against the fieldset above — see #87.
        */
        <p
          key={`error-${String(state.attempt)}`}
          role="alert"
          data-slot="resolve-error"
          className="rounded-control bg-danger/10 p-3 text-body-sm text-danger"
        >
          {FAILURE_MESSAGES[state.failure]}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          /* Required, not defaulted: ATL-042 asks the user to *select*. */
          disabled={!chosen || pending}
          data-slot="resolve-confirm"
          aria-label={`Confirm resolution: ${title}`}
        >
          Confirm
        </Button>
        <Button
          type="button"
          variant="tertiary"
          data-slot="resolve-cancel"
          onClick={() => setChoosing(false)}
        >
          Cancel
        </Button>
      </div>

      <span aria-live="polite" className="sr-only">
        {pending ? "Recording your resolution" : ""}
      </span>
    </form>
  );
}
