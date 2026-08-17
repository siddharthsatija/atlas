import { describe, expect, it } from "vitest";
import {
  DEFAULT_FINDING_VIEW,
  FINDING_VIEWS,
  findingView,
  findingViewHref,
  parseFindingView,
} from "./finding-views";

/**
 * ATL-040 — the view vocabulary the route, the navigation and the empty states
 * all read. The ticket's "view filter tests" start here, because a view that
 * parsed differently from how it rendered would show one label over another
 * view's data.
 */

describe("the documented views", () => {
  it("are the four in frontend §8, in that order", () => {
    expect(FINDING_VIEWS.map((view) => view.label)).toEqual([
      "Recommended",
      "All",
      "Resolved",
      "Dismissed",
    ]);
  });

  it("maps only the two views that are status filters", () => {
    /**
     * Recommended is not a status: it is `calculateRecommendations`, which
     * excludes finished findings rather than selecting one status. All filters
     * nothing. Encoding either as a status would quietly change what the page
     * shows.
     */
    expect(Object.fromEntries(FINDING_VIEWS.map((v) => [v.id, v.status]))).toEqual({
      recommended: null,
      all: null,
      resolved: "resolved",
      dismissed: "dismissed",
    });
  });

  it("opens on Recommended", () => {
    expect(DEFAULT_FINDING_VIEW).toBe("recommended");
  });
});

describe("parsing the view from a URL", () => {
  it("accepts every documented view", () => {
    for (const view of FINDING_VIEWS) {
      expect(parseFindingView(view.id)).toBe(view.id);
    }
  });

  it("falls back to the default for anything else", () => {
    // A query string is user input. A typo should not produce an error page for
    // a read-only list.
    expect(parseFindingView(undefined)).toBe("recommended");
    expect(parseFindingView("")).toBe("recommended");
    expect(parseFindingView("resolved!")).toBe("recommended");
    expect(parseFindingView("__proto__")).toBe("recommended");
  });
});

describe("links", () => {
  it("gives the default view the bare route", () => {
    // Otherwise /insights and /insights?view=recommended are two URLs for one
    // page, and the nav would fail to mark either as current.
    expect(findingViewHref("recommended")).toBe("/insights");
  });

  it("names every other view in the query string", () => {
    expect(findingViewHref("all")).toBe("/insights?view=all");
    expect(findingViewHref("resolved")).toBe("/insights?view=resolved");
    expect(findingViewHref("dismissed")).toBe("/insights?view=dismissed");
  });

  it("round-trips through the parser", () => {
    for (const view of FINDING_VIEWS) {
      const href = findingViewHref(view.id);
      const parsed = parseFindingView(
        new URL(href, "https://x").searchParams.get("view") ?? undefined,
      );

      expect(parsed).toBe(view.id);
    }
  });
});

describe("looking a view up", () => {
  it("returns the matching definition", () => {
    expect(findingView("dismissed")).toEqual({
      id: "dismissed",
      label: "Dismissed",
      status: "dismissed",
    });
  });
});
