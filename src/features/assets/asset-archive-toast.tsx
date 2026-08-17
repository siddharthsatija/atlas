"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastTitle,
} from "@/components/ui/toast";
import { ARCHIVE_COPY, ARCHIVE_TOAST_DURATION_MS } from "@/lib/assets/archive-copy";
import type { AssetStatus } from "@/lib/assets/asset-fields";
import { ASSET_ACTION_FAILURE_MESSAGES, type AssetActionFormState } from "./asset-action-form";

/**
 * Archive a service, with an undo (ATL-036).
 *
 * ## Why this does not use `AssetActionForm`
 *
 * That component owns its `useActionState` and exposes nothing, by design — it
 * renders a form and reports its own failure. This needs to *observe* both
 * results: an archive that succeeded opens the toast, and a restore that
 * succeeded closes it and tells the surface. So the state lives here.
 *
 * What is **not** duplicated is the vocabulary. `ASSET_ACTION_FAILURE_MESSAGES`
 * is imported from that component rather than restated, so a failed undo says
 * exactly what a failed status change says.
 *
 * ## Two forms, not one action with a flag
 *
 * Archive and restore are separate Server Actions with separate states. Sharing
 * one state would mean a failed restore could render as a failed archive, which
 * is the confusion `insights/form-state.ts` documents for dismissal and its undo
 * and solves the same way.
 *
 * ## The toast is the shortcut, not the record
 *
 * Frontend §19: durable status appears in the page. The archived badge on the
 * card and the detail page's Overview is the record; this toast is a ten-second
 * shortcut to reverse it. A user who misses it has lost the shortcut and nothing
 * else — which is why `onRestored` exists rather than the toast trying to be the
 * surface's memory.
 */

const INITIAL: AssetActionFormState = { failure: null, attempt: 0 };

/**
 * The payload a transition control sends. One field, exactly as the `<form>`
 * used to carry — the action reads `assetId` and nothing else, and identity
 * still comes from `requireVerifiedUser()` on the server.
 */
export function archivePayload(assetId: string): FormData {
  const data = new FormData();
  data.set("assetId", assetId);
  return data;
}

export interface AssetArchiveToastProps {
  assetId: string;
  /** Names every control for the service it acts on. */
  serviceName: string;
  /**
   * The asset's current lifecycle status, which decides which control is shown.
   *
   * Not local state. The status lives in the database, the surface re-reads it
   * after every successful transition (`revalidateAssetViews` invalidates this
   * page), and a copy kept here would be a second answer to "is this archived?"
   * — free to disagree with the badge rendered two elements away.
   *
   * `active` offers Archive, `archived` offers Restore, and nothing else offers
   * either: `archiveAsset` expects `active` and `restoreAsset` expects
   * `archived`, so on `inactive` or `removed` both writes match no row.
   */
  status: AssetStatus;
  archive: (state: AssetActionFormState, formData: FormData) => Promise<AssetActionFormState>;
  restore: (state: AssetActionFormState, formData: FormData) => Promise<AssetActionFormState>;
  /**
   * Told when the undo succeeded, so the surface can reflect the live status.
   *
   * The toast closes itself, but the *page* still shows an archived badge until
   * something re-reads. The server action revalidates both asset routes, so this
   * is for surfaces that keep local state rather than a substitute for that.
   */
  onRestored?: () => void;
  /**
   * Told when the undo failed, so the surface can keep recovery in reach.
   *
   * Radix's `ToastAction` closes the toast on activation — verified by probe —
   * so by the time a failure arrives the toast is gone and cannot report it. The
   * surface has to, which is what M5's Restore control on an archived service is
   * for. The failure is *also* rendered here, durably, next to the control the
   * user pressed.
   */
  onRestoreFailed?: (failure: NonNullable<AssetActionFormState["failure"]>) => void;
  /** Overridable for tests and for surfaces with a different reading load. */
  duration?: number;
}

export function AssetArchiveToast({
  assetId,
  serviceName,
  status,
  archive,
  restore,
  onRestored,
  onRestoreFailed,
  duration = ARCHIVE_TOAST_DURATION_MS,
}: AssetArchiveToastProps) {
  const [archiveState, submitArchive, archiving] = useActionState(archive, INITIAL);
  const [restoreState, submitRestore, restoring] = useActionState(restore, INITIAL);

  const [open, setOpen] = useState(false);

  /**
   * The last results this render has reacted to.
   *
   * Seeded from the incoming attempt counts, so a component that mounts holding
   * a previous result — a remount after navigation — does not pop a toast for
   * something the user did before it existed.
   */
  const [seen, setSeen] = useState({
    archive: archiveState.attempt,
    restore: restoreState.attempt,
  });

  /**
   * Adjusted during render rather than in an effect.
   *
   * React's own guidance for "state that changes when another value changes"
   * (`react.dev/learn/you-might-not-need-an-effect`), and what
   * `react-hooks/set-state-in-effect` is protecting: setting `open` from an
   * effect renders once with the old value and again with the new one, and the
   * first of those paints a toast that should not be there yet.
   */
  if (seen.archive !== archiveState.attempt || seen.restore !== restoreState.attempt) {
    const archived = archiveState.attempt !== seen.archive && archiveState.failure === null;
    const restored = restoreState.attempt !== seen.restore && restoreState.failure === null;

    setSeen({ archive: archiveState.attempt, restore: restoreState.attempt });

    /** Only a *successful* archive opens it. A failure has its own alert. */
    if (archived) setOpen(true);
    if (restored) setOpen(false);
  }

  /**
   * Telling the surface is a side effect, so it stays in an effect — and this
   * one sets no state, which is what keeps it off the cascading-render path.
   *
   * A ref rather than state: it records what has been announced, and changing it
   * must not itself cause a render.
   */
  const announced = useRef(restoreState.attempt);

  useEffect(() => {
    if (restoreState.attempt === announced.current) return;
    announced.current = restoreState.attempt;

    if (restoreState.failure === null) {
      onRestored?.();
      return;
    }

    /**
     * The toast has already closed itself — `ToastAction` dismisses on
     * activation, which is Radix's design and not something to fight. So the
     * surface is told, and the durable alert below is what the user reads.
     */
    onRestoreFailed?.(restoreState.failure);
  }, [restoreState, onRestored, onRestoreFailed]);

  return (
    <div data-slot="asset-archive" className="flex flex-col gap-1">
      {/*
        One control, chosen by the status the server just read.

        Not two controls with one hidden, and not a single button that changes
        what it posts: each transition is a different Server Action with a
        different guard, and a user must never be able to see "Restore" on a
        service that is active.
      */}
      {status === "active" && (
        <form action={submitArchive} aria-label={`${ARCHIVE_COPY.archive}: ${serviceName}`}>
          <input type="hidden" name="assetId" value={assetId} />
          <Button
            type="submit"
            variant="secondary"
            data-action="archive"
            /*
              Named for the service, like every other control on the detail
              header. The list renders one of these per card, so "Archive"
              alone would announce the same name a dozen times over.
            */
            aria-label={`${ARCHIVE_COPY.archive}: ${serviceName}`}
          >
            {ARCHIVE_COPY.archive}
          </Button>
        </form>
      )}

      {status === "archived" && (
        <form action={submitRestore} aria-label={`${ARCHIVE_COPY.restore}: ${serviceName}`}>
          <input type="hidden" name="assetId" value={assetId} />
          <Button
            type="submit"
            variant="secondary"
            data-action="restore"
            aria-label={`${ARCHIVE_COPY.restore}: ${serviceName}`}
          >
            {ARCHIVE_COPY.restore}
          </Button>
        </form>
      )}

      {status !== "active" && status !== "archived" && (
        /*
          Present, named, reachable and unavailable — ATL-005's pattern, and the
          one this header already uses for the request actions.

          `aria-disabled` rather than `disabled`, because a native disabled
          button is removed from the tab order: the keyboard user would never
          land on it and would never hear the reason. There is no handler, no
          `href` and no form here, so there is nothing for the un-blocked click
          to dispatch.
        */
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="secondary"
            aria-disabled="true"
            data-action="archive"
            aria-describedby={`archive-unavailable-${assetId}`}
            aria-label={`${ARCHIVE_COPY.archive}: ${serviceName}`}
            className="opacity-50"
          >
            {ARCHIVE_COPY.archive}
          </Button>
          <span
            id={`archive-unavailable-${assetId}`}
            className="text-body-sm text-text-muted"
            data-slot="asset-archive-unavailable"
          >
            {ARCHIVE_COPY.archiveUnavailableReason}
          </span>
        </div>
      )}

      {/*
        Failures live here, in the page, never in the toast.

        Frontend §19: "toasts confirm temporary events; durable status appears in
        the page". A failed write is durable — it stays failed until the user
        tries again — and a toast that has faded is indistinguishable from
        silence. That applies doubly to a failed *undo*, because `ToastAction`
        has already closed the toast by the time the result arrives.

        Keyed on `attempt` so a second identical failure remounts the alert and
        is announced again: a live region is announced when its content changes,
        and the same sentence replacing itself is not a change.
      */}
      {archiveState.failure && (
        <p
          key={`archive-${archiveState.attempt}`}
          role="alert"
          data-slot="asset-archive-error"
          className="text-body-sm text-danger"
        >
          {ASSET_ACTION_FAILURE_MESSAGES[archiveState.failure]}
        </p>
      )}

      {restoreState.failure && (
        <p
          key={`restore-${restoreState.attempt}`}
          role="alert"
          data-slot="asset-restore-error"
          className="text-body-sm text-danger"
        >
          {ASSET_ACTION_FAILURE_MESSAGES[restoreState.failure]}
        </p>
      )}

      <span aria-live="polite" className="sr-only">
        {archiving ? `${ARCHIVE_COPY.archive}: working` : ""}
        {restoring ? `${ARCHIVE_COPY.restore}: working` : ""}
      </span>

      {/*
        Controlled, and with an explicit duration — see `ARCHIVE_TOAST_DURATION_MS`
        for why 10s rather than Radix's inherited 5s.
      */}
      <Toast open={open} onOpenChange={setOpen} duration={duration} data-slot="asset-archive-toast">
        <div className="flex flex-col gap-1">
          <ToastTitle>{ARCHIVE_COPY.archivedTitle}</ToastTitle>
          <ToastDescription>{ARCHIVE_COPY.archivedDescription}</ToastDescription>
        </div>

        {/*
          Undo dispatches the restore action directly, rather than submitting a
          form — and that is a platform requirement, not a preference.

          ## Why a `<form>` cannot work here

          It was one, and a browser probe showed exactly why it silently did
          nothing. At the moment the click finished propagating, the control
          read `type=submit`, `hasFormOwner=true`, `formContainsControl=true`
          and **`connected=false`**: Radix removes the toast's subtree
          synchronously during activation, so by the time the browser evaluated
          the button's activation behaviour the form was no longer in the
          document. A disconnected form does not submit, so no `submit` event
          and no Server Action request were ever produced. Nothing called
          `preventDefault` — measured, `defaultPrevented=false`.

          It is deterministic rather than a race, so it failed identically at
          every viewport, and no amount of delaying the close would have fixed
          it. Moving the control elsewhere would not have either.

          Dispatching from the handler sidesteps the DOM entirely: the state
          lives in this component, which is in the page header and stays mounted
          while the portal goes.

          `startTransition` is required, and for a specific reason. React's
          `dispatchActionState` runs the action either way, but outside a
          transition it marks the node `isTransition: false` and never raises
          `isPending` — which would silently kill the polite pending region
          above. Verified against the installed react-dom source, not assumed.
        */}
        <ToastAction altText={ARCHIVE_COPY.undoAltText} asChild>
          <button
            type="button"
            data-action="undo-archive"
            onClick={() => {
              startTransition(() => {
                submitRestore(archivePayload(assetId));
              });
            }}
          >
            {ARCHIVE_COPY.undo}
          </button>
        </ToastAction>

        <ToastClose />
      </Toast>
    </div>
  );
}
