"use client";

import { useActionState } from "react";
import { cn } from "@/lib/utils";

/**
 * A one-action form that can say when it did nothing (ATL-112).
 *
 * The edit page has seven of these — status, review, and five child-list
 * operations. Each posted to a Server Action that returned `void`, so a failed
 * write redrew the page unchanged and told the user nothing at all. A button
 * that silently declines to work is worse than an error: the user walks away
 * believing Atlas recorded something it did not.
 *
 * This is the thinnest thing that fixes that. It owns no business logic and
 * decides nothing about the operation — it renders whatever fields it is given,
 * submits them, and shows the failure the action reports.
 *
 * ## Why a client component
 *
 * `useActionState` is the only way to get an action's return value back into the
 * page, and it is a hook. The cost is that these forms now need JavaScript to
 * *display an error*; the submission itself still posts and still works without
 * it, because React renders a real `<form>` with a real action. The metadata
 * form on the same page (`AssetEditForm`) already made this trade for the same
 * reason.
 *
 * ## Why not a toast
 *
 * Frontend §19: "toasts confirm temporary events; durable status appears in the
 * page". A write that failed is durable — it stays failed until the user tries
 * again — and a toast that has faded is indistinguishable from the silence this
 * component exists to remove.
 */

/**
 * Declared here rather than imported from the route, mirroring
 * `AssetEditFormState` above it: a feature does not reach into `app/`. The
 * route's `AssetActionState` is structurally identical, which is what lets the
 * page pass its action straight in.
 */
export interface AssetActionFormState {
  failure: "not_found" | "unavailable" | "rejected" | null;
  attempt: number;
}

/**
 * What the user is told, per outcome. Never a provider message or a code.
 *
 * Exported since ATL-036: the archive toast reports a failed undo from inside a
 * toast rather than inside this form, and it must say the same thing this says.
 * A second map would be a second vocabulary, free to drift.
 */
export const ASSET_ACTION_FAILURE_MESSAGES: Record<
  NonNullable<AssetActionFormState["failure"]>,
  string
> = {
  not_found: "This service is no longer available. Nothing was changed.",
  unavailable: "Something went wrong. Nothing was changed — please try again.",
  rejected: "Atlas did not recognise that choice, so nothing was changed.",
};

export interface AssetActionFormProps {
  action: (state: AssetActionFormState, formData: FormData) => Promise<AssetActionFormState>;
  initialState: AssetActionFormState;
  assetId: string;
  /** Hidden inputs plus the control. Rendered as given, so layout stays the page's. */
  children: React.ReactNode;
  className?: string;
  /** Names the form for assistive technology, e.g. "Mark as reviewed". */
  label: string;
}

export function AssetActionForm({
  action,
  initialState,
  assetId,
  children,
  className,
  label,
}: AssetActionFormProps) {
  const [state, submit, pending] = useActionState(action, initialState);

  return (
    <form action={submit} aria-label={label} data-slot="asset-action-form" className={className}>
      <input type="hidden" name="assetId" value={assetId} />
      {children}

      {state.failure && (
        /*
          Keyed on `attempt` so a second identical failure remounts the alert.
          A live region is announced when its content changes, and the same
          sentence replacing itself is not a change — the user would retry, fail
          again, and hear nothing.
        */
        <p
          key={state.attempt}
          role="alert"
          data-slot="asset-action-error"
          className="w-full rounded-control bg-danger/10 p-3 text-body-sm text-danger"
        >
          {ASSET_ACTION_FAILURE_MESSAGES[state.failure]}
        </p>
      )}

      {/*
        The pending state (frontend §18). Not a spinner and not a disabled
        button: disabling the control the user just pressed moves focus to the
        body on some browsers, and this text is announced politely instead.
      */}
      <span aria-live="polite" className={cn("sr-only")}>
        {pending ? `${label}: working` : ""}
      </span>
    </form>
  );
}
