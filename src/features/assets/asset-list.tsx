import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AssetCard, type AssetSummary } from "./asset-card";
import {
  AssetsFilteredEmptyState,
  AssetsFirstRunEmptyState,
  AssetsNoActiveEmptyState,
} from "./asset-empty-states";
import type { AssetActionFormState } from "./asset-action-form";

/**
 * The results region of the asset list (ATL-031, frontend §6).
 *
 * Card grid by default, compact list optional — the two views §6 names. The view
 * choice travels in the URL like every other bit of list state, so it survives a
 * reload and can be linked.
 */

export interface AssetListProps {
  assets: AssetSummary[];
  /** True when the user has no assets at all, as opposed to none matching. */
  isFirstRun: boolean;
  /**
   * True when this read hid archived assets (ATL-036).
   *
   * Distinct from `isFirstRun`: an empty default list may mean "nothing yet" or
   * "everything is archived", and the copy must not assert either.
   */
  excludedArchived?: boolean;
  compact?: boolean;
  nextCursor: string | null;
  /** The current query as a query string, so paging keeps the filters. */
  queryString: string;
  /**
   * Passed straight through to every card (ATL-036 M5).
   *
   * The list owns no state of its own here — it is the only path from the route
   * to the card, and a feature component cannot import from `app/`.
   */
  archive: (state: AssetActionFormState, formData: FormData) => Promise<AssetActionFormState>;
  restore: (state: AssetActionFormState, formData: FormData) => Promise<AssetActionFormState>;
}

export function AssetList({
  assets,
  isFirstRun,
  excludedArchived = false,
  compact = false,
  nextCursor,
  queryString,
  archive,
  restore,
}: AssetListProps) {
  if (assets.length === 0) {
    /**
     * Which empty state depends on *why* it is empty, and the three must not be
     * confused: telling someone whose filter matched nothing that they have no
     * services would read as data loss, and so would telling someone whose
     * services are all archived.
     *
     * Order matters. A user who filtered *and* got nothing gets the filtered
     * state even on a read that also hid archived rows, because the filter is
     * the thing they can act on.
     */
    if (!isFirstRun) return <AssetsFilteredEmptyState />;

    return excludedArchived ? <AssetsNoActiveEmptyState /> : <AssetsFirstRunEmptyState />;
  }

  const nextHref = nextCursor
    ? `/assets?${new URLSearchParams(queryString).toString().replace(/(^|&)cursor=[^&]*/, "")}&cursor=${encodeURIComponent(nextCursor)}`.replace(
        "?&",
        "?",
      )
    : null;

  return (
    <div className="flex flex-col gap-6">
      {/*
        A list, not a bare stack of divs. Assistive technology announces the
        count, which is the one piece of context a card grid otherwise loses —
        "list, 12 items" tells a screen-reader user what a sighted user sees at a
        glance.
      */}
      <ul
        data-slot="asset-list"
        data-view={compact ? "compact" : "grid"}
        /*
          `grid-cols-1` is load-bearing below `sm`, despite looking redundant.

          Without it no `grid-template-columns` is declared at that width, so the
          implicit column is sized `auto` — which resolves to the items'
          max-content width. A card whose content did not fit 320px therefore
          widened the track past the container and scrolled the page sideways;
          measured at 320px, the track was 319.172px inside a 288px list.

          `grid-cols-1` compiles to `repeat(1, minmax(0, 1fr))`, and the
          `minmax(0, …)` is the part that matters: it lets the track shrink below
          max-content. `grid-cols-2` and `grid-cols-3` already carry it, which is
          why the overflow only ever appeared under `sm`.
        */
        className={
          compact ? "flex flex-col gap-2" : "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        }
      >
        {assets.map((asset) => (
          <li key={asset.id}>
            <AssetCard asset={asset} compact={compact} archive={archive} restore={restore} />
          </li>
        ))}
      </ul>

      {nextHref && (
        <div className="flex justify-center">
          {/*
            A link rather than a button: paging is navigation, so it belongs in
            history and works without JavaScript. Keyset means "next" is always
            correct even if the collection changed since this page rendered.
          */}
          <Button variant="secondary" asChild>
            <Link href={nextHref}>Show more</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
