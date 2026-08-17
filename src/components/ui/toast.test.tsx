import { configure, render, screen } from "@testing-library/react";
import { afterAll, describe, expect, it } from "vitest";
import { Toast, ToastAction, ToastClose, ToastProvider, ToastTitle, ToastViewport } from "./toast";

/**
 * ATL-009 — the toast viewport, and the one thing about it that is not cosmetic.
 *
 * The viewport is mounted once for the whole app in `src/providers/index.tsx` and
 * is a fixed strip along the bottom of every page — full width below `sm`, with
 * padding that gives it a height even when it holds nothing. Whether it accepts
 * pointer events therefore decides whether controls near the bottom of *any* page
 * can be clicked. Mobile Playwright found the form submit in Settings → Personal
 * data unreachable for exactly this reason.
 *
 * ## Why these are class assertions
 *
 * jsdom applies no stylesheet, so `pointer-events` has no effect here and a click
 * through the strip cannot be simulated — a behavioural test would pass whatever
 * the classes said. The hit-testing itself is asserted by Playwright, which is
 * what caught the fault. What this file protects is the declaration: the strip
 * gives up pointer events, and a toast takes them back.
 */

/**
 * Addresses the `data-slot` attributes by `getByTestId`, as `finding-detail.test.tsx`
 * does. Roles cannot reach these two elements: `region` names Radix's outer
 * wrapper rather than the styled strip, and `status` names the announcer span.
 *
 * Test-only, and the default is restored below so no other suite inherits it.
 */
configure({ testIdAttribute: "data-slot" });

afterAll(() => {
  configure({ testIdAttribute: "data-testid" });
});

function mountToast() {
  return render(
    <ToastProvider>
      <Toast open>
        <ToastTitle>Service archived</ToastTitle>
        <ToastAction altText="Undo archiving">Undo</ToastAction>
        <ToastClose />
      </Toast>
      <ToastViewport />
    </ToastProvider>,
  );
}

describe("the toast viewport does not intercept clicks", () => {
  it("is transparent to the pointer", () => {
    mountToast();

    const viewport = screen.getByTestId("toast-viewport");
    /**
     * Unconditional, not `hasToasts`-dependent. Radix drops pointer events on its
     * own wrapper only while the list is empty, so without this the strip becomes
     * hit-testable the moment any toast opens — and a full-width band across the
     * bottom of the layout then swallows clicks meant for the page.
     */
    expect(viewport.className).toContain("pointer-events-none");
  });

  it("gives them back to the toast itself", () => {
    mountToast();

    /**
     * The toast is the only part of that strip a person can aim at, so it is the
     * only part that should take a click. Undo is the reason this matters: ADR-005
     * prefers undo over confirmation, and an undo nobody can press is not one.
     */
    const toast = screen.getByTestId("toast");
    expect(toast.className).toContain("pointer-events-auto");
  });

  it("keeps the undo and dismiss controls reachable", () => {
    mountToast();

    // Inside the toast, so both inherit the re-enabled pointer events.
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});
