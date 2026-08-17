import type { FindingStatus } from "./findings";

/**
 * The four Insights views (ATL-040, frontend §8: Recommended, All, Resolved,
 * Dismissed).
 *
 * In `lib/` rather than in the page, for the reason `recommendation.ts` is:
 * the route parses the view from the URL, the navigation renders one link per
 * view, and the empty states key on it. Three places, one list — and a view
 * that existed in the nav but not the parser would render a tab that silently
 * showed something else.
 *
 * Pure and status-only. Which service call each view maps to is the route's
 * decision, because "Recommended" is not a status filter at all: it is
 * `calculateRecommendations`, which excludes finished findings rather than
 * selecting one status.
 */

export interface FindingViewDefinition {
  id: string;
  label: string;
  /**
   * The status `listFindings` should filter on, or `null` when the view is not
   * a status filter (Recommended, which is a service method, and All, which
   * filters nothing).
   */
  status: FindingStatus | null;
}

export const FINDING_VIEWS = [
  { id: "recommended", label: "Recommended", status: null },
  { id: "all", label: "All", status: null },
  { id: "resolved", label: "Resolved", status: "resolved" },
  { id: "dismissed", label: "Dismissed", status: "dismissed" },
] as const satisfies readonly FindingViewDefinition[];

export type FindingViewId = (typeof FINDING_VIEWS)[number]["id"];

/** The view shown when the URL says nothing — §8 lists Recommended first. */
export const DEFAULT_FINDING_VIEW: FindingViewId = "recommended";

/**
 * Resolves `?view=` to a known view.
 *
 * Anything unrecognised falls back to the default rather than erroring: a URL is
 * user input, and a typo in a query string should not produce an error page for
 * a read-only list.
 */
export function parseFindingView(value: string | undefined): FindingViewId {
  return FINDING_VIEWS.find((view) => view.id === value)?.id ?? DEFAULT_FINDING_VIEW;
}

/** The definition for a resolved view id. */
export function findingView(id: FindingViewId): FindingViewDefinition {
  const view = FINDING_VIEWS.find((entry) => entry.id === id);
  // Unreachable for a `FindingViewId`, but the lookup is total either way rather
  // than a non-null assertion the type system cannot check.
  return view ?? FINDING_VIEWS[0];
}

/** The href for a view, so the nav and every empty state agree on one shape. */
export function findingViewHref(id: FindingViewId): string {
  return id === DEFAULT_FINDING_VIEW ? "/insights" : `/insights?view=${id}`;
}
