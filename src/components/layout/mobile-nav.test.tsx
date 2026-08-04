import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOOTER_NAV_ITEMS, PRIMARY_NAV_ITEMS } from "@/config/navigation";
import { MobileNav } from "./mobile-nav";

/**
 * ATL-007 — mobile navigation drawer.
 *
 * Covers the keyboard and pointer interactions the ticket names, plus axe in both
 * open and closed states. Viewport-dependent visibility (`sm:hidden`) is a CSS
 * concern verified in Playwright; the class is asserted here as the proxy.
 */

const mockPathname = vi.hoisted(() => ({ value: "/overview" }));

vi.mock("next/navigation", () => ({ usePathname: () => mockPathname.value }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const trigger = () => screen.getByRole("button", { name: "Open navigation menu" });
const drawer = () => screen.getByRole("dialog", { name: "Navigation" });

/** Everything focusable inside the drawer, in DOM order. */
const drawerFocusables = () => [
  ...within(drawer()).getAllByRole("link"),
  ...within(drawer()).getAllByRole("button"),
];

/**
 * True when focus is on something inside the drawer.
 *
 * Uses `:focus` on elements found by role rather than reading
 * `document.activeElement`: it asserts the same fact without reaching into the
 * DOM, and it fails loudly if focus escapes to the document body.
 */
const focusIsInsideDrawer = () => drawerFocusables().some((element) => element.matches(":focus"));

beforeEach(() => {
  mockPathname.value = "/overview";
});

async function openDrawer() {
  const user = userEvent.setup();
  render(<MobileNav />);
  await user.click(trigger());
  await screen.findByRole("dialog", { name: "Navigation" });
  return user;
}

describe("trigger", () => {
  it("has an accessible name describing what it opens", () => {
    render(<MobileNav />);
    expect(trigger()).toHaveAccessibleName("Open navigation menu");
  });

  it("is hidden from the small breakpoint upward, where the rail takes over", () => {
    render(<MobileNav />);
    // §2: tablet uses an icon rail, mobile uses a drawer. CSS rather than a JS
    // breakpoint check, so there is no hydration mismatch or flash.
    expect(trigger()).toHaveClass("sm:hidden");
  });

  it("meets the minimum target size", () => {
    render(<MobileNav />);
    expect(trigger()).toHaveClass("size-11"); // 44px (frontend §20)
  });

  it("renders no dialog until opened", () => {
    render(<MobileNav />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("opening", () => {
  it("opens on click", async () => {
    await openDrawer();
    expect(drawer()).toBeInTheDocument();
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("opens with %s from the keyboard", async (_label, key) => {
    const user = userEvent.setup();
    render(<MobileNav />);

    await user.tab();
    expect(trigger()).toHaveFocus();
    await user.keyboard(key);

    expect(await screen.findByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
  });

  it("moves focus into the drawer", async () => {
    await openDrawer();
    await waitFor(() => {
      expect(focusIsInsideDrawer()).toBe(true);
    });
  });

  it("renders a drawer, not a compressed rail", async () => {
    // §3 is explicit that mobile must not get a rail. Every label is visible
    // text inside the drawer — nothing is icon-only here.
    await openDrawer();
    for (const item of PRIMARY_NAV_ITEMS) {
      expect(within(drawer()).getByRole("link", { name: item.label })).toBeVisible();
    }
  });
});

describe("destinations", () => {
  it("offers every primary destination and Settings", async () => {
    await openDrawer();
    for (const item of [...PRIMARY_NAV_ITEMS, ...FOOTER_NAV_ITEMS]) {
      expect(within(drawer()).getByRole("link", { name: item.label })).toHaveAttribute(
        "href",
        item.href,
      );
    }
  });

  it("preserves the active destination", async () => {
    mockPathname.value = "/insights";
    await openDrawer();

    expect(within(drawer()).getByRole("link", { name: "Privacy Insights" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks exactly one destination as current", async () => {
    mockPathname.value = "/assets";
    await openDrawer();

    const current = within(drawer())
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Digital Assets");
  });

  it("treats a nested route as within its section", async () => {
    mockPathname.value = "/assets/some-record";
    await openDrawer();
    expect(within(drawer()).getByRole("link", { name: "Digital Assets" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

describe("dismissal", () => {
  it("closes on Escape and returns focus to the trigger", async () => {
    const user = await openDrawer();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Focus return matters most here: without it a keyboard user lands at the
    // top of the document and has to traverse the page again.
    expect(trigger()).toHaveFocus();
  });

  it("closes when the page behind is pressed", async () => {
    const user = userEvent.setup();
    render(
      <>
        <div data-testid="page-behind">Page content</div>
        <MobileNav />
      </>,
    );
    await user.click(trigger());
    await screen.findByRole("dialog");

    /**
     * Dismissal by pressing outside — which on this layout means the scrim,
     * since it covers the page.
     *
     * Driven with `fireEvent` rather than `userEvent`: while the drawer is open
     * the body carries `pointer-events: none`, and `userEvent` refuses to click
     * through it (correctly — a real user could not either). The events are
     * dispatched on a real element node because Radix's dismiss handler resolves
     * the press target against the layer, and `document.body` is not a target it
     * acts on.
     */
    const outside = screen.getByTestId("page-behind");
    fireEvent.pointerDown(outside);
    fireEvent.mouseDown(outside);
    fireEvent.click(outside);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes via the explicit close control and returns focus", async () => {
    const user = await openDrawer();

    await user.click(within(drawer()).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();
  });
});

describe("route change", () => {
  it("closes when the route changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MobileNav />);

    await user.click(trigger());
    expect(await screen.findByRole("dialog", { name: "Navigation" })).toBeInTheDocument();

    // Simulates the navigation a link click triggers, including back/forward.
    mockPathname.value = "/requests";
    rerender(<MobileNav />);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("stays open when the route has not changed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MobileNav />);

    await user.click(trigger());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // A re-render for any other reason must not dismiss the drawer.
    rerender(<MobileNav />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("background interaction", () => {
  it("traps focus inside the drawer", async () => {
    const user = await openDrawer();

    const focusableCount = drawerFocusables().length;
    expect(focusableCount).toBeGreaterThan(2);

    // Tab past the last focusable: focus must wrap back inside, never escape to
    // the document. Escaped focus would leave every drawer element unfocused.
    for (let i = 0; i < focusableCount + 2; i += 1) {
      await user.tab();
      expect(focusIsInsideDrawer()).toBe(true);
    }
  });

  it("removes the background from the accessibility tree while open", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Behind the drawer</button>
        <MobileNav />
      </>,
    );

    expect(screen.getByRole("button", { name: "Behind the drawer" })).toBeInTheDocument();

    await user.click(trigger());
    await screen.findByRole("dialog");

    // Radix marks outside content `aria-hidden`, so a screen-reader user cannot
    // wander out of the drawer into a page they cannot see or operate. Queried
    // by role, which respects aria-hidden — the element is still in the DOM.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Behind the drawer" })).not.toBeInTheDocument();
    });
  });

  it("blocks pointer interaction with the page behind", async () => {
    await openDrawer();
    await waitFor(() => {
      expect(document.body).toHaveStyle({ pointerEvents: "none" });
    });
  });
});

describe("accessibility", () => {
  it("has no violations when closed", async () => {
    const { container } = render(<MobileNav />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations when open", async () => {
    await openDrawer();
    // The drawer is portalled, so the whole document is the subject. `region` is
    // a page-level rule that no portalled component can satisfy standalone.
    expect(
      await axe(document.body, { rules: { region: { enabled: false } } }),
    ).toHaveNoViolations();
  });
});
