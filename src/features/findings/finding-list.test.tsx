import { configure, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FindingCard, type FindingSummary } from "./finding-card";
import { FindingList, FindingViewNav } from "./finding-views";
import {
  FindingsAllEmptyState,
  FindingsDismissedEmptyState,
  FindingsFirstRunEmptyState,
  FindingsRecommendedEmptyState,
  FindingsResolvedEmptyState,
} from "./finding-empty-states";

/**
 * Lets `getByTestId` address the `data-slot` attributes the design system
 * already sets.
 *
 * Three assertions in this file target elements with no role and no accessible
 * name — a `Card`, a provenance line, an empty-state title — which no other
 * Testing Library query can reach. They previously used `container.querySelector`
 * and failed `testing-library/no-container` and `no-node-access`.
 *
 * Pointing `testIdAttribute` at `data-slot` reaches exactly the same elements by
 * the same selectors, through a supported query. Test-only: no production
 * attribute is added, and the default is restored below so no other suite sees
 * this configuration.
 */
configure({ testIdAttribute: "data-slot" });

afterAll(() => {
  configure({ testIdAttribute: "data-testid" });
});
import { FINDING_VIEWS } from "@/lib/findings/finding-views";

/**
 * ATL-040 — the Insights surfaces.
 *
 * The ticket names three things to test here: view filtering, axe, and
 * empty-state copy assertions. Ordering is asserted in
 * `src/lib/findings/recommendation.test.ts` and against the service in
 * `finding-service.integration.test.ts`, which is where the sort actually runs —
 * re-asserting it through a component would only prove the list renders what it
 * was handed.
 */

// next/link renders an anchor; the real component needs a router context.
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const finding = (overrides: Partial<FindingSummary> = {}): FindingSummary => ({
  id: "11111111-1111-4111-8111-111111111111",
  findingType: "hygiene",
  title: "Spotify has not been reviewed in over a year",
  description: "You last confirmed what this account holds on 3 March 2025.",
  severity: "medium",
  confidence: "high",
  sourceType: "engine",
  sourceReference: "R-001@rules-v1",
  evidenceSummary: "Last reviewed 512 days ago.",
  recommendedAction: "Open the service and confirm what it still holds.",
  impactedAsset: "Spotify",
  status: "open",
  ...overrides,
});

describe("the finding card", () => {
  it("shows all eight documented fields", () => {
    // Frontend §8: severity, title, explanation, evidence summary, source,
    // confidence, impacted asset, recommended action. A card missing one of
    // these is a finding the user cannot judge.
    render(<FindingCard finding={finding()} />);

    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Spotify has not been reviewed in over a year",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("You last confirmed what this account holds on 3 March 2025."),
    ).toBeInTheDocument();
    expect(screen.getByText("Last reviewed 512 days ago.")).toBeInTheDocument();
    expect(screen.getByText("Atlas rule R-001@rules-v1")).toBeInTheDocument();
    expect(screen.getByText("High confidence")).toBeInTheDocument();
    expect(screen.getByText("Spotify")).toBeInTheDocument();
    expect(
      screen.getByText("Open the service and confirm what it still holds."),
    ).toBeInTheDocument();
  });

  it("names the impacted asset rather than showing an id", () => {
    // The service resolves the name (ATL-040); a UUID tells a user nothing and
    // leaks an internal identifier into the UI.
    const { container } = render(<FindingCard finding={finding()} />);

    expect(container.textContent).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(screen.getByTestId("finding-impacted-asset")).toHaveTextContent("Spotify");
  });

  it("shows the footprint-wide label the service supplies, without special-casing it", () => {
    render(<FindingCard finding={finding({ impactedAsset: "Entire digital footprint" })} />);

    expect(screen.getByText("Entire digital footprint")).toBeInTheDocument();
  });

  it("never conveys severity by colour alone", () => {
    // The acceptance criterion, asserted as text: every severity must be
    // readable in greyscale and by a screen reader.
    for (const [severity, label] of [
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["critical", "Critical"],
    ] as const) {
      const { unmount } = render(<FindingCard finding={finding({ severity })} />);

      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText("Severity:")).toBeInTheDocument();
      unmount();
    }
  });

  it("applies no critical styling beyond the shared severity badge", () => {
    /**
     * Frontend §8 reserves critical styling for *verified* critical findings,
     * and nothing in the data model records verification (OQ-11). Until it
     * does, the card adds no emphasis of its own — this test is what stops one
     * being reintroduced by eye.
     */
    render(<FindingCard finding={finding({ severity: "critical" })} />);
    const card = screen.getByTestId("finding-card");

    expect(card).toHaveAttribute("data-severity", "critical");
    expect(card?.className).not.toContain("danger");
  });

  it("marks a demo finding as sample data", () => {
    // Demo records must be clearly marked wherever they render (§8, ATL-018).
    render(<FindingCard finding={finding({ sourceType: "demo" })} />);

    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(screen.getByText("Sample data")).toBeInTheDocument();
  });

  it("offers resolve, dismiss and Ask Atlas as visibly unavailable", () => {
    // Present, announced, and disabled: ATL-042, ATL-043 and ATL-053 own the
    // confirmation, the reason and the undo those actions require.
    render(<FindingCard finding={finding()} />);

    for (const label of ["Resolve", "Dismiss", "Ask Atlas"]) {
      const button = screen.getByRole("button", {
        name: `${label}: Spotify has not been reviewed in over a year`,
      });
      expect(button).toBeDisabled();
    }
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<FindingCard finding={finding({ severity: "critical" })} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("the view navigation", () => {
  it("links to the four documented views", () => {
    // Frontend §8 names exactly these, in this order.
    render(<FindingViewNav view="recommended" />);
    const nav = screen.getByRole("navigation", { name: "Finding views" });

    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Recommended", "All", "Resolved", "Dismissed"]);
  });

  it("announces the current view rather than only colouring it", () => {
    render(<FindingViewNav view="resolved" />);

    expect(screen.getByRole("link", { name: "Resolved" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "All" })).not.toHaveAttribute("aria-current");
  });

  it("points the default view at the bare route", () => {
    // So /insights and /insights?view=recommended are not two URLs for one page.
    render(<FindingViewNav view="all" />);

    expect(screen.getByRole("link", { name: "Recommended" })).toHaveAttribute("href", "/insights");
    expect(screen.getByRole("link", { name: "Resolved" })).toHaveAttribute(
      "href",
      "/insights?view=resolved",
    );
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<FindingViewNav view="recommended" />);

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("the list", () => {
  it("renders one card per finding, in the order given", () => {
    // The service has already sorted. The list must not reorder, or the page
    // would disagree with the order ATL-039 tested.
    render(
      <FindingList
        view="all"
        hasNoAssets={false}
        findings={[
          finding({ id: "a", title: "First" }),
          finding({ id: "b", title: "Second" }),
          finding({ id: "c", title: "Third" }),
        ]}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("has no accessibility violations with findings present", async () => {
    const { container } = render(
      <FindingList
        view="recommended"
        hasNoAssets={false}
        findings={[finding({ id: "a" }), finding({ id: "b", severity: "critical" })]}
      />,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("the empty states", () => {
  it("differs per view", () => {
    /**
     * The acceptance criterion. Four views, four situations — an empty
     * Dismissed list and an empty Recommended list mean opposite things, and
     * shared copy would tell at least one of those users something false.
     */
    const titles = new Set<string>();

    for (const view of FINDING_VIEWS) {
      const { unmount } = render(<FindingList view={view.id} hasNoAssets={false} findings={[]} />);
      const title = screen.getByTestId("empty-state-title").textContent ?? "";
      titles.add(title);
      unmount();
    }

    expect(titles.size).toBe(FINDING_VIEWS.length);
  });

  it("explains that findings come from the user's own records, never a scan", () => {
    // CLAUDE.md forbids implying Atlas scans anything. The states that could be
    // read as "we looked and found nothing" must say where findings come from.
    for (const Empty of [
      FindingsFirstRunEmptyState,
      FindingsRecommendedEmptyState,
      FindingsAllEmptyState,
    ]) {
      const { container, unmount } = render(<Empty />);

      expect(container.textContent).toContain("services you have recorded");
      expect(container.textContent).toContain("does not scan the internet");
      unmount();
    }
  });

  it("tells a user with no services why the page is empty", () => {
    // First run wins over the per-view copy: "nothing needs your attention" to
    // someone Atlas has never had data for would be a claim it has not earned.
    render(<FindingList view="recommended" hasNoAssets findings={[]} />);

    expect(screen.getByText("No findings yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a service" })).toHaveAttribute("href", "/assets");
  });

  it("congratulates a cleared list without claiming Atlas scanned anything", () => {
    render(<FindingList view="recommended" hasNoAssets={false} findings={[]} />);

    expect(screen.getByText("Nothing needs your attention")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See all findings" })).toHaveAttribute(
      "href",
      "/insights?view=all",
    );
  });

  it("states that dismissal does not improve the score", () => {
    // ADR-004 keeps the deduction until the condition clears, and ATL-043's
    // criterion is that the UI explains this honestly. Saying it on the empty
    // list means nobody learns it only after dismissing something.
    const { container } = render(<FindingsDismissedEmptyState />);

    expect(container.textContent).toContain("does not improve your privacy score");
  });

  it("describes Resolved as a record of what was dealt with", () => {
    const { container } = render(<FindingsResolvedEmptyState />);

    expect(container.textContent).toContain("Nothing resolved yet");
    expect(container.textContent).not.toContain("does not scan");
  });

  it("has no accessibility violations in any view", async () => {
    for (const view of FINDING_VIEWS) {
      const { container, unmount } = render(
        <FindingList view={view.id} hasNoAssets={false} findings={[]} />,
      );

      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
