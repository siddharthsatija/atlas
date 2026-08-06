import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { AssetCard, type AssetSummary } from "./asset-card";
import { AssetFilters } from "./asset-filters";
import { AssetList } from "./asset-list";
import { AssetsFilteredEmptyState, AssetsFirstRunEmptyState } from "./asset-empty-states";
import { parseAssetQuery } from "@/lib/assets/asset-query";

/**
 * ATL-031 — the asset list surfaces.
 *
 * Covers the three things the ticket names as testable here: accessibility,
 * keyboard reachability of the card actions, and both empty states. Filter and
 * search behaviour is asserted against the service in
 * `src/server/assets/asset-service.integration.test.ts`, which is where the
 * query actually runs.
 */

// next/link renders an anchor; the real component needs a router context.
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const asset = (overrides: Partial<AssetSummary> = {}): AssetSummary => ({
  id: "11111111-1111-4111-8111-111111111111",
  serviceName: "Spotify",
  serviceDomain: "spotify.com",
  category: "entertainment",
  status: "active",
  sourceType: "manual",
  lastVerifiedAt: null,
  hasAccountIdentifier: false,
  ...overrides,
});

const query = (input: Record<string, unknown> = {}) => parseAssetQuery(input).query;

describe("the card", () => {
  it("shows the service, its domain, status, and category", () => {
    render(<AssetCard asset={asset()} />);

    expect(screen.getByRole("heading", { level: 3, name: "Spotify" })).toBeInTheDocument();
    expect(screen.getByText("spotify.com")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Entertainment")).toBeInTheDocument();
  });

  it("says an identifier is saved without revealing one", () => {
    /**
     * The card never receives the value — `AssetSummary` has no such field, and
     * neither does `DigitalAssetRecord`. Masked display and reveal are ATL-035.
     */
    const { container } = render(<AssetCard asset={asset({ hasAccountIdentifier: true })} />);

    expect(screen.getByText("Identifier saved")).toBeInTheDocument();
    expect(container.textContent).not.toContain("@");
  });

  it("labels demo records", () => {
    // Demo data must be clearly marked wherever it renders (§8, ATL-018).
    render(<AssetCard asset={asset({ sourceType: "demo" })} />);

    expect(screen.getByText("Demo")).toBeInTheDocument();
  });

  it("states plainly when an asset has never been reviewed", () => {
    // What R-001 and the last-reviewed filter key on. An em dash would read as
    // missing data rather than as a fact.
    render(<AssetCard asset={asset()} />);

    expect(screen.getByText("Never reviewed")).toBeInTheDocument();
  });

  it("renders a review date when there is one", () => {
    render(<AssetCard asset={asset({ lastVerifiedAt: "2026-03-14T00:00:00.000Z" })} />);

    expect(screen.getByText(/Reviewed 14 Mar 2026/)).toBeInTheDocument();
  });

  it.each(["inactive", "archived", "removed"] as const)("renders %s status", (status) => {
    render(<AssetCard asset={asset({ status })} />);

    expect(screen.getByText(new RegExp(status, "i"))).toBeInTheDocument();
  });
});

describe("card actions", () => {
  it("names the menu after its asset", () => {
    /**
     * Without the name, a screen-reader user moving between cards hears "More,
     * More, More" and cannot tell which asset each menu belongs to.
     */
    render(<AssetCard asset={asset()} />);

    expect(screen.getByRole("button", { name: "Actions for Spotify" })).toBeInTheDocument();
  });

  it("is reachable and openable by keyboard alone", async () => {
    // Frontend §19: every hover action needs a keyboard and touch equivalent.
    // There is no hover-only path here at all — the trigger is a real button.
    const user = userEvent.setup();
    render(<AssetCard asset={asset()} />);

    await user.tab();
    const trigger = screen.getByRole("button", { name: "Actions for Spotify" });
    expect(trigger).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("offers all four §6 actions", async () => {
    const user = userEvent.setup();
    render(<AssetCard asset={asset()} />);

    await user.click(screen.getByRole("button", { name: "Actions for Spotify" }));
    const menu = await screen.findByRole("menu");

    for (const label of ["View details", "Edit", "Archive", "Request deletion"]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
  });

  it("enables edit and leaves the rest disabled until their tickets land", async () => {
    /**
     * Edit works since ATL-033. The other three follow the ATL-005 top-bar
     * precedent: present, announced, visibly unavailable.
     *
     * Archive stays disabled even though `AssetService.archiveAsset` works —
     * ATL-036 owns the undo affordance and the "this is not deletion from the
     * service" copy, and shipping the action without them would let someone
     * archive with no way back.
     */
    const user = userEvent.setup();
    render(<AssetCard asset={asset()} />);

    await user.click(screen.getByRole("button", { name: "Actions for Spotify" }));
    const menu = await screen.findByRole("menu");

    expect(within(menu).getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "href",
      `/assets/${asset().id}/edit`,
    );

    for (const label of ["View details", "Archive", "Request deletion"]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
  });
});

describe("the list", () => {
  it("announces how many services there are", () => {
    // A card grid otherwise loses the count that a sighted user gets at a glance.
    render(
      <AssetList
        assets={[
          asset(),
          asset({ id: "22222222-2222-4222-8222-222222222222", serviceName: "Monzo" }),
        ]}
        isFirstRun={false}
        nextCursor={null}
        queryString=""
      />,
    );

    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("switches to the compact view", () => {
    render(
      <AssetList assets={[asset()]} isFirstRun={false} compact nextCursor={null} queryString="" />,
    );

    expect(screen.getByRole("list")).toHaveAttribute("data-view", "compact");
  });

  it("offers more only when there is a next page", () => {
    const { rerender } = render(
      <AssetList assets={[asset()]} isFirstRun={false} nextCursor={null} queryString="" />,
    );
    expect(screen.queryByRole("link", { name: "Show more" })).not.toBeInTheDocument();

    rerender(
      <AssetList
        assets={[asset()]}
        isFirstRun={false}
        nextCursor="abc"
        queryString="status=active"
      />,
    );
    expect(screen.getByRole("link", { name: "Show more" })).toBeInTheDocument();
  });

  it("keeps the filters when paging", () => {
    // Losing them would silently widen the result set on page two.
    render(
      <AssetList
        assets={[asset()]}
        isFirstRun={false}
        nextCursor="abc"
        queryString="status=active&category=social"
      />,
    );

    const href = screen.getByRole("link", { name: "Show more" }).getAttribute("href") ?? "";
    expect(href).toContain("status=active");
    expect(href).toContain("category=social");
    expect(href).toContain("cursor=abc");
  });
});

describe("empty states", () => {
  it("explains what an asset is, and that Atlas does not scan", () => {
    /**
     * The honesty rule: an empty list must not read as "we looked and found
     * nothing". Atlas does not scan the internet, and the user is the source.
     */
    render(<AssetsFirstRunEmptyState />);

    expect(screen.getByText(/does not scan the internet/i)).toBeInTheDocument();
  });

  it("offers adding a first service and using sample data", () => {
    /**
     * Frontend §6's offers. Adding is a working link since ATL-032 built the
     * flow; sample data stays disabled because ATL-018 owns the demo dataset and
     * the data does not exist yet.
     */
    render(<AssetsFirstRunEmptyState />);

    expect(screen.getByRole("link", { name: /Add your first service/i })).toHaveAttribute(
      "href",
      "/assets/new",
    );
    expect(screen.getByRole("button", { name: /Explore with sample data/i })).toBeDisabled();
  });

  it("uses different words when a filter matched nothing", () => {
    /**
     * Telling someone whose filter matched nothing that they have no services
     * would read as data loss — the two situations must not share copy.
     */
    render(<AssetsFilteredEmptyState />);

    expect(screen.getByText(/No services match those filters/i)).toBeInTheDocument();
    expect(screen.queryByText(/does not scan the internet/i)).not.toBeInTheDocument();
  });

  it("offers a way back to the unfiltered list", () => {
    render(<AssetsFilteredEmptyState />);

    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/assets");
  });

  it("shows the first-run state only when nothing is filtered", () => {
    const { rerender } = render(
      <AssetList assets={[]} isFirstRun nextCursor={null} queryString="" />,
    );
    expect(screen.getByText(/No services yet/i)).toBeInTheDocument();

    rerender(<AssetList assets={[]} isFirstRun={false} nextCursor={null} queryString="" />);
    expect(screen.getByText(/No services match those filters/i)).toBeInTheDocument();
  });
});

describe("filters", () => {
  it("is a plain GET form, so filter state is the URL", () => {
    /**
     * Frontend §6 requires URL-driven state. A GET form gives it for free, with
     * working back/forward and no client JavaScript.
     */
    render(<AssetFilters query={query()} />);
    const form = screen.getByRole("search");

    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/assets");
  });

  it("labels every control", () => {
    render(<AssetFilters query={query()} />);

    for (const label of ["Search", "Sort", "Category", "Status", "Source"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it("states what search covers, and what it does not", () => {
    render(<AssetFilters query={query()} />);

    expect(screen.getByText(/Notes and saved identifiers are never searched/i)).toBeInTheDocument();
  });

  it("reflects the active query", () => {
    render(<AssetFilters query={query({ search: "spotify", sort: "oldest" })} />);

    expect(screen.getByLabelText("Search")).toHaveValue("spotify");
    expect(screen.getByLabelText("Sort")).toHaveValue("oldest");
  });

  it("offers no risk filter, because findings do not exist yet", () => {
    // A control that changed nothing would be indistinguishable from one that
    // matched nothing.
    render(<AssetFilters query={query()} />);

    expect(screen.queryByLabelText(/risk/i)).not.toBeInTheDocument();
  });

  it("carries no cursor, so changing a filter starts from page one", () => {
    /**
     * Asserted against what the form would actually submit rather than against
     * the markup: carrying a stale cursor into a changed filter would open the
     * new result set partway down.
     */
    render(<AssetFilters query={query()} />);

    const form = screen.getByRole("search");
    // Narrowed rather than cast: being a real form is the property that makes
    // GET-based filter state work at all, so it is worth asserting.
    if (!(form instanceof HTMLFormElement)) throw new Error("the filters must be a form");

    const submitted = new FormData(form);

    expect(submitted.has("cursor")).toBe(false);
    expect([...submitted.keys()].sort()).toEqual(["search", "sort"]);
  });
});

describe("accessibility", () => {
  it.each([
    ["a card", <AssetCard key="card" asset={asset({ hasAccountIdentifier: true })} />],
    ["the filters", <AssetFilters key="filters" query={query()} />],
    ["the first-run empty state", <AssetsFirstRunEmptyState key="first-run" />],
    ["the filtered empty state", <AssetsFilteredEmptyState key="filtered" />],
    [
      "a populated list",
      <AssetList
        key="list"
        assets={[asset()]}
        isFirstRun={false}
        nextCursor="abc"
        queryString=""
      />,
    ],
  ])("has no violations: %s", async (_label, element) => {
    const { container } = render(element);

    expect(await axe(container)).toHaveNoViolations();
  });
});
