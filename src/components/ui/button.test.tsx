import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

/**
 * SCAFFOLD VALIDATION — not a product test.
 *
 * Proves three pieces of infrastructure work end to end:
 *   1. Testing Library renders a Radix-based primitive under jsdom
 *   2. user-event drives real interaction
 *   3. the jest-axe integration executes and reports
 *
 * This asserts the harness runs. It is NOT a claim that Atlas is accessible —
 * that is established per-surface against .claude/skills/accessibility/checklists.md.
 */
describe("Button (harness validation)", () => {
  it("renders its children", () => {
    render(<Button>Save draft</Button>);
    expect(screen.getByRole("button", { name: "Save draft" })).toBeInTheDocument();
  });

  it("responds to user interaction", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Continue</Button>);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is reachable and activatable by keyboard", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Confirm</Button>);

    await user.tab();
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("exposes a busy state and disables interaction while loading", () => {
    render(<Button loading>Generating</Button>);
    const button = screen.getByRole("button", { name: /Generating/ });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    // The spinner is decorative; the accessible status text carries the meaning.
    expect(screen.getByText("Loading")).toBeInTheDocument();
  });

  it("runs the axe integration without violations", async () => {
    const { container } = render(<Button>Accessible label</Button>);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("detects violations when they exist (proves axe is really running)", async () => {
    // A button with no accessible name must be reported. If this passes silently,
    // the axe integration is not actually executing.
    const { container } = render(<Button aria-label="" />);
    const results = await axe(container);
    expect(results.violations.length).toBeGreaterThan(0);
  });
});
