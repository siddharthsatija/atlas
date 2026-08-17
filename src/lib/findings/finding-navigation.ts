import type { FindingType } from "./findings";

/**
 * Where a finding's recommended action sends the user (ATL-041).
 *
 * ## Derived from the finding's semantics, not declared per rule
 *
 * ADR-001's rules describe *what was found*; they say nothing about where the
 * UI goes, and they should not start to. A `Rule` carries `id`, `type`,
 * `recommendedAction` and a predicate — adding a URL to each of the seven would
 * duplicate routing into rule metadata, so that the next route change had to be
 * applied in seven places instead of one.
 *
 * So the destination comes from §11.1's four finding categories, which are
 * already documented vocabulary, plus the finding's own `asset_id`. Adding a
 * fifth category or moving a route means changing this file and nothing else.
 *
 * ## Requests have nowhere to go yet
 *
 * The `requests` category is R-007's, and M8 has not been built. Rather than
 * invent a route or quietly drop the link, the destination is reported as
 * unavailable and the surface renders it present-but-disabled — the ATL-005 and
 * ATL-031 precedent. The control exists, is announced, and is visibly
 * unavailable, which is honest about what the product can do today.
 *
 * Nothing here reads or writes anything. Pure mapping over two values.
 */

export type FindingDestination =
  | {
      available: true;
      href: string;
      /** What the user is told the link does. Never a bare URL. */
      label: string;
    }
  | {
      available: false;
      /** Why it cannot be followed, in words a user could read. */
      label: string;
      unavailableReason: string;
    };

/**
 * The section of the asset surface each category is about.
 *
 * `hygiene` is about the asset record itself — R-001 is "you have not reviewed
 * this" — so it lands on the detail page. `exposure` and `permissions` are
 * about the child lists, which are only editable on the edit page, so they land
 * there. Fragments are deliberately absent: the edit page's sections carry no
 * anchors today, and adding them is a product change this ticket has no reason
 * to make. The link label names the section instead.
 */
const SECTION_LABELS: Record<FindingType, string> = {
  hygiene: "Open this service",
  exposure: "Review what this service holds",
  permissions: "Review this service's permissions",
  requests: "Start a deletion request",
};

/**
 * Resolves the destination for one finding.
 *
 * @param findingType §11.1's category, stored on the finding.
 * @param assetId     The impacted asset, or null for a footprint-wide finding.
 */
export function findingDestination(
  findingType: string,
  assetId: string | null,
): FindingDestination {
  if (findingType === "requests") {
    return {
      available: false,
      label: SECTION_LABELS.requests,
      unavailableReason: "Requests are not part of Atlas yet.",
    };
  }

  /**
   * A footprint-wide finding (R-008) names no asset, so there is no single
   * service to open. The list is the honest destination — it is what the
   * finding is actually about.
   */
  if (assetId === null) {
    return { available: true, href: "/assets", label: "Review your services" };
  }

  if (findingType === "hygiene") {
    return { available: true, href: `/assets/${assetId}`, label: SECTION_LABELS.hygiene };
  }

  if (findingType === "exposure" || findingType === "permissions") {
    return {
      available: true,
      href: `/assets/${assetId}/edit`,
      label: SECTION_LABELS[findingType],
    };
  }

  /**
   * An unrecognised category. `finding_type` is a text column whose vocabulary
   * lives in the application (§7.2), so a row can carry a value this build does
   * not know — and sending the user somewhere guessed would be worse than
   * sending them to the service the finding is about.
   */
  return { available: true, href: `/assets/${assetId}`, label: "Open this service" };
}
