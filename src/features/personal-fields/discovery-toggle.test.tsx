import { describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 8).toString("base64") },
}));
import userEvent from "@testing-library/user-event";
import { DiscoveryToggle } from "@/features/personal-fields";
import type { PersonalFieldToggleAction } from "@/features/personal-fields";

/**
 * DiscoveryToggle (ATL-209).
 *
 * The toggle is the primary UI surface for `include_in_discovery`. Tests cover:
 *
 *   - ARIA: role="switch" with aria-checked reflecting the current state.
 *   - data-state attribute: "checked" when enabled, "unchecked" when disabled.
 *   - Click calls the action with the correct fieldId and the *opposite* of the
 *     current state (i.e. it toggles).
 *   - Optimistic update: the toggle flips immediately before the action resolves.
 *   - Revert on failure: if the action returns { ok: false }, the toggle reverts
 *     to the previous state so the user's view stays consistent with the server.
 *   - Hint text: the accessibility description is rendered and associated via
 *     aria-describedby.
 *   - Label text: the visible label text is present.
 *
 * The component uses useOptimistic (React 19 / Next.js canary experimental API).
 * Tests run inside act() to flush transitions.
 */

describe("DiscoveryToggle (ATL-209)", () => {
  const FIELD_ID = "field-toggle-1";

  function setup(enabled: boolean, action: ReturnType<typeof vi.fn>) {
    return render(
      <DiscoveryToggle
        fieldId={FIELD_ID}
        enabled={enabled}
        action={action as unknown as PersonalFieldToggleAction}
      />,
    );
  }

  it("renders a button with role='switch'", () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    setup(false, action);

    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("sets aria-checked=false when enabled=false", () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    setup(false, action);

    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("sets aria-checked=true when enabled=true", () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    setup(true, action);

    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("sets data-state='unchecked' when enabled=false", () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    setup(false, action);

    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "unchecked");
  });

  it("sets data-state='checked' when enabled=true", () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    setup(true, action);

    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "checked");
  });

  it("calls action with fieldId and true when toggled from off to on", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    setup(false, action);

    await userEvent.click(screen.getByRole("switch"));

    expect(action).toHaveBeenCalledWith(FIELD_ID, true);
  });

  it("calls action with fieldId and false when toggled from on to off", async () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    setup(true, action);

    await userEvent.click(screen.getByRole("switch"));

    expect(action).toHaveBeenCalledWith(FIELD_ID, false);
  });

  it("flips aria-checked optimistically before the action resolves", () => {
    // Action that never resolves during the check
    let resolveAction!: (v: { ok: boolean }) => void;
    const action = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((res) => {
          resolveAction = res;
        }),
    );
    setup(false, action);

    const button = screen.getByRole("switch");
    expect(button).toHaveAttribute("aria-checked", "false");

    // Start the click synchronously so the optimistic update is applied before we check.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    act(() => {
      fireEvent.click(button);
    });
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");

    // Resolve the action and flush remaining transitions.
    act(() => {
      resolveAction({ ok: true });
    });
  });

  it("reverts to previous state when action returns { ok: false }", async () => {
    const action = vi.fn().mockResolvedValue({ ok: false });
    setup(false, action);

    await userEvent.click(screen.getByRole("switch"));

    // After a failed action, the toggle must revert to its original position
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("renders visible label text", () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    setup(false, action);

    // The copy says "Use for discovery" — verify the label is rendered somewhere
    expect(screen.getByText(/use for discovery/i)).toBeInTheDocument();
  });

  it("renders hint text associated via aria-describedby", () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    setup(false, action);

    const button = screen.getByRole("switch");
    const hintId = button.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();

    // eslint-disable-next-line testing-library/no-node-access
    const hint = document.getElementById(hintId!);
    expect(hint).not.toBeNull();
    expect(hint!.textContent?.trim().length).toBeGreaterThan(0);
  });
});
