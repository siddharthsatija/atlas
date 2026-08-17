"use client";

import { MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { startTransition, useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { StatusBadge, type Status } from "@/components/ui/status-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ASSET_CATEGORIES } from "@/lib/assets/categories";
import type { AssetStatus } from "@/lib/assets/asset-fields";
import { ARCHIVE_COPY } from "@/lib/assets/archive-copy";
import { cn } from "@/lib/utils";
import { ASSET_ACTION_FAILURE_MESSAGES, type AssetActionFormState } from "./asset-action-form";
import { archivePayload } from "./asset-archive-toast";

/**
 * One asset, as a card or a compact row (ATL-031, frontend §6).
 *
 * ## The account identifier is not here
 *
 * Deliberately. `AssetSummary` has no such field, because `DigitalAssetRecord`
 * has none either — ATL-027 made obtaining one a separate, explicit call. The
 * card can say *whether* an identifier is stored, which is useful, without ever
 * holding the value. Masked display and reveal are ATL-035's.
 *
 * ## Actions exist but do not all work yet
 *
 * View, edit, archive, and request are the four frontend §6 names. Edit works —
 * ATL-033 built it. Archive and restore work since ATL-036. `View details` is
 * still disabled (#139) and requests await M8; both render present and
 * disabled, following the ATL-005 top bar: the control exists, is announced,
 * and is visibly unavailable.
 *
 * ## This card archives and restores, but it does not offer undo
 *
 * That is a deliberate difference from the detail page, and it is worth being
 * precise about because the two surfaces look like they should match.
 *
 * A successful archive revalidates `/assets`, and since ATL-036 M2 the default
 * list excludes archived services — so the card leaves the list immediately.
 * That is the behaviour the list is *for*: it shows what is active, and it must
 * be right the moment the user acts. A toast owned by this card would die with
 * it: a probe confirmed that a portalled Radix toast unmounts with its owner
 * even when the provider and viewport stay mounted.
 *
 * So the undo affordance lives on the detail page, which does not move, and this
 * surface gets the durable half instead: the archived service is reachable
 * through the `Archived` status filter, where the card offers **Restore**, and a
 * failed transition reports itself in the card and stays reported.
 *
 * The alternatives were considered and rejected: hoisting toast state to a
 * layout would introduce cross-component state this codebase does not have, and
 * withholding the revalidation would leave the active list showing a service
 * that is no longer active — a stale view chosen on purpose.
 *
 * ## Why this is a client component
 *
 * `useActionState` is the only way to get an action's result back into the page,
 * and it is a hook. The card reads nothing and holds no secret — it receives
 * plain data and two Server Action references — so nothing server-only is being
 * shipped to the browser. The alternative was to put the failure alert beside
 * the overflow trigger in the header, which is where the state would have had to
 * live otherwise, and that is not where a user reading a card would look for it.
 */

/** What the card needs. A subset of `DigitalAssetRecord`, so it cannot see more. */
export interface AssetSummary {
  id: string;
  serviceName: string;
  serviceDomain: string | null;
  category: string;
  status: AssetStatus;
  sourceType: string;
  lastVerifiedAt: string | null;
  hasAccountIdentifier: boolean;
}

const CATEGORY_LABELS = new Map(ASSET_CATEGORIES.map((entry) => [entry.id, entry.label]));

/**
 * Maps the asset lifecycle onto the shared badge vocabulary.
 *
 * `inactive` and `removed` have no badge of their own, so they borrow `neutral`
 * with their own label rather than being shown as something they are not.
 */
const STATUS_PRESENTATION: Record<AssetStatus, { status: Status; label?: string }> = {
  active: { status: "active" },
  inactive: { status: "neutral", label: "Inactive" },
  archived: { status: "archived" },
  removed: { status: "neutral", label: "Removed" },
};

/** The state a card's forms start from. */
const INITIAL: AssetActionFormState = { failure: null, attempt: 0 };

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Formats the review date, explicitly in UTC.
 *
 * **Not** `toLocaleDateString`. This renders on the server, so a locale format
 * uses the *server's* timezone — which pushed `2026-03-14T00:00:00Z` back to
 * "13 Mar" on a UTC−7 host. A date that is silently a day out is worse than a
 * plain one, and it would also differ between the server render and any later
 * client render, which is a hydration mismatch waiting to happen.
 *
 * UTC is the honest default until the user's own zone is used: `profiles.timezone`
 * exists (ATL-015) and rendering in it belongs with the ticket that threads the
 * profile into these surfaces, not with the asset list.
 */
function formatReviewed(lastVerifiedAt: string | null): string {
  // "Never" is a fact worth stating plainly — it is what R-001 and the
  // last-reviewed filter key on, and an em dash would read as missing data.
  if (!lastVerifiedAt) return "Never reviewed";

  const date = new Date(lastVerifiedAt);
  if (Number.isNaN(date.getTime())) return "Never reviewed";

  return `Reviewed ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The overflow menu.
 *
 * A menu rather than hover-revealed buttons, because frontend §19 requires every
 * hover action to have a keyboard and touch equivalent — and the simplest way to
 * guarantee that is for there to be no hover-only path at all. The trigger is a
 * real button in the tab order, and Radix gives arrow-key navigation inside.
 */
function AssetActions({
  assetId,
  serviceName,
  status,
  submitArchive,
  submitRestore,
}: {
  assetId: string;
  serviceName: string;
  status: AssetStatus;
  submitArchive: (formData: FormData) => void;
  submitRestore: (formData: FormData) => void;
}) {
  /*
    The transitions dispatch from `onSelect` rather than submitting a form.

    A browser probe established why: Radix removes the menu's portalled subtree
    synchronously during activation, so a submit button inside it reads
    `connected=false` by the time the browser evaluates its activation
    behaviour. A disconnected form does not submit — no `submit` event, no
    Server Action request, and nothing called `preventDefault`. It failed
    identically at every viewport because it is deterministic, not a race.

    The state lives in `AssetCard`, which stays mounted when the menu closes, so
    the result still lands. `startTransition` keeps `isPending` rising, which
    the card's polite region depends on. See `asset-archive-toast.tsx` for the
    full probe reading.
  */
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="tertiary"
          className="size-9 shrink-0 p-0"
          // Named for the asset, so a screen-reader user moving between cards
          // hears which one each menu belongs to rather than "More, More, More".
          aria-label={`Actions for ${serviceName}`}
        >
          <MoreHorizontalIcon aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/*
          Disabled by an open defect rather than a missing feature: the detail
          page exists since ATL-034 and #139 tracks giving the card a route to
          it. Deliberately not fixed here — ATL-036 owns archive, not navigation.
        */}
        <DropdownMenuItem disabled data-action="view">
          View details
        </DropdownMenuItem>

        {/* Enabled since ATL-033. A link, so it navigates. */}
        <DropdownMenuItem asChild data-action="edit">
          <Link href={`/assets/${assetId}/edit`}>Edit</Link>
        </DropdownMenuItem>

        {/*
          The live transition, chosen by the status the server read.

          A real `<form>` inside the menu, submitting a Server Action. Verified
          by probe rather than assumed: Radix closes the menu on select, and the
          question was whether the submission survives the close. It does — the
          action ran, and the state landed on the card, which is outside the
          menu and so outlives it.

          Only one of the two is ever rendered. `archiveAsset` expects a status
          of `active` and `restoreAsset` expects `archived`, so offering the
          wrong one would be offering a write the service will refuse.
        */}
        {status === "active" && (
          <DropdownMenuItem
            data-action="archive"
            onSelect={() => {
              startTransition(() => {
                submitArchive(archivePayload(assetId));
              });
            }}
          >
            {ARCHIVE_COPY.archive}
          </DropdownMenuItem>
        )}

        {status === "archived" && (
          <DropdownMenuItem
            data-action="restore"
            onSelect={() => {
              startTransition(() => {
                submitRestore(archivePayload(assetId));
              });
            }}
          >
            {ARCHIVE_COPY.restore}
          </DropdownMenuItem>
        )}

        {status !== "active" && status !== "archived" && (
          /*
            Inactive and removed services can be neither archived nor restored,
            so the item is present and disabled — the card's existing pattern
            for a control with no capability behind it.
          */
          <DropdownMenuItem disabled data-action="archive">
            {ARCHIVE_COPY.archive}
          </DropdownMenuItem>
        )}

        {/* ATL-056 owns requests; `data_requests` has no migration yet. */}
        <DropdownMenuItem disabled data-action="request">
          Request deletion
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface AssetCardProps {
  asset: AssetSummary;
  /** Compact rows are the optional list view (§6 "compact list optional"). */
  compact?: boolean;
  /**
   * The archive and restore Server Actions, passed down from the route.
   *
   * Required, not optional. A card rendered without them would show an Archive
   * item that silently did nothing — the exact failure ATL-112 existed to
   * remove — and an optional prop makes that a runtime surprise rather than a
   * compile error.
   *
   * Passed rather than imported because a feature component does not reach into
   * `app/` (`import/no-restricted-paths`), and because it keeps the card
   * renderable in a unit test with no session and no database.
   */
  archive: (state: AssetActionFormState, formData: FormData) => Promise<AssetActionFormState>;
  restore: (state: AssetActionFormState, formData: FormData) => Promise<AssetActionFormState>;
}

export function AssetCard({ asset, compact = false, archive, restore }: AssetCardProps) {
  const presentation = STATUS_PRESENTATION[asset.status];
  const categoryLabel = CATEGORY_LABELS.get(asset.category) ?? asset.category;

  /**
   * Two states, not one action chosen by status.
   *
   * A status filter can select `Active` and `Archived` together, so a card can
   * flip from one to the other in place. Sharing a single state would then
   * leave a failed *archive* message sitting next to a **Restore** control,
   * describing an operation the user is no longer being offered.
   */
  const [archiveState, submitArchive, archiving] = useActionState(archive, INITIAL);
  const [restoreState, submitRestore, restoring] = useActionState(restore, INITIAL);

  /** Only the failure for the transition this card is actually offering. */
  const failure = asset.status === "archived" ? restoreState : archiveState;

  return (
    <Card
      data-slot="asset-card"
      data-asset-id={asset.id}
      className={cn(compact && "flex flex-row items-center justify-between gap-4 py-3")}
    >
      <CardHeader className={cn("flex-row items-start justify-between gap-3", compact && "p-0")}>
        <div className="min-w-0">
          {/*
            An h3, not an h2: the page already owns its single h1 and the region
            heading above it is the h2 (frontend §20, one h1 per page).
          */}
          <h3 className="truncate text-body font-medium text-text-primary">{asset.serviceName}</h3>
          {asset.serviceDomain && (
            <p className="truncate text-body-sm text-text-secondary">{asset.serviceDomain}</p>
          )}
        </div>
        <AssetActions
          assetId={asset.id}
          serviceName={asset.serviceName}
          status={asset.status}
          submitArchive={submitArchive}
          submitRestore={submitRestore}
        />
      </CardHeader>

      <CardContent className={cn("flex flex-wrap items-center gap-2", compact && "p-0")}>
        <StatusBadge
          status={presentation.status}
          {...(presentation.label ? { label: presentation.label } : {})}
        />
        <Badge tone="neutral">{categoryLabel}</Badge>
        {asset.sourceType === "demo" && (
          /*
            Demo records must be clearly marked wherever they render (§8,
            ATL-018). The label is the badge's text, not a colour, so it survives
            greyscale and a screen reader.
          */
          <Badge tone="accent">Demo</Badge>
        )}
        {asset.hasAccountIdentifier && (
          // Says an identifier exists without holding it. ATL-035 owns showing it.
          <Badge tone="neutral">Identifier saved</Badge>
        )}
        <span className="text-body-sm text-text-muted">{formatReviewed(asset.lastVerifiedAt)}</span>

        {failure.failure && (
          /*
            Durable, and in the card rather than in the menu.

            The menu is gone by the time the result arrives — Radix closes it on
            select — so an error rendered inside it would never be seen. It is
            also the half of frontend §19 this surface keeps: "durable status
            appears in the page", and a failed write stays failed until the user
            tries again.

            Keyed on `attempt` so a second identical failure remounts the alert
            and is announced again; a live region is announced when its content
            changes, and the same sentence replacing itself is not a change.
          */
          <p
            key={`${asset.status}-${failure.attempt}`}
            role="alert"
            data-slot="asset-card-error"
            className="w-full rounded-control bg-danger/10 p-3 text-body-sm text-danger"
          >
            {ASSET_ACTION_FAILURE_MESSAGES[failure.failure]}
          </p>
        )}

        {/*
          The pending state (§18). Announced politely rather than shown as a
          disabled control: the control the user pressed lives in a menu that has
          already closed, so there is nothing left to disable.
        */}
        <span aria-live="polite" className="sr-only">
          {archiving ? `${ARCHIVE_COPY.archive}: working` : ""}
          {restoring ? `${ARCHIVE_COPY.restore}: working` : ""}
        </span>
      </CardContent>
    </Card>
  );
}
