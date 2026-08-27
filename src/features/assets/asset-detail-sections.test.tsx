import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AssetDetailSections, type AssetDetailSectionsProps } from "./asset-detail-sections";

/**
 * ATL-034 M2 — the asset detail sections.
 *
 * ## What jsdom can and cannot show, established by probe rather than assumed
 *
 * Executed before these were written, against a bare `<details>`:
 *
 *   - `<details>` maps to `role="group"`, and `.open` reflects the attribute. ✅
 *   - Clicking the summary toggles `.open`. ✅
 *   - Content inside a collapsed section is in the DOM but **not visible**, so
 *     `toBeVisible` tracks the disclosure state. ✅
 *   - **Tab does not move focus to `<summary>`**, and **Enter does not toggle
 *     it**. ❌ Neither is implemented in jsdom.
 *
 * A correction worth recording: an earlier probe concluded collapsed content was
 * indistinguishable from visible content, because it asked whether the text was
 * *queryable* rather than whether it was *visible*. It is queryable and not
 * visible, which is why the tests below open a section before asserting its
 * contents are shown — and why they can assert that expanding reveals them.
 *
 * What remains browser-only is keyboard activation. A unit test that pressed
 * Enter and passed would be asserting jsdom's silence, not the product's
 * behaviour, and one that clicked and called the result "keyboard operable"
 * would be claiming something it never checked. That is M5's.
 *
 * `role="group"` is itself load-bearing: it is how the native element announces
 * itself, so its presence is evidence that these are real `<details>` rather
 * than a hand-rolled accordion.
 */

/** Frontend §7, sections 2–8. Section 1 is the always-visible identity header. */
const SECTION_ORDER = [
  "Overview",
  "Information held",
  "Permissions",
  "Findings",
  "Requests",
  "Activity",
  "Notes",
];

const OVERVIEW = 0;
const INFORMATION = 1;
const PERMISSIONS = 2;
const FINDINGS = 3;
const REQUESTS = 4;
const NOTES = 6;

const asset: AssetDetailSectionsProps["asset"] = {
  serviceDomain: "example.test",
  category: "finance",
  status: "active",
  sourceType: "manual",
  sourceLabel: "Added from my password manager",
  confidence: "high",
  lastVerifiedAt: "2026-03-14T00:00:00.000Z",
  createdAt: "2026-01-05T00:00:00.000Z",
  notes: "Closed the marketing opt-in.",
};

const props = (overrides: Partial<AssetDetailSectionsProps> = {}): AssetDetailSectionsProps => ({
  asset,
  categories: [],
  permissions: [],
  findings: [],
  events: [],
  ...overrides,
});

const sections = () => screen.getAllByRole("group");

/**
 * Expands a collapsed section and returns it, for callers to scope with `within`.
 *
 * Contents are asserted *after* expanding rather than while collapsed, because
 * collapsed content is present but not visible — so asserting visibility from
 * the collapsed state would fail on markup that is entirely correct, and
 * asserting mere presence would pass on a section that never opens.
 *
 * Returns the element rather than a bound query object so `within` stays at the
 * call site, where `testing-library/prefer-screen-queries` can see it. Hidden
 * behind this helper, the rule reads the result as a `render` return and objects
 * — correctly, since it cannot tell the two apart.
 */
async function expand(index: number, name: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("heading", { level: 2, name }));

  const section = sections()[index] as HTMLDetailsElement;
  expect(section.open).toBe(true);

  return section;
}

describe("the section contract", () => {
  it("renders sections 2 to 8 in frontend §7 order", () => {
    render(<AssetDetailSections {...props()} />);

    /**
     * Headings in DOM order. The order is a published contract, not a layout
     * preference: M8 turns Requests real in place, and anything that reorders
     * the list moves it out from under the E2E selectors and the focus order.
     */
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(
      SECTION_ORDER,
    );
  });

  it("opens Overview and collapses everything after it", () => {
    render(<AssetDetailSections {...props()} />);

    /**
     * Read in the same DOM order as the headings above, so the two assertions
     * together pin each heading to its own initial state.
     */
    expect(sections().map((s) => (s as HTMLDetailsElement).open)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("uses one initial state, with nothing measuring the viewport", () => {
    /**
     * Rendered twice with identical props. If the initial state consulted a
     * breakpoint, a media query or a hydration-time hook, the two renders could
     * differ — which is the hydration mismatch this model exists to prevent.
     */
    const view = render(<AssetDetailSections {...props()} />);
    const firstFlags = sections().map((s) => (s as HTMLDetailsElement).open);
    view.unmount();

    render(<AssetDetailSections {...props()} />);

    expect(sections().map((s) => (s as HTMLDetailsElement).open)).toEqual(firstFlags);
  });

  it("uses native disclosure elements rather than a custom accordion", () => {
    render(<AssetDetailSections {...props()} />);

    /** Seven `role="group"` elements: only `<details>` maps to that here. */
    expect(sections()).toHaveLength(SECTION_ORDER.length);
  });

  it("toggles a collapsed section when its heading is activated", async () => {
    const user = userEvent.setup();
    render(<AssetDetailSections {...props()} />);

    const permissions = sections()[PERMISSIONS] as HTMLDetailsElement;
    expect(permissions.open).toBe(false);

    /**
     * Pointer activation, which is what jsdom implements. Keyboard activation is
     * the browser's own and is asserted in M5 — see the module note.
     */
    await user.click(screen.getByRole("heading", { level: 2, name: "Permissions" }));

    expect(permissions.open).toBe(true);
  });
});

describe("source and last verified, only where the record has them", () => {
  it("shows the asset's source, confidence and verified date", () => {
    render(<AssetDetailSections {...props()} />);
    const overview = within(sections()[OVERVIEW] as HTMLElement);

    /** `digital_assets` carries all three, so all three appear. */
    expect(overview.getByText("Source")).toBeVisible();
    expect(overview.getByText("Source detail")).toBeVisible();
    expect(overview.getByText("Confidence")).toBeVisible();
    expect(overview.getByText("2026-03-14")).toBeVisible();
  });

  it("omits the asset's source detail when the user gave none", () => {
    render(<AssetDetailSections {...props({ asset: { ...asset, sourceLabel: null } })} />);
    const overview = within(sections()[OVERVIEW] as HTMLElement);

    /** Absent, not "Unknown source" — the column is genuinely empty. */
    expect(overview.queryByText("Source detail")).toBeNull();
  });

  it("says Never rather than leaving the verified date blank", () => {
    render(<AssetDetailSections {...props({ asset: { ...asset, lastVerifiedAt: null } })} />);
    const overview = within(sections()[OVERVIEW] as HTMLElement);

    /**
     * A stated fact, not missing data: it is what R-001 keys on, and a blank
     * would read as a rendering gap.
     */
    expect(overview.getByText("Never")).toBeVisible();
  });

  it("shows a data category's source and confidence but never a verified date", async () => {
    render(
      <AssetDetailSections
        {...props({
          categories: [
            {
              id: "category-1",
              category: "financial",
              sensitivity: "high",
              description: null,
              source: "Bank statement",
              confidence: "medium",
            },
          ],
        })}
      />,
    );
    const information = within(await expand(INFORMATION, "Information held"));

    expect(information.getByText("Source")).toBeVisible();
    expect(information.getByText("Confidence")).toBeVisible();

    /**
     * `asset_data_categories` has no `last_verified_at` column. Borrowing the
     * parent asset's date would tell the user Atlas confirmed *this category* on
     * a day it had only confirmed the service.
     */
    expect(information.queryByText("Last verified")).toBeNull();
  });

  it("omits a data category's source when the row has none", async () => {
    render(
      <AssetDetailSections
        {...props({
          categories: [
            {
              id: "category-1",
              category: "financial",
              sensitivity: "standard",
              description: null,
              source: null,
              confidence: "low",
            },
          ],
        })}
      />,
    );
    const information = within(await expand(INFORMATION, "Information held"));

    expect(information.queryByText("Source")).toBeNull();
    expect(information.getByText("Confidence")).toBeVisible();
  });

  it("shows a permission's verified date but never a source or confidence", async () => {
    render(
      <AssetDetailSections
        {...props({
          permissions: [
            {
              id: "permission-1",
              permissionType: "data_sharing",
              scope: "broad",
              status: "active",
              lastVerifiedAt: "2026-02-01T00:00:00.000Z",
            },
          ],
        })}
      />,
    );
    const permissions = within(await expand(PERMISSIONS, "Permissions"));

    expect(permissions.getByText("Last verified")).toBeVisible();
    expect(permissions.getByText("2026-02-01")).toBeVisible();

    /** `asset_permissions` has neither column — the mirror image of above. */
    expect(permissions.queryByText("Source")).toBeNull();
    expect(permissions.queryByText("Confidence")).toBeNull();
  });

  it("omits a permission's verified date when it has never been checked", () => {
    render(
      <AssetDetailSections
        {...props({
          permissions: [
            {
              id: "permission-1",
              permissionType: "marketing",
              scope: "limited",
              status: "active",
              lastVerifiedAt: null,
            },
          ],
        })}
      />,
    );
    const permissions = within(sections()[PERMISSIONS] as HTMLElement);

    expect(permissions.queryByText("Last verified")).toBeNull();
  });
});

describe("the findings section", () => {
  it("says no *open* findings, never that there were none", async () => {
    render(<AssetDetailSections {...props()} />);
    const findings = within(await expand(FINDINGS, "Findings"));

    /**
     * The exact copy, asserted exactly. `listFindingsForAsset` is open-only, so
     * a user who resolved three findings on this service still sees this — and
     * "No findings" would tell them the work they did never happened.
     */
    expect(findings.getByText("No open findings for this service.")).toBeVisible();
    expect(findings.queryByText("No findings")).toBeNull();
  });

  it("lists the open findings it was given", async () => {
    render(
      <AssetDetailSections
        {...props({
          findings: [
            {
              id: "finding-1",
              title: "Broad permission granted",
              severity: "high",
              status: "open",
            },
            {
              id: "finding-2",
              title: "Not reviewed recently",
              severity: "medium",
              status: "in_progress",
            },
          ],
        })}
      />,
    );
    const findings = within(await expand(FINDINGS, "Findings"));

    expect(findings.getByRole("link", { name: "Broad permission granted" })).toHaveAttribute(
      "href",
      "/insights?finding=finding-1",
    );

    /** `in_progress` is live exposure and is labelled, not hidden. */
    expect(findings.getByText("In progress")).toBeVisible();
    expect(findings.queryByText("No open findings for this service.")).toBeNull();
  });
});

describe("the requests section", () => {
  it("is present in position 6", () => {
    render(<AssetDetailSections {...props()} />);

    expect(screen.getAllByRole("heading", { level: 2 })[REQUESTS]).toHaveTextContent("Requests");
  });

  it("says none has been prepared, and claims nothing more", async () => {
    /**
     * The copy changed in ATL-058: requests exist now, so "Atlas cannot make
     * data requests yet" stopped being true. What is still empty is the *list* —
     * ATL-064/ATL-065 own that — so the section says none has been prepared and
     * points at the control that prepares one.
     */
    render(<AssetDetailSections {...props()} />);
    const requests = within(await expand(REQUESTS, "Requests"));

    expect(requests.getByText(/No requests have been prepared/i)).toBeVisible();

    /**
     * The wording this section must never drift into, and the reason is
     * unchanged by ATL-058: Atlas drafts and never sends (security §11, frontend
     * §9). Each of these would tell the user something happened that did not.
     */
    const text = (sections()[REQUESTS] as HTMLElement).textContent ?? "";
    expect(text).not.toMatch(/\b(sent by Atlas|submitted|pending|in progress|awaiting)\b/i);
  });

  it("renders no request records, because none can exist", () => {
    render(<AssetDetailSections {...props()} />);
    const requests = within(sections()[REQUESTS] as HTMLElement);

    expect(requests.queryAllByRole("listitem")).toHaveLength(0);
    expect(requests.queryAllByRole("link")).toHaveLength(0);
  });
});

describe("the notes section", () => {
  it("renders the user's own text", async () => {
    render(<AssetDetailSections {...props()} />);
    const notes = within(await expand(NOTES, "Notes"));

    expect(notes.getByText("Closed the marketing opt-in.")).toBeVisible();
  });

  it("says so plainly when there are none", async () => {
    render(<AssetDetailSections {...props({ asset: { ...asset, notes: null } })} />);
    const notes = within(await expand(NOTES, "Notes"));

    expect(notes.getByText("No notes for this service.")).toBeVisible();
  });
});
