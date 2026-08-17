import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FindingDetail, type FindingDetailView } from "./finding-detail";
import { FindingCard, type FindingSummary } from "./finding-card";

/**
 * Lets `getByTestId` address the `data-slot` attributes this panel already
 * sets, exactly as `finding-list.test.tsx` does.
 *
 * The panel labels its provenance rows with `data-slot` and nothing else — no
 * role, no accessible name — so `baseElement.querySelector` was the only way
 * to reach them, and it failed `testing-library/no-node-access`. Reading the
 * same attribute through a supported query keeps every assertion identical.
 *
 * Test-only, and the default is restored below so no other suite inherits it.
 */
configure({ testIdAttribute: "data-slot" });

afterAll(() => {
  configure({ testIdAttribute: "data-testid" });
});

/**
 * ATL-041 — the finding detail panel.
 *
 * The panel is a drawer whose open state is the URL, so what is asserted here
 * is what it *renders* and what closing *navigates to*. That the URL then
 * changes — and that Back, Forward and a refresh behave — is asserted in the
 * browser, in `tests/e2e/insights.spec.ts`, because only a real history stack
 * can show it.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const ASSET = "22222222-2222-4222-8222-222222222222";

const finding = (overrides: Partial<FindingDetailView> = {}): FindingDetailView => ({
  id: "11111111-1111-4111-8111-111111111111",
  findingType: "hygiene",
  title: "Spotify has not been reviewed in over a year",
  description: "You last confirmed what this account holds on 3 March 2025.",
  severity: "medium",
  confidence: "high",
  status: "open",
  sourceType: "engine",
  sourceReference: "R-001@rules-v1",
  evidenceSummary: "Last reviewed 512 days ago.",
  recommendedAction: "Open the service and confirm what it still holds.",
  impactedAsset: "Spotify",
  assetId: ASSET,
  createdAt: "2026-06-01T09:30:00.000Z",
  evidenceRecords: [{ id: ASSET, kind: "asset", label: "Spotify", href: `/assets/${ASSET}` }],
  ...overrides,
});

const panel = (overrides: Partial<FindingDetailView> = {}) =>
  render(<FindingDetail finding={finding(overrides)} closeHref="/insights?view=all" />);

describe("the persisted fields", () => {
  it("renders every field the model actually stores", () => {
    // The drawer is portalled, so assertions that reach for nodes use
    // `baseElement`; `screen` already searches the whole document.
    panel();

    expect(screen.getByText("Spotify has not been reviewed in over a year")).toBeInTheDocument();
    expect(screen.getByText(/You last confirmed what this account holds/)).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.getByText("Account hygiene")).toBeInTheDocument();
    expect(screen.getByText("Last reviewed 512 days ago.")).toBeInTheDocument();
    expect(
      screen.getByText("Open the service and confirm what it still holds."),
    ).toBeInTheDocument();
  });

  it("shows the rule and version separately, parsed from source_reference", () => {
    // ADR-001: a finding cites rule id and rule version. Split, so a reader can
    // see which rule fired without decoding a compound string.
    panel();

    expect(screen.getByTestId("detail-rule")).toHaveTextContent("R-001");
    expect(screen.getByTestId("detail-rule-version")).toHaveTextContent("rules-v1");
  });

  it("shows the persisted overall confidence", () => {
    panel({ confidence: "low" });

    expect(screen.getByTestId("detail-confidence")).toHaveTextContent("Low");
  });

  it("names the impacted asset rather than an id", () => {
    const { baseElement } = panel();

    expect(screen.getByTestId("detail-impacted-asset")).toHaveTextContent("Spotify");
    expect(baseElement.textContent).not.toContain(ASSET);
  });

  it("marks a demo finding wherever it renders", () => {
    panel({ sourceType: "demo" });

    expect(screen.getByText("Demo")).toBeInTheDocument();
  });

  it("says so plainly when no rule produced the finding", () => {
    // §7.5 allows a demo-seeded finding with no rule behind it.
    panel({ sourceReference: null });

    expect(screen.getByTestId("detail-rule")).toHaveTextContent("Not produced by a rule");
  });
});

describe("unsupported provenance", () => {
  it("fabricates no evaluation timestamp", () => {
    /**
     * Nothing persists one. `updated_at` moves on any update including a status
     * change, so presenting it would read as an evaluation time and be wrong.
     */
    const { baseElement } = panel();

    expect(baseElement.textContent).not.toMatch(/last evaluated/i);
    expect(baseElement.textContent).not.toMatch(/last run/i);
  });

  it("states the limitation instead of leaving a silence", () => {
    panel();

    expect(screen.getByTestId("detail-limitation")).toHaveTextContent(/when a rule last ran/i);
  });
});

describe("evidence records", () => {
  it("links an asset record to the asset", () => {
    panel();

    expect(screen.getByRole("link", { name: "Spotify" })).toHaveAttribute(
      "href",
      `/assets/${ASSET}`,
    );
  });

  it("links a category or permission record to the owning asset's edit page", () => {
    // Neither has a route of its own; both are visible on the edit page.
    panel({
      evidenceRecords: [
        {
          id: "c1",
          kind: "dataCategory",
          label: "Information held: financial",
          href: `/assets/${ASSET}/edit`,
        },
        {
          id: "p1",
          kind: "permission",
          label: "Permission: data_sharing (broad)",
          href: `/assets/${ASSET}/edit`,
        },
      ],
    });

    const list = screen.getByTestId("detail-records");
    expect(within(list).getAllByRole("link")).toHaveLength(2);
  });

  it("keeps a record that no longer resolves, without a link", () => {
    /**
     * Dropping it would make the finding look better founded than it is, and
     * ADR-001's whole claim is explainability.
     */
    panel({
      evidenceRecords: [
        { id: "gone", kind: "asset", label: "A service that no longer exists", href: null },
      ],
    });

    expect(screen.getByText("A service that no longer exists")).toBeInTheDocument();
    expect(within(screen.getByTestId("detail-records")).queryAllByRole("link")).toHaveLength(0);
  });

  it("says so when no records were recorded", () => {
    panel({ evidenceRecords: [] });

    expect(screen.getByTestId("detail-no-records")).toBeInTheDocument();
  });
});

describe("the recommended-action destination", () => {
  it("links a hygiene finding to the service", () => {
    panel();

    expect(screen.getByTestId("detail-destination")).toHaveAttribute("href", `/assets/${ASSET}`);
  });

  it("links a permission finding to the edit page", () => {
    panel({ findingType: "permissions" });

    expect(screen.getByTestId("detail-destination")).toHaveAttribute(
      "href",
      `/assets/${ASSET}/edit`,
    );
  });

  it("renders a request destination present but visibly unavailable", () => {
    // M8 does not exist. Present, announced, disabled — never a broken link.
    const { baseElement } = panel({ findingType: "requests" });

    const control = screen.getByTestId("detail-destination-unavailable");
    expect(control).toBeDisabled();
    expect(screen.queryByTestId("detail-destination")).toBeNull();
    expect(baseElement.textContent).toContain("Requests are not part of Atlas yet.");
  });

  it("offers no link at all for a request, broken or otherwise", () => {
    panel({ findingType: "requests", evidenceRecords: [] });

    for (const link of screen.queryAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/request/i);
    }
  });
});

describe("actions the route supplies", () => {
  it("offers no Ask Atlas control unless the route supplies one", () => {
    /**
     * **Rewritten by ATL-053, which now owns and enables this control.**
     *
     * This assertion previously read "shows Ask Atlas as visibly unavailable"
     * and expected a disabled button. That was correct while the assistant did
     * not exist: the ATL-005 precedent is to render a deferred affordance
     * present-but-unavailable rather than hide it, so the user can see what is
     * coming.
     *
     * ATL-053 built the assistant, so the affordance is no longer deferred and
     * the precedent no longer applies. Ask Atlas now follows the *same* rule
     * resolve and dismiss follow — it belongs to the route that owns its server
     * action, and the panel renders it only when one is supplied. The contract
     * that changed is "deferred, therefore disabled" becoming "route-supplied,
     * therefore absent without a route"; what did not change is that the panel
     * stays renderable with no server boundary, which is why this test still
     * passes no assistant and still expects nothing.
     *
     * The enabled control is asserted in `finding-assistant.test.tsx` and in the
     * wired case below. The finding *card*'s Ask Atlas is untouched by this
     * ticket and remains deferred.
     */
    panel();

    expect(screen.queryByRole("button", { name: /^Ask Atlas/ })).not.toBeInTheDocument();
  });

  it("renders the assistant when the route supplies one", () => {
    /*
      Rendered directly rather than through `panel`, which takes finding
      overrides only. Widening that helper would touch every frozen test in this
      file for the sake of one case that needs a different prop.
    */
    render(
      <FindingDetail
        finding={finding()}
        closeHref="/insights?view=all"
        assistant={{ request: () => new Promise(() => {}) }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Ask Atlas: Spotify has not been reviewed in over a year",
      }),
    ).toBeEnabled();
  });

  it("offers no resolve or dismiss flow unless the route supplies one", () => {
    // The panel stays renderable without a server boundary; both actions belong
    // to the route that owns them.
    panel();

    expect(screen.queryByRole("button", { name: /^Resolve:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Dismiss:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Restore:/ })).not.toBeInTheDocument();
  });
});

describe("closing", () => {
  it("navigates back to the list URL rather than changing local state", async () => {
    // The panel is URL state; closing is therefore a navigation, and `push`
    // keeps Back able to reopen what was just closed.
    push.mockClear();
    panel();

    await userEvent.keyboard("{Escape}");

    expect(push).toHaveBeenCalledWith("/insights?view=all");
  });

  it("offers a close control that is reachable by keyboard", () => {
    panel();

    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("is a labelled dialog", () => {
    // Radix supplies the focus trap and focus return; the name is what makes
    // the panel identifiable when it opens.
    panel();

    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Spotify has not been reviewed in over a year",
    );
  });

  it("has no violations", async () => {
    const { baseElement } = panel();

    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it("has no violations with an unavailable destination", async () => {
    const { baseElement } = panel({ findingType: "requests" });

    expect(await axe(baseElement)).toHaveNoViolations();
  });
});

describe("the card's entry point", () => {
  const summary: FindingSummary = {
    id: "11111111-1111-4111-8111-111111111111",
    findingType: "hygiene",
    title: "Spotify has not been reviewed in over a year",
    description: "d",
    severity: "medium",
    confidence: "high",
    sourceType: "engine",
    sourceReference: "R-001@rules-v1",
    evidenceSummary: "e",
    recommendedAction: "a",
    impactedAsset: "Spotify",
    status: "open",
  };

  it("is a real link, so it can be opened in a new tab or shared", () => {
    render(<FindingCard finding={summary} detailHref="/insights?view=all&finding=abc" />);

    expect(screen.getByRole("link", { name: /View details: Spotify/ })).toHaveAttribute(
      "href",
      "/insights?view=all&finding=abc",
    );
  });

  it("is omitted when the route supplies no href, leaving ATL-040 untouched", () => {
    render(<FindingCard finding={summary} />);

    expect(screen.queryByRole("link", { name: /View details/ })).not.toBeInTheDocument();
  });
});

/**
 * RC-3 — focus returns to the card that opened the panel.
 *
 * Radix restores focus to its `Trigger`, and this drawer has none: it is URL
 * state, rendered `open` by the route. Radix's handler calls `preventDefault()`
 * and then focuses `triggerRef.current`, which is null — so `FocusScope`'s own
 * fallback is cancelled *and* nothing is focused, leaving `document.body`. A
 * browser run confirmed exactly that before the fix.
 *
 * The card and the panel are rendered together here so the originating link is
 * really in the document, which is what the restore looks for. A test that
 * rendered the panel alone could not tell a working restore from a no-op.
 */
describe("focus returns to the originating card", () => {
  const summary: FindingSummary = {
    id: "11111111-1111-4111-8111-111111111111",
    findingType: "hygiene",
    title: "Spotify has not been reviewed in over a year",
    description: "d",
    severity: "medium",
    confidence: "high",
    sourceType: "engine",
    sourceReference: "R-001@rules-v1",
    evidenceSummary: "e",
    recommendedAction: "a",
    impactedAsset: "Spotify",
    status: "open",
  };

  const card = <FindingCard finding={summary} detailHref="/insights?view=all&finding=abc" />;

  /**
   * Closes the panel the way the route does: by removing it.
   *
   * **Not by pressing Escape.** Escape calls `onOpenChange`, which calls
   * `router.push` — mocked to a no-op in this file — so `open` stays true and the
   * drawer never closes. Nothing would fire, and Radix's `aria-hidden` on the
   * outside world would even hide the card from `getByRole`. Pressing Escape
   * here would therefore test the mock, not the component.
   *
   * Unmounting is the real mechanism: `react-dialog` wires
   * `onUnmountAutoFocus: onCloseAutoFocus` (`dist/index.mjs:226`), and the route
   * removes `FindingDetail` when the `finding` parameter leaves the URL. So this
   * reproduces production rather than approximating it.
   */
  function openThenClose(findingId = summary.id) {
    const view = render(
      <>
        {card}
        <FindingDetail finding={finding({ id: findingId })} closeHref="/insights?view=all" />
      </>,
    );

    view.rerender(<>{card}</>);

    return view;
  }

  /**
   * `waitFor`, because Radix defers the restore by a macrotask.
   *
   * `react-focus-scope` dispatches its unmount-autofocus event inside a
   * `setTimeout` (`dist/index.mjs:94`), so focus has not moved yet when
   * `rerender` returns. This polls for the settled state rather than sleeping
   * for a guessed interval — there is no fixed delay anywhere in these tests.
   */
  const detailsLink = () => screen.getByRole("link", { name: /View details: Spotify/ });

  it("focuses the details link when the drawer closes", async () => {
    openThenClose();

    await waitFor(() => {
      expect(detailsLink()).toHaveFocus();
    });
  });

  it("does not leave focus on the body", async () => {
    openThenClose();

    await waitFor(() => {
      expect(detailsLink()).toHaveFocus();
    });

    /**
     * The precise regression. The assertion above would also fail if focus went
     * somewhere else entirely, so this names the outcome that actually happened
     * in the browser — `document.body` — and a future reader of a failure here
     * knows exactly what to look for.
     */
    expect(document.body).not.toHaveFocus();
  });

  it("restores nothing when the finding has no card in the current view", async () => {
    /**
     * A resolved finding deep-linked while Recommended is showing has no card to
     * return to. Focusing something arbitrary would be worse than leaving the
     * browser to its default, so the handler is a no-op — asserted so a later
     * "helpful" fallback cannot be added silently.
     *
     * Waits on the *same* settled state the positive cases wait on, so this is
     * not a race that would pass before the restore ever had a chance to run.
     */
    openThenClose("99999999-9999-4999-8999-999999999999");

    await waitFor(() => {
      expect(document.body).toHaveFocus();
    });

    expect(detailsLink()).not.toHaveFocus();
  });
});
