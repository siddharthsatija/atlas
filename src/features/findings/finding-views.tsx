import Link from "next/link";
import { cn } from "@/lib/utils";
import { FINDING_VIEWS, findingViewHref, type FindingViewId } from "@/lib/findings/finding-views";
import { FindingCard, type FindingSummary } from "./finding-card";
import {
  FindingsAllEmptyState,
  FindingsDismissedEmptyState,
  FindingsFirstRunEmptyState,
  FindingsRecommendedEmptyState,
  FindingsResolvedEmptyState,
} from "./finding-empty-states";

/**
 * The Insights view switcher and list (ATL-040, frontend §8).
 *
 * ## Links, not tabs
 *
 * Radix `Tabs` exists in the design system, but it is a client component whose
 * panels are all rendered at once. These four views are four different reads —
 * Recommended is a different service call from the rest — so switching view is a
 * navigation, and it is modelled as one: plain links, state in the URL, no
 * client JavaScript. Back and forward work, a view can be shared, and the page
 * stays a Server Component.
 *
 * That also means no `role="tablist"`. Announcing links as tabs would promise
 * arrow-key semantics that links do not have. This is a navigation landmark with
 * `aria-current="page"` on the active link, which is what it actually is.
 */

export interface FindingViewsProps {
  view: FindingViewId;
  findings: readonly FindingSummary[];
  /**
   * True when the user has no assets recorded at all.
   *
   * Distinguishes "Atlas has nothing of yours to examine" from "Atlas examined
   * your records and raised nothing", which are different situations needing
   * different words. Only the route can tell them apart, so it is passed in
   * rather than inferred from an empty list.
   */
  hasNoAssets: boolean;
  /** Builds the ATL-041 panel URL for one finding, or undefined to omit it. */
  detailHref?: (findingId: string) => string;
}

/** The empty state each view falls back to, once first run is ruled out. */
const EMPTY_STATES: Record<FindingViewId, () => React.JSX.Element> = {
  recommended: FindingsRecommendedEmptyState,
  all: FindingsAllEmptyState,
  resolved: FindingsResolvedEmptyState,
  dismissed: FindingsDismissedEmptyState,
};

export function FindingViewNav({ view }: { view: FindingViewId }) {
  return (
    <nav aria-label="Finding views">
      {/*
        `flex-wrap` because four tabs do not fit at 320px.

        Measured: the four labels plus their `px-3` padding total roughly 383px,
        against 288px of content width once the page container's `px-4` is taken
        off — the last tab's right edge landed at 399 and pushed the whole
        document into a horizontal scrollbar.

        Wrapping rather than `overflow-x-auto`: a scroll strip hides navigation
        behind a gesture and puts the fourth view out of sight at the width where
        the user can least afford to hunt for it. Wrapping keeps all four
        visible, keyboard order unchanged, and each link's accessible name
        untouched. Frontend §21 supports 320px, and the accessibility checklist
        treats reflow as the expected response to a narrow viewport.

        `items-center` still applies per row, so a wrapped row aligns the same
        way the single row does.
      */}
      <ul className="flex flex-wrap items-center gap-1 border-b border-border-default">
        {FINDING_VIEWS.map((entry) => {
          const isActive = entry.id === view;
          return (
            <li key={entry.id}>
              <Link
                href={findingViewHref(entry.id)}
                data-view={entry.id}
                // The active view is announced, not merely coloured — the same
                // requirement the design system puts on badges.
                {...(isActive ? { "aria-current": "page" as const } : {})}
                className={cn(
                  "-mb-px inline-block border-b-2 border-transparent px-3 py-2",
                  "text-body-sm font-medium text-text-secondary hover:text-text-primary",
                  "transition-colors duration-[--duration-standard]",
                  "focus-visible:outline-focus focus-visible:outline-2 focus-visible:outline-offset-2",
                  isActive && "border-accent font-semibold text-text-primary",
                )}
              >
                {entry.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function FindingList({ view, findings, hasNoAssets, detailHref }: FindingViewsProps) {
  if (findings.length === 0) {
    /**
     * First run wins over the per-view state: someone with no services recorded
     * needs to know why the page is empty, and "nothing needs your attention"
     * would be a claim Atlas has not earned.
     */
    if (hasNoAssets) return <FindingsFirstRunEmptyState />;

    const Empty = EMPTY_STATES[view];
    return <Empty />;
  }

  return (
    <ul data-slot="finding-list" className="flex flex-col gap-4">
      {findings.map((finding) => (
        <li key={finding.id}>
          <FindingCard
            finding={finding}
            {...(detailHref ? { detailHref: detailHref(finding.id) } : {})}
          />
        </li>
      ))}
    </ul>
  );
}
