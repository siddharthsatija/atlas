import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRIMARY_NAV_ITEMS } from "@/config/navigation";
import { Sidebar } from "./sidebar";

/**
 * ATL-006 — sidebar collapse control.
 *
 * Covers the acceptance criteria assertable at component level: control position,
 * both states, persistence call, preserved selection, tooltips when collapsed,
 * and the accessible name announcing state. Actual pixel widths at each viewport
 * are a Playwright concern; the width classes are asserted here as the closest
 * available proxy.
 */

const mockPathname = vi.hoisted(() => ({ value: "/assets" }));

vi.mock("next/navigation", () => ({ usePathname: () => mockPathname.value }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

/**
 * Rendered bare on purpose: the sidebar supplies its own tooltip provider, so it
 * must not depend on an ancestor a caller might forget.
 */
function renderSidebar(props: React.ComponentProps<typeof Sidebar> = {}) {
  return render(<Sidebar {...props} />);
}

const control = () => screen.getByRole("button", { name: /sidebar/i });
const nav = () => screen.getByRole("navigation", { name: "Primary" });

/**
 * The sidebar container.
 *
 * Width and collapse state belong to the whole column — the wordmark and profile
 * shrink with it too — so they live here rather than on the `navigation`
 * landmark, which wraps the destination lists alone.
 */
const sidebar = () => screen.getByTestId("sidebar");

beforeEach(() => {
  mockPathname.value = "/assets";
});

describe("collapse control placement", () => {
  it.each([false, true])(
    "follows the wordmark and precedes every destination (collapsed=%s)",
    async (defaultCollapsed) => {
      const user = userEvent.setup();
      renderSidebar({ defaultCollapsed });

      /**
       * §3 puts the wordmark first and the control second, and forbids the
       * bottom. Tab order is the assertion that matters rather than styling:
       * it is what keyboard and screen-reader users actually traverse, and CSS
       * could place a late element visually near the top while still leaving
       * those users to reach it last.
       */
      await user.tab();
      expect(screen.getByRole("link", { name: /go to Overview/i })).toHaveFocus();

      await user.tab();
      expect(control()).toHaveFocus();

      await user.tab();
      expect(screen.getByRole("link", { name: "Overview" })).toHaveFocus();
    },
  );
});

describe("accessible name and state", () => {
  it("announces the action and the current state when expanded", () => {
    renderSidebar({ defaultCollapsed: false });
    // Named for what pressing it does; aria-expanded carries the state.
    expect(control()).toHaveAccessibleName("Collapse sidebar");
    expect(control()).toHaveAttribute("aria-expanded", "true");
  });

  it("announces the action and the current state when collapsed", () => {
    renderSidebar({ defaultCollapsed: true });
    expect(control()).toHaveAccessibleName("Expand sidebar");
    expect(control()).toHaveAttribute("aria-expanded", "false");
  });

  it("points at the navigation it controls", () => {
    renderSidebar();
    expect(control()).toHaveAttribute("aria-controls", nav().id);
    expect(nav().id).toBeTruthy();
  });

  it("updates its name and state when toggled", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(control());
    expect(control()).toHaveAccessibleName("Expand sidebar");
    expect(control()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("keyboard operation", () => {
  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("toggles with %s", async (_label, key) => {
    const user = userEvent.setup();
    renderSidebar();

    control().focus();
    await user.keyboard(key);

    expect(control()).toHaveAccessibleName("Expand sidebar");
    // Focus stays on the control, so a keyboard user is not thrown out of the
    // sidebar by operating it.
    expect(control()).toHaveFocus();
  });
});

describe("expanded and collapsed layout", () => {
  it("renders the rail width when collapsed and the full width when expanded", async () => {
    const user = userEvent.setup();
    renderSidebar();

    // §3: expanded 240–264px (w-64 = 256), rail 72–80px (w-20 = 80).
    expect(sidebar()).toHaveClass("lg:w-64");
    expect(sidebar()).not.toHaveAttribute("data-collapsed");

    await user.click(control());

    expect(sidebar()).toHaveClass("w-20");
    expect(sidebar()).not.toHaveClass("lg:w-64");
    expect(sidebar()).toHaveAttribute("data-collapsed", "true");
  });

  it("keeps every destination reachable when collapsed", () => {
    renderSidebar({ defaultCollapsed: true });
    // The labels stay in the accessibility tree — only visually hidden — so a
    // screen-reader user loses nothing by collapsing.
    for (const item of PRIMARY_NAV_ITEMS) {
      expect(screen.getByRole("link", { name: item.label })).toBeInTheDocument();
    }
  });
});

describe("selected state", () => {
  it("preserves the active destination across a collapse and expand", async () => {
    const user = userEvent.setup();
    mockPathname.value = "/insights";
    renderSidebar();

    const activeLink = () => screen.getByRole("link", { name: "Privacy Insights" });
    expect(activeLink()).toHaveAttribute("aria-current", "page");

    await user.click(control());
    expect(activeLink()).toHaveAttribute("aria-current", "page");

    await user.click(control());
    expect(activeLink()).toHaveAttribute("aria-current", "page");
  });

  it("marks exactly one destination as current", () => {
    mockPathname.value = "/assets";
    renderSidebar({ defaultCollapsed: true });

    const current = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Digital Assets");
  });
});

describe("tooltips for icon-only navigation", () => {
  it("shows a tooltip on keyboard focus when collapsed", async () => {
    const user = userEvent.setup();
    renderSidebar({ defaultCollapsed: true });

    await user.tab(); // wordmark
    await user.tab(); // collapse control
    await user.tab(); // first destination

    // Focus, not just hover — a keyboard user must reach the label too.
    await waitFor(() => {
      expect(screen.getAllByRole("tooltip").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Overview").length).toBeGreaterThan(0);
  });

  it("shows a tooltip on hover when collapsed", async () => {
    const user = userEvent.setup();
    renderSidebar({ defaultCollapsed: true });

    await user.hover(screen.getByRole("link", { name: "Requests" }));
    await waitFor(() => {
      expect(screen.getAllByRole("tooltip").length).toBeGreaterThan(0);
    });
  });

  it("labels the tablet icon rail, where the label is hidden but the sidebar is expanded", async () => {
    // ATL-007 resolved this gap. Between `sm` and `lg` the rail hides labels
    // visually while `collapsed` is false, so those icons need a tooltip too —
    // an earlier version attached tooltips only when collapsed and left tablet
    // users with unlabelled icons.
    const user = userEvent.setup();
    renderSidebar({ defaultCollapsed: false });

    await user.hover(screen.getByRole("link", { name: "Requests" }));

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Requests");
    // Suppressed from `lg` upward, where the label is visible and a tooltip
    // repeating it would be noise. `lg:hidden` is `display: none`, so it leaves
    // the accessibility tree there rather than merely being invisible.
    expect(tooltip).toHaveClass("lg:hidden");
  });

  it("keeps the collapsed tooltip at every width", async () => {
    const user = userEvent.setup();
    renderSidebar({ defaultCollapsed: true });

    await user.hover(screen.getByRole("link", { name: "Requests" }));

    // Collapsed forces the rail at all widths, so the tooltip is never suppressed.
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).not.toHaveClass("lg:hidden");
  });
});

describe("persistence", () => {
  it("persists the new preference on toggle", async () => {
    const user = userEvent.setup();
    const onCollapsedChange = vi.fn();
    renderSidebar({ onCollapsedChange });

    await user.click(control());
    await waitFor(() => expect(onCollapsedChange).toHaveBeenCalledWith(true));

    await user.click(control());
    await waitFor(() => expect(onCollapsedChange).toHaveBeenLastCalledWith(false));
    expect(onCollapsedChange).toHaveBeenCalledTimes(2);
  });

  it("starts from the server-resolved preference", () => {
    // No client-side restore, so there is no expanded-then-collapsed flash.
    renderSidebar({ defaultCollapsed: true });
    expect(sidebar()).toHaveAttribute("data-collapsed", "true");
    expect(control()).toHaveAccessibleName("Expand sidebar");
  });

  it("remains fully operable when no persistence handler is supplied", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(control());
    expect(sidebar()).toHaveAttribute("data-collapsed", "true");
  });

  it("does not block the interaction on a slow write", async () => {
    const user = userEvent.setup();
    // A pending Server Action must not delay the layout change.
    const onCollapsedChange = vi.fn(() => new Promise<void>(() => {}));
    renderSidebar({ onCollapsedChange });

    await user.click(control());
    expect(sidebar()).toHaveAttribute("data-collapsed", "true");
  });
});

describe("accessibility", () => {
  it.each([false, true])("has no violations with collapsed=%s", async (defaultCollapsed) => {
    const { container } = renderSidebar({ defaultCollapsed });
    expect(await axe(container)).toHaveNoViolations();
  });
});
