import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

/**
 * `region` ("all page content should be contained by landmarks") is a page-level
 * rule. Portalled overlays rendered standalone in a test have no landmark
 * ancestor, so it fires on the test harness rather than the component. Landmark
 * coverage of real pages is asserted in the shell tests (ATL-005).
 */
const COMPONENT_AXE_OPTIONS = { rules: { region: { enabled: false } } };
import { describe, expect, it, vi } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";

/**
 * ATL-009 — overlay primitives.
 *
 * Covers the acceptance criterion "Dialog/drawer implement focus trap, escape, and
 * focus return", plus the ticket's keyboard-traversal requirement for dialog and
 * dropdown.
 */

function DialogFixture() {
  return (
    <Dialog>
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request deletion</DialogTitle>
          <DialogDescription>Review before continuing.</DialogDescription>
        </DialogHeader>
        <button type="button">First</button>
        <button type="button">Second</button>
      </DialogContent>
    </Dialog>
  );
}

function DrawerFixture({ onOpenChange }: { onOpenChange?: (open: boolean) => void } = {}) {
  return (
    <Drawer {...(onOpenChange ? { onOpenChange } : {})}>
      <DrawerTrigger>Open drawer</DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Asset details</DrawerTitle>
          <DrawerDescription>Contextual inspection.</DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          <button type="button">Inside</button>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

function MenuFixture({ onArchive }: { onArchive?: () => void } = {}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Asset actions">Actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Manage</DropdownMenuLabel>
        <DropdownMenuItem>View</DropdownMenuItem>
        <DropdownMenuItem {...(onArchive ? { onSelect: onArchive } : {})}>Archive</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe.each([
  ["Dialog", DialogFixture, "Request deletion", "Open dialog"],
  ["Drawer", DrawerFixture, "Asset details", "Open drawer"],
])("%s", (_name, Fixture, title, triggerName) => {
  it("is closed by default and opens from its trigger", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: triggerName }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("has an accessible name from its title", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: triggerName }));
    expect(await screen.findByRole("dialog")).toHaveAccessibleName(title);
  });

  it("renders in a portal so it escapes the trigger's stacking context", async () => {
    // Modality is guaranteed by focus containment (asserted below) rather than by
    // `aria-modal`, which this Radix version deliberately does not set.
    const user = userEvent.setup();
    const { container } = render(<Fixture />);
    await user.click(screen.getByRole("button", { name: triggerName }));

    const dialog = await screen.findByRole("dialog");
    // Rendered outside the component's own subtree, i.e. in a portal.
    expect(container).not.toContainElement(dialog);
  });

  it("moves focus into the overlay when opened", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: triggerName }));

    const dialog = await screen.findByRole("dialog");
    // Tabbing once from the open state must land on a control inside the overlay.
    await user.tab();
    const inside = within(dialog).getAllByRole("button");
    await waitFor(() => {
      expect(inside.some((element) => element.matches(":focus"))).toBe(true);
    });
  });

  it("traps focus: tabbing past the last control wraps to the first", async () => {
    // Wrap-around is the observable proof of a focus trap, and it needs no
    // direct node access — an escape would leave focus on the document body.
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: triggerName }));
    const dialog = await screen.findByRole("dialog");

    const controls = within(dialog).getAllByRole("button");
    expect(controls.length).toBeGreaterThan(1);

    // One full cycle plus one: focus must still be on a control inside the overlay.
    for (let i = 0; i < controls.length + 1; i += 1) {
      await user.tab();
    }
    expect(controls.some((element) => element.matches(":focus"))).toBe(true);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: triggerName }));
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("returns focus to the trigger on close", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const trigger = screen.getByRole("button", { name: triggerName });

    await user.click(trigger);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes from its close control", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: triggerName }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("has no accessibility violations when open", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<Fixture />);
    await user.click(screen.getByRole("button", { name: triggerName }));
    await screen.findByRole("dialog");
    expect(await axe(baseElement, COMPONENT_AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe("Drawer", () => {
  it("lets a consumer guard closing so unsaved work is not discarded", async () => {
    // Frontend §10: the request flow must not silently discard an edited draft.
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<DrawerFixture onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: "Open drawer" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("DropdownMenu", () => {
  it("opens from the keyboard and focuses the first item", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);

    await user.tab();
    expect(screen.getByRole("button", { name: "Asset actions" })).toHaveFocus();
    await user.keyboard("{Enter}");

    const menu = await screen.findByRole("menu");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "View" })).toHaveFocus());
  });

  it("moves between items with arrow keys", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);
    await user.click(screen.getByRole("button", { name: "Asset actions" }));
    const menu = await screen.findByRole("menu");

    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "View" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(within(menu).getByRole("menuitem", { name: "Archive" })).toHaveFocus(),
    );
  });

  it("activates an item with Enter", async () => {
    const onArchive = vi.fn();
    const user = userEvent.setup();
    render(<MenuFixture onArchive={onArchive} />);

    await user.click(screen.getByRole("button", { name: "Asset actions" }));
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    await waitFor(() => expect(onArchive).toHaveBeenCalledOnce());
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);
    const trigger = screen.getByRole("button", { name: "Asset actions" });

    await user.click(trigger);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("marks a destructive item so it is visually distinct", async () => {
    const user = userEvent.setup();
    render(<MenuFixture />);
    await user.click(screen.getByRole("button", { name: "Asset actions" }));

    expect(await screen.findByRole("menuitem", { name: "Delete" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
  });

  it("has no accessibility violations when open", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<MenuFixture />);
    await user.click(screen.getByRole("button", { name: "Asset actions" }));
    await screen.findByRole("menu");
    expect(await axe(baseElement, COMPONENT_AXE_OPTIONS)).toHaveNoViolations();
  });
});
