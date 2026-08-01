import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_ORDER } from "@/config/app";
import { FOOTER_NAV_ITEMS, PRIMARY_NAV_ITEMS, findActiveNavItem } from "@/config/navigation";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { AppShell } from "./app-shell";
import { PageContainer, PageDescription, PageHeader, PageTitle } from "./page-layout";

/**
 * ATL-005 — application shell.
 *
 * Covers the acceptance criteria that can be asserted at component level: sidebar
 * order (frontend §3), top-bar contents (§4), landmarks and heading hierarchy
 * (§20), and accessibility. Viewport-dependent layout and full keyboard traversal
 * are covered by the Playwright spec, which needs a real browser.
 */

const mockPathname = vi.hoisted(() => ({ value: "/overview" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname.value,
}));

// next/link renders an anchor; the real component needs a router context.
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  mockPathname.value = "/overview";
});

describe("Sidebar", () => {
  it("renders navigation in the order defined by frontend §3", () => {
    render(<Sidebar />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");

    // Wordmark first, then the six primary destinations, then Settings.
    expect(links[0]).toHaveAccessibleName(/Atlas/);
    expect(links.slice(1).map((l) => l.textContent)).toEqual([
      ...PRIMARY_NAV_ITEMS.map((i) => i.label),
      ...FOOTER_NAV_ITEMS.map((i) => i.label),
    ]);
  });

  it("derives its order from the single NAV_ORDER source", () => {
    const rendered = [...PRIMARY_NAV_ITEMS, ...FOOTER_NAV_ITEMS].map((i) => i.key);
    expect(rendered).toEqual([...NAV_ORDER]);
  });

  it("places Settings after the primary destinations", () => {
    expect(FOOTER_NAV_ITEMS.map((i) => i.key)).toEqual(["settings"]);
  });

  it("marks the current route with aria-current", () => {
    mockPathname.value = "/assets";
    render(<Sidebar />);
    expect(screen.getByRole("link", { name: "Digital Assets" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("keeps a nested route selected on its section", () => {
    mockPathname.value = "/assets/some-asset-id";
    render(<Sidebar />);
    expect(screen.getByRole("link", { name: "Digital Assets" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps labels in the accessibility tree when collapsed", () => {
    // Collapsed shows icons only; the text must remain for screen readers (§3).
    render(<Sidebar collapsed />);
    for (const item of PRIMARY_NAV_ITEMS) {
      expect(screen.getByRole("link", { name: item.label })).toBeInTheDocument();
    }
  });

  it("applies the widths required by §3, responsively", () => {
    // The sidebar root IS the navigation landmark, so it is reachable by role.
    // Rail (80px) by default, expanding to 256px from `lg` — §2 tablet uses the rail.
    const { unmount } = render(<Sidebar />);
    const responsive = screen.getByRole("navigation", { name: "Primary" });
    expect(responsive).toHaveClass("w-20");
    expect(responsive).toHaveClass("lg:w-64");
    unmount();

    // `collapsed` forces the rail at every width (the seam ATL-006 will drive).
    render(<Sidebar collapsed />);
    const forced = screen.getByRole("navigation", { name: "Primary" });
    expect(forced).toHaveClass("w-20");
    expect(forced).not.toHaveClass("lg:w-64");
  });

  it("renders exactly one navigation landmark", () => {
    // Duplicate landmarks sharing an accessible name fail axe `landmark-unique`.
    render(<Sidebar />);
    expect(screen.getAllByRole("navigation", { name: "Primary" })).toHaveLength(1);
  });

  it("shows no user data before sessions and profiles exist", () => {
    // ATL-012 / ATL-015 own this; inventing a name would be fake data.
    render(<Sidebar />);
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<Sidebar />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("TopBar", () => {
  it("contains the controls required by §4", () => {
    render(<TopBar />);
    for (const label of ["Search", "Notifications", "Ask Atlas"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("shows the current section label", () => {
    mockPathname.value = "/requests";
    render(<TopBar />);
    expect(screen.getByText("Requests")).toBeInTheDocument();
  });

  it("renders no heading, so each page keeps a single h1", () => {
    render(<TopBar />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("renders its triggers as unavailable until their tickets land", async () => {
    const user = userEvent.setup();
    render(<TopBar />);
    const search = screen.getByRole("button", { name: "Search" });

    expect(search).toBeDisabled();
    // A disabled control announces its state rather than silently doing nothing.
    await user.click(search);
    expect(search).toBeDisabled();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<TopBar />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("AppShell", () => {
  it("provides exactly one main landmark for the skip link", () => {
    render(
      <AppShell>
        <h1>Overview</h1>
      </AppShell>,
    );
    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]).toHaveAttribute("id", "main");
  });

  it("renders page content inside the main landmark", () => {
    render(
      <AppShell>
        <h1>Overview</h1>
      </AppShell>,
    );
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 })).toHaveTextContent(
      "Overview",
    );
  });

  it("exposes the banner and navigation landmarks", () => {
    render(
      <AppShell>
        <h1>Overview</h1>
      </AppShell>,
    );
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Primary" })).toHaveLength(1);
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <AppShell>
        <h1>Overview</h1>
      </AppShell>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  describe("composed with a real page body", () => {
    const Page = () => (
      <PageContainer>
        <PageHeader>
          <PageTitle>Overview</PageTitle>
          <PageDescription>Your privacy dashboard.</PageDescription>
        </PageHeader>
      </PageContainer>
    );

    it("exposes exactly one banner, main, and h1", () => {
      // `PageHeader` renders a <header>, but nested inside <main> it carries no
      // banner role — only the top bar is the page banner.
      render(
        <AppShell>
          <Page />
        </AppShell>,
      );
      expect(screen.getAllByRole("banner")).toHaveLength(1);
      expect(screen.getAllByRole("main")).toHaveLength(1);
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    });

    it("has no accessibility violations", async () => {
      const { container } = render(
        <AppShell>
          <Page />
        </AppShell>,
      );
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});

describe("findActiveNavItem", () => {
  it.each([
    ["/overview", "overview"],
    ["/assets", "assets"],
    ["/assets/abc-123", "assets"],
    ["/settings", "settings"],
  ])("resolves %s to %s", (pathname, key) => {
    expect(findActiveNavItem(pathname)?.key).toBe(key);
  });

  it("returns null for an unknown path rather than guessing", () => {
    expect(findActiveNavItem("/nowhere")).toBeNull();
  });
});
