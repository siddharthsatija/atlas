import { MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AssetStatus } from "@/lib/assets/asset-fields";
import { AssetArchiveToast } from "./asset-archive-toast";
import type { AssetActionFormState } from "./asset-action-form";

/**
 * Section 1 · The identity header's actions (ATL-034, frontend §7).
 *
 * Frontend §7 names five: Edit, Archive, Request correction, Request deletion,
 * and a More menu. One of them works today. The other three are rendered, named,
 * reachable and unavailable — which is the ATL-005 pattern the asset card
 * already follows: "the control exists, is announced, and is visibly
 * unavailable". It keeps the header's layout and focus order stable so each
 * later ticket removes one unavailable state rather than redesigning the header.
 *
 * ## Why `aria-disabled` and not `disabled`
 *
 * Verified by probe, not assumed. A native `<button disabled>` is **removed from
 * the tab order**: a keyboard user tabbing across this header would never land
 * on Archive and would never hear why it cannot be used. `aria-disabled` keeps
 * the control focusable and announces it as disabled, so the explanation below
 * it is discoverable by the people most likely to need it.
 *
 * The same probe showed the trade-off: `aria-disabled` does **not** stop
 * `onClick`. That is not a risk here, because these controls have no handler,
 * no `href` and no form to submit — there is literally nothing to dispatch, so
 * no guard is needed to prevent it. `type="button"` is set anyway, so that
 * nesting the header inside a form later cannot turn one into a submit.
 *
 * This diverges from `asset-card.tsx`, which uses Radix's `disabled` on its menu
 * items and so leaves them keyboard-unreachable. The divergence is deliberate
 * and is the header's requirement, not a disagreement about the card.
 *
 * ## Archive became real in ATL-036 M5
 *
 * It was one of the unavailable three. It is now `AssetArchiveToast`, which
 * renders Archive on an active service and Restore on an archived one, shows the
 * undo toast after a successful archive, and reports either failure durably in
 * the page. It keeps Archive's position — second, between Edit and Request
 * correction — so the header's shape and focus order did not move when the
 * capability landed. That was the point of rendering it unavailable rather than
 * omitting it.
 *
 * **This surface is the only one with undo.** The asset card offers Archive and
 * Restore too, but no toast: an archived card leaves the default list the moment
 * the list is revalidated, taking any toast it owned with it (verified by
 * probe). The detail page stays put, so it is where the undo can live. See
 * `asset-card.tsx` for the other half of that distinction.
 *
 * ## What is deliberately absent
 *
 *   - No correction path. OQ-04 routes that through editing the underlying
 *     record, and it is a dedicated follow-up. Deletion is wired as of ATL-058.
 *   - The More menu holds no actions, because none exists that is in scope.
 */

/**
 * Copy for the one control that is present and still unavailable.
 *
 * Deletion moved out of this list in ATL-058, which built Step 1 of the request
 * flow. Correction stays: `request_type` supports it and the schema stores it,
 * but OQ-04 routes corrections through editing the underlying record and a
 * correction *request* is a dedicated follow-up. The reason is worded for what is
 * actually true now — requests exist, this kind does not.
 */
const UNAVAILABLE = [
  {
    key: "request-correction",
    label: "Request correction",
    reason: "Correction requests are not built yet. Deletion requests are.",
  },
] as const;

export interface AssetDetailHeaderActionsProps {
  assetId: string;
  /** Names every control for the service it acts on. */
  serviceName: string;
  /** Decides whether the second control archives or restores (ATL-036 M5). */
  status: AssetStatus;
  /**
   * The archive and restore Server Actions, passed in rather than imported.
   *
   * A feature component does not reach into `app/` — `import/no-restricted-paths`
   * enforces it — and the actions live beside the route that owns them. Passing
   * them keeps this component renderable in a unit test with no session, no
   * database and no Next runtime.
   */
  archive: (state: AssetActionFormState, formData: FormData) => Promise<AssetActionFormState>;
  restore: (state: AssetActionFormState, formData: FormData) => Promise<AssetActionFormState>;
}

export function AssetDetailHeaderActions({
  assetId,
  serviceName,
  status,
  archive,
  restore,
}: AssetDetailHeaderActionsProps) {
  return (
    <div data-slot="asset-header-actions" className="flex flex-wrap items-center gap-2">
      {/*
        Navigation, so a link rather than a button: middle-click, copy-link and
        open-in-new-tab all work.
      */}
      <Button asChild variant="secondary">
        <Link href={`/assets/${assetId}/edit`} data-action="edit">
          Edit
        </Link>
      </Button>

      {/*
        Second, where the unavailable Archive button used to sit — the header's
        focus order is a promise about where things live, and this ticket
        removed an unavailable state rather than rearranging the header.
      */}
      <AssetArchiveToast
        assetId={assetId}
        serviceName={serviceName}
        status={status}
        archive={archive}
        restore={restore}
      />

      {/*
        Step 1 of the request flow (ATL-058). Navigation, so a link — the review
        lives on its own route rather than opening over this page, because
        frontend §10 requires draft preservation and a modal whose state vanishes
        on refresh preserves nothing.

        Named for the service, like every other control here: the asset list
        renders one of these per card, and a control announced as "Request
        deletion" a dozen times over tells a screen-reader user nothing about
        which service it acts on.
      */}
      <Button asChild variant="secondary">
        <Link
          href={`/assets/${assetId}/request`}
          data-action="request-deletion"
          aria-label={`Request deletion: ${serviceName}`}
        >
          Request deletion
        </Link>
      </Button>

      {UNAVAILABLE.map((action) => (
        <div key={action.key} className="flex flex-col gap-1">
          <Button
            type="button"
            variant="secondary"
            aria-disabled="true"
            data-action={action.key}
            /*
              The reason is the control's own description, so it is announced on
              focus rather than only being readable by someone who can see the
              line underneath.
            */
            aria-describedby={`${action.key}-reason`}
            aria-label={`${action.label}: ${serviceName}`}
            className="opacity-50"
          >
            {action.label}
          </Button>
          <span id={`${action.key}-reason`} className="text-body-sm text-text-muted">
            {action.reason}
          </span>
        </div>
      ))}

      {/*
        §7's overflow menu. It exists because the header's shape is a promise
        about where things live, and the trigger is a real button in the tab
        order with Radix's arrow-key navigation inside.

        Its contents are a `DropdownMenuLabel` — not a disabled item. A label is
        non-interactive by nature, so it makes no claim to be an action and
        raises no question about whether a disabled item should be focusable.
        Inventing entries here to fill it would be designing ATL-036, ATL-037 or
        M8 by accident.
      */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="tertiary"
            className="size-9 shrink-0 p-0"
            aria-label={`More actions for ${serviceName}`}
            data-action="more"
          >
            <MoreHorizontalIcon aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel data-action="more-empty">No other actions yet.</DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
