import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AssetCard, type AssetSummary } from "./asset-card";
import { AssetsFilteredEmptyState, AssetsFirstRunEmptyState } from "./asset-empty-states";

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
  compact?: boolean;
  nextCursor: string | null;
  /** The current query as a query string, so paging keeps the filters. */
  queryString: string;
}

export function AssetList({
  assets,
  isFirstRun,
  compact = false,
  nextCursor,
  queryString,
}: AssetListProps) {
  if (assets.length === 0) {
    /**
     * Which empty state depends on *why* it is empty, and the two must not be
     * confused: telling someone whose filter matched nothing that they have no
     * services would read as data loss.
     */
    return isFirstRun ? <AssetsFirstRunEmptyState /> : <AssetsFilteredEmptyState />;
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
        className={compact ? "flex flex-col gap-2" : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3"}
      >
        {assets.map((asset) => (
          <li key={asset.id}>
            <AssetCard asset={asset} compact={compact} />
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
