import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { AssetCard, type AssetSummary } from "./asset-card";
import { AssetFilters } from "./asset-filters";
import { AssetList } from "./asset-list";
import { AssetsFilteredEmptyState, AssetsFirstRunEmptyState } from "./asset-empty-states";
import { parseAssetQuery } from "@/lib/assets/asset-query";
import { ARCHIVE_COPY } from "@/lib/assets/archive-copy";
import type { AssetActionFormState } from "./asset-action-form";

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

/**
 * The archive/restore doubles, in the shape the real Server Actions have.
 *
 * Two arguments rather than one, because several tests read `mock.calls[0][1]`
 * to check which asset id was submitted — a one-argument double makes that a
 * type error, and casting it away would hide a double that had stopped matching
 * the contract it stands for. The same pattern is used in
 * `asset-archive-toast.test.tsx` and `asset-detail-header.test.tsx`; one shape
 * across all three keeps a reader from having to learn three.
 */
type ActionMock = (
  previous: AssetActionFormState,
  formData: FormData,
) => Promise<AssetActionFormState>;

const succeeds = () =>
  vi.fn<ActionMock>((previous) =>
    Promise.resolve({ failure: null, attempt: previous.attempt + 1 }),
  );

const failsWith = (failure: NonNullable<AssetActionFormState["failure"]>) =>
  vi.fn<ActionMock>((previous) => Promise.resolve({ failure, attempt: previous.attempt + 1 }));

/**
 * The double's own type, not the contract it implements.
 *
 * Declaring the helper parameters as `ActionMock` would type the value the
 * helper hands back as a plain function, and `mock.calls` — which is how these
 * tests check *which asset id was submitted* — would stop type-checking. That
 * assertion is the point of several of them, so the mock type is what travels.
 */
type ActionDouble = ReturnType<typeof succeeds>;

/**
 * Renders one card with working transitions.
 *
 * `archive` and `restore` are required props since ATL-036 M5 — a card without
 * them would offer an Archive item that silently did nothing, which is the
 * failure ATL-112 exists to prevent — so every render in this file supplies
 * them, and this helper is how.
 */
function card({
  asset: record = asset(),
  compact = false,
  archive = succeeds(),
  restore = succeeds(),
}: {
  asset?: AssetSummary;
  compact?: boolean;
  archive?: ActionDouble;
  restore?: ActionDouble;
} = {}) {
  const view = render(
    <AssetCard asset={record} compact={compact} archive={archive} restore={restore} />,
  );

  return { ...view, archive, restore };
}

/** The same, for the list. The actions are pass-through props there. */
function list(props: Omit<React.ComponentProps<typeof AssetList>, "archive" | "restore">) {
  return render(<AssetList {...props} archive={succeeds()} restore={succeeds()} />);
}

describe("the card", () => {
  it("shows the service, its domain, status, and category", () => {
    card();

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
    const { container } = card({ asset: asset({ hasAccountIdentifier: true }) });

    expect(screen.getByText("Identifier saved")).toBeInTheDocument();
    expect(container.textContent).not.toContain("@");
  });

  it("labels demo records", () => {
    // Demo data must be clearly marked wherever it renders (§8, ATL-018).
    card({ asset: asset({ sourceType: "demo" }) });

    expect(screen.getByText("Demo")).toBeInTheDocument();
  });

  it("states plainly when an asset has never been reviewed", () => {
    // What R-001 and the last-reviewed filter key on. An em dash would read as
    // missing data rather than as a fact.
    card();

    expect(screen.getByText("Never reviewed")).toBeInTheDocument();
  });

  it("renders a review date when there is one", () => {
    card({ asset: asset({ lastVerifiedAt: "2026-03-14T00:00:00.000Z" }) });

    expect(screen.getByText(/Reviewed 14 Mar 2026/)).toBeInTheDocument();
  });

  it.each(["inactive", "archived", "removed"] as const)("renders %s status", (status) => {
    card({ asset: asset({ status }) });

    expect(screen.getByText(new RegExp(status, "i"))).toBeInTheDocument();
  });
});

describe("card actions", () => {
  const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Actions for Spotify" }));
    return screen.findByRole("menu");
  };

  it("names the menu after its asset", () => {
    /**
     * Without the name, a screen-reader user moving between cards hears "More,
     * More, More" and cannot tell which asset each menu belongs to.
     */
    card();

    expect(screen.getByRole("button", { name: "Actions for Spotify" })).toBeInTheDocument();
  });

  it("is reachable and openable by keyboard alone", async () => {
    // Frontend §19: every hover action needs a keyboard and touch equivalent.
    // There is no hover-only path here at all — the trigger is a real button.
    const user = userEvent.setup();
    card();

    await user.tab();
    const trigger = screen.getByRole("button", { name: "Actions for Spotify" });
    expect(trigger).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("offers all four §6 actions", async () => {
    const user = userEvent.setup();
    card();

    const menu = await openMenu(user);

    for (const label of ["View details", "Edit", "Archive", "Request deletion"]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
  });

  it("enables edit and archive, and leaves the rest disabled until their tickets land", async () => {
    /**
     * Edit works since ATL-033 and Archive since ATL-036. The remaining two
     * follow the ATL-005 top-bar precedent: present, announced, visibly
     * unavailable.
     *
     * ## Why Archive moved out of the disabled set
     *
     * It used to be disabled *even though* `AssetService.archiveAsset` worked,
     * because ATL-036 owned the undo affordance and the copy explaining that
     * archiving in Atlas is not deletion from the service. Both now exist, so
     * the reason for disabling it has gone. This assertion changed because the
     * product contract changed, not because it was inconvenient.
     *
     * `View details` stays disabled under #139 — an open defect rather than a
     * missing feature, and explicitly out of ATL-036's scope.
     */
    const user = userEvent.setup();
    card();

    const menu = await openMenu(user);

    expect(within(menu).getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "href",
      `/assets/${asset().id}/edit`,
    );

    /**
     * Live, asserted by what it is *not* — no `aria-disabled`. The old
     * assertion here was `type="submit"`, which encoded a mechanism a browser
     * probe proved unusable: Radix removes the menu's subtree during
     * activation, so a submit button inside it is disconnected before the
     * browser evaluates it and no submission is ever generated. The item now
     * dispatches from `onSelect`, and the tests that prove it *works* are in
     * "archiving from the card" below.
     */
    const archive = within(menu).getByRole("menuitem", { name: ARCHIVE_COPY.archive });
    expect(archive).not.toHaveAttribute("aria-disabled", "true");

    /**
     * Request deletion left this list in ATL-058, which built Step 1 of the
     * request flow. View details stays: the detail page has existed since
     * ATL-034, and what is missing is the card's route to it (#139).
     */
    expect(within(menu).getByRole("menuitem", { name: "View details" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps View details disabled, because #139 is not this ticket", async () => {
    /**
     * Asserted on its own so that enabling it by accident — while wiring
     * archive, say — fails here rather than passing quietly inside a loop about
     * something else. The detail page has existed since ATL-034; what is
     * missing is the card's route to it.
     */
    const user = userEvent.setup();
    card();

    const menu = await openMenu(user);
    const view = within(menu).getByRole("menuitem", { name: "View details" });

    expect(view).toHaveAttribute("aria-disabled", "true");
    expect(view).not.toHaveAttribute("href");
  });

  it("offers Request deletion, pointing at Step 1 of the request flow", async () => {
    /**
     * ATL-058. A link like Edit, because the review lives on its own route —
     * frontend §10 requires draft preservation, and a modal whose state vanishes
     * on refresh preserves nothing.
     */
    const user = userEvent.setup();
    card();

    const menu = await openMenu(user);
    const request = within(menu).getByRole("menuitem", { name: "Request deletion" });

    expect(request).toHaveAttribute("href", `/assets/${asset().id}/request`);
    expect(request).not.toHaveAttribute("aria-disabled", "true");
  });
});

/**
 * ATL-036 M5 — archive and restore from the list.
 *
 * ## The surface distinction these protect
 *
 * This card offers Archive and Restore and **no undo**. That is not an
 * oversight: a successful archive revalidates `/assets`, the default list
 * excludes archived services since M2, and the card therefore leaves the list
 * immediately — taking with it any toast it owned, which a probe confirmed
 * unmounts with its owner even while the provider and viewport stay mounted.
 *
 * So the undo affordance lives on the detail page, which does not move, and the
 * list gets the durable half instead: correct membership the moment the user
 * acts, a Restore control in the `Archived` filter view, and failures that stay
 * on screen. The absence of a toast is asserted below, because a later change
 * that quietly added one would be adding an affordance that cannot survive.
 */
describe("archiving from the card", () => {
  const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Actions for Spotify" }));
    return screen.findByRole("menu");
  };

  const archived = asset({ status: "archived" });

  it("offers Archive on an active service, and no Restore", async () => {
    const user = userEvent.setup();
    card();

    const menu = await openMenu(user);

    expect(within(menu).getByRole("menuitem", { name: ARCHIVE_COPY.archive })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: ARCHIVE_COPY.restore })).toBeNull();
  });

  it("offers Restore on an archived service, and no Archive", async () => {
    const user = userEvent.setup();
    card({ asset: archived });

    const menu = await openMenu(user);

    expect(within(menu).getByRole("menuitem", { name: ARCHIVE_COPY.restore })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: ARCHIVE_COPY.archive })).toBeNull();
  });

  it("archives the asset the card is for, and nothing else", async () => {
    const user = userEvent.setup();
    const { archive, restore } = card();

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: ARCHIVE_COPY.archive }));

    await waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
    const formData = archive.mock.calls[0]?.[1] as FormData;
    /**
     * The id, asserted rather than assumed. A list renders many of these, and a
     * card that posted a neighbour's id would archive the wrong service while
     * looking entirely correct.
     */
    expect(formData.get("assetId")).toBe(asset().id);
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores the asset the card is for, and nothing else", async () => {
    const user = userEvent.setup();
    const { archive, restore } = card({ asset: archived });

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: ARCHIVE_COPY.restore }));

    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    const formData = restore.mock.calls[0]?.[1] as FormData;
    expect(formData.get("assetId")).toBe(archived.id);
    expect(archive).not.toHaveBeenCalled();
  });

  it("keeps a failed archive visible in the card after the menu has closed", async () => {
    const user = userEvent.setup();
    card({ archive: failsWith("unavailable") });

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: ARCHIVE_COPY.archive }));

    /**
     * The menu is gone by the time the result arrives — Radix closes it on
     * select — so a message rendered inside it would never be read. This one is
     * in the card, and it is the shared vocabulary rather than a card-only
     * string, so it cannot drift from what the edit page says.
     */
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Something went wrong. Nothing was changed — please try again.",
    );
    expect(screen.queryByRole("menu")).toBeNull();
    expect(alert).toBeVisible();
  });

  it("keeps a failed restore visible in the card", async () => {
    const user = userEvent.setup();
    card({ asset: archived, restore: failsWith("not_found") });

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: ARCHIVE_COPY.restore }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This service is no longer available. Nothing was changed.",
    );
  });

  it("offers no toast and no undo on this surface", async () => {
    const user = userEvent.setup();
    card();

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole("menuitem", { name: ARCHIVE_COPY.archive }));

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    /**
     * Deliberate, and asserted so it stays deliberate. A toast owned by a card
     * that is about to leave the list cannot survive long enough to be used, so
     * offering one would be offering an undo that sometimes silently is not
     * there. The detail page is where undo lives.
     */
    expect(screen.queryByText(ARCHIVE_COPY.archivedTitle)).toBeNull();
    expect(screen.queryByRole("button", { name: ARCHIVE_COPY.undo })).toBeNull();
    expect(screen.queryByText(ARCHIVE_COPY.undoAltText)).toBeNull();
  });

  it.each(["inactive", "removed"] as const)(
    "offers neither transition on a %s service",
    async (status) => {
      /**
       * `archiveAsset` expects `active` and `restoreAsset` expects `archived`,
       * so on either of these both writes match no row. Present and disabled —
       * the card's existing pattern for a control with no capability behind it.
       */
      const user = userEvent.setup();
      card({ asset: asset({ status }) });

      const menu = await openMenu(user);

      expect(within(menu).getByRole("menuitem", { name: ARCHIVE_COPY.archive })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(within(menu).queryByRole("menuitem", { name: ARCHIVE_COPY.restore })).toBeNull();
    },
  );
});

describe("the list", () => {
  it("announces how many services there are", () => {
    // A card grid otherwise loses the count that a sighted user gets at a glance.
    list({
      assets: [
        asset(),
        asset({ id: "22222222-2222-4222-8222-222222222222", serviceName: "Monzo" }),
      ],
      isFirstRun: false,
      nextCursor: null,
      queryString: "",
    });

    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("switches to the compact view", () => {
    list({
      assets: [asset()],
      isFirstRun: false,
      compact: true,
      nextCursor: null,
      queryString: "",
    });

    expect(screen.getByRole("list")).toHaveAttribute("data-view", "compact");
  });

  it("offers more only when there is a next page", () => {
    const { rerender } = list({
      assets: [asset()],
      isFirstRun: false,
      nextCursor: null,
      queryString: "",
    });
    expect(screen.queryByRole("link", { name: "Show more" })).not.toBeInTheDocument();

    rerender(
      <AssetList
        assets={[asset()]}
        isFirstRun={false}
        nextCursor="abc"
        queryString="status=active"
        archive={succeeds()}
        restore={succeeds()}
      />,
    );
    expect(screen.getByRole("link", { name: "Show more" })).toBeInTheDocument();
  });

  it("keeps the filters when paging", () => {
    // Losing them would silently widen the result set on page two.
    list({
      assets: [asset()],
      isFirstRun: false,
      nextCursor: "abc",
      queryString: "status=active&category=social",
    });

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
    const { rerender } = list({
      assets: [],
      isFirstRun: true,
      nextCursor: null,
      queryString: "",
    });
    expect(screen.getByText(/No services yet/i)).toBeInTheDocument();

    rerender(
      <AssetList
        assets={[]}
        isFirstRun={false}
        nextCursor={null}
        queryString=""
        archive={succeeds()}
        restore={succeeds()}
      />,
    );
    expect(screen.getByText(/No services match those filters/i)).toBeInTheDocument();
  });

  /**
   * ATL-036 — the third empty state.
   *
   * An empty default list can mean "nothing yet" or "everything is archived",
   * and ATL-036 declined a second database read to tell them apart. So the copy
   * has to be true of both, and the two older states must not be reachable in
   * its place: "No services yet" would be false for an archiving user, and the
   * filtered state would be false for everyone, since nothing was filtered.
   */
  it("uses the no-active-services state when the read hid archived assets", () => {
    list({
      assets: [],
      isFirstRun: true,
      excludedArchived: true,
      nextCursor: null,
      queryString: "",
    });

    expect(screen.getByText("No active services to show.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add a service, or use the Archived status filter to view archived services.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No services yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No services match those filters/i)).not.toBeInTheDocument();
  });

  it("offers the archived filter as the way to reach archived services", () => {
    list({
      assets: [],
      isFirstRun: true,
      excludedArchived: true,
      nextCursor: null,
      queryString: "",
    });

    /** The durable path to a restore until ATL-071 builds the Archive page. */
    expect(screen.getByRole("link", { name: "View archived services" })).toHaveAttribute(
      "href",
      "/assets?status=archived",
    );
    expect(screen.getByRole("link", { name: "Add a service" })).toHaveAttribute(
      "href",
      "/assets/new",
    );
  });

  it("still prefers the filtered state when the user actually filtered", () => {
    /**
     * Ordering, asserted: a user who filtered and got nothing can act on the
     * filter, so that state wins even on a read that also hid archived rows.
     */
    list({
      assets: [],
      isFirstRun: false,
      excludedArchived: true,
      nextCursor: null,
      queryString: "category=finance",
    });

    expect(screen.getByText(/No services match those filters/i)).toBeInTheDocument();
    expect(screen.queryByText("No active services to show.")).not.toBeInTheDocument();
  });

  it("keeps the first-run state for a read that did not hide anything", () => {
    list({ assets: [], isFirstRun: true, nextCursor: null, queryString: "" });

    expect(screen.getByText(/No services yet/i)).toBeInTheDocument();
    expect(screen.queryByText("No active services to show.")).not.toBeInTheDocument();
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
    [
      "a card",
      <AssetCard
        key="card"
        asset={asset({ hasAccountIdentifier: true })}
        archive={succeeds()}
        restore={succeeds()}
      />,
    ],
    [
      "an archived card, which offers Restore",
      <AssetCard
        key="archived-card"
        asset={asset({ status: "archived" })}
        archive={succeeds()}
        restore={succeeds()}
      />,
    ],
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
        archive={succeeds()}
        restore={succeeds()}
      />,
    ],
  ])("has no violations: %s", async (_label, element) => {
    const { container } = render(element);

    expect(await axe(container)).toHaveNoViolations();
  });
});
