import { MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
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
import { cn } from "@/lib/utils";

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
 * ## Actions exist but do not work yet
 *
 * View, edit, archive, and request are the four frontend §6 names. Edit works —
 * ATL-033 built it. The rest await ATL-034, ATL-036, and M8, and render present
 * and disabled, following the ATL-005 top bar: the control exists, is announced,
 * and is visibly unavailable. That is honest about what the product
 * can do today, keeps the card's layout and focus order stable, and lets each
 * later ticket remove one `disabled` rather than redesign the card.
 *
 * Archive is disabled even though `AssetService.archiveAsset` already works:
 * ATL-036 owns the undo affordance and the copy explaining that archiving in
 * Atlas is not deletion from the service, and shipping the action without them
 * would let someone archive with no way back and no explanation.
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

/** The four §6 actions, each with the ticket that will enable it. */
const CARD_ACTIONS: {
  key: string;
  label: string;
  enabledBy?: string;
  href?: (id: string) => string;
}[] = [
  { key: "view", label: "View details", enabledBy: "ATL-034" },
  { key: "edit", label: "Edit", href: (id: string) => `/assets/${id}/edit` },
  { key: "archive", label: "Archive", enabledBy: "ATL-036" },
  { key: "request", label: "Request deletion", enabledBy: "ATL-056" },
];

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
function AssetActions({ assetId, serviceName }: { assetId: string; serviceName: string }) {
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
        {CARD_ACTIONS.map((action) =>
          action.href ? (
            // Enabled: its ticket has landed.
            <DropdownMenuItem key={action.key} asChild data-action={action.key}>
              <Link href={action.href(assetId)}>{action.label}</Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem key={action.key} disabled data-action={action.key}>
              {action.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface AssetCardProps {
  asset: AssetSummary;
  /** Compact rows are the optional list view (§6 "compact list optional"). */
  compact?: boolean;
}

export function AssetCard({ asset, compact = false }: AssetCardProps) {
  const presentation = STATUS_PRESENTATION[asset.status];
  const categoryLabel = CATEGORY_LABELS.get(asset.category) ?? asset.category;

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
        <AssetActions assetId={asset.id} serviceName={asset.serviceName} />
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
      </CardContent>
    </Card>
  );
}
