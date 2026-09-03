import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@/lib/onboarding/onboarding-state";
import { OnboardingFlow } from "./onboarding-flow";

/**
 * ATL-017 — resuming the onboarding flow.
 *
 * Covers what the browser suite cannot reach cheaply: that the component starts
 * from server-resolved state, reports every move, and never restores consent.
 * The full journey is `tests/e2e/onboarding.spec.ts`.
 */

vi.mock("./actions", () => ({
  completeOnboardingAction: vi.fn(),
}));

const midway: OnboardingState = {
  step: "categories",
  privacyGoal: "reduce_exposure",
  categories: ["social"],
  startingPoint: null,
};

const heading = (name: string | RegExp) => screen.getByRole("heading", { level: 1, name });

describe("resuming", () => {
  it("opens at the saved step rather than the introduction", async () => {
    render(<OnboardingFlow initialState={midway} />);

    expect(heading("Where do you have accounts?")).toBeInTheDocument();
    expect(await screen.findByText("Step 3 of 5")).toBeInTheDocument();
  });

  it("restores the choices made before leaving", () => {
    render(<OnboardingFlow initialState={midway} />);

    expect(screen.getByRole("checkbox", { name: /Social/ })).toBeChecked();
  });

  it("keeps an earlier answer reachable by going back", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow initialState={midway} />);

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(heading("What brings you here?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Reduce my exposure/ })).toBeChecked();
  });

  it("starts at the introduction when there is nothing saved", () => {
    render(<OnboardingFlow />);

    expect(heading("What Atlas does")).toBeInTheDocument();
  });
});

describe("reporting progress", () => {
  it("reports the new step on continue", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: "starting_point", categories: ["social"] }),
    );
  });

  it("reports the earlier step on back", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: "privacy_goal" }),
    );
  });

  it("reports a skip, so a skipped step is not offered again on return", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: "starting_point" }),
    );
  });

  it("reports an answer as it is chosen", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("checkbox", { name: /Finance/ }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ categories: ["social", "finance"] }),
    );
  });

  it("reports a deselection, not just additions", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("checkbox", { name: /Social/ }));

    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ categories: [] }));
  });

  it("remains fully operable with no handler supplied", async () => {
    // Persistence is a convenience; losing it must not cost the user the flow.
    const user = userEvent.setup();
    render(<OnboardingFlow initialState={midway} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(heading("How would you like to begin?")).toBeInTheDocument();
  });
});

describe("consent is never resumed", () => {
  it("shows the consent box unchecked even after a full resume", async () => {
    /**
     * ATL-016: the box must be unchecked and never pre-selected, because a
     * pre-ticked box produces a consent record that means nothing (ATL-078).
     * Resuming a saved tick would agree on the user's behalf to something they
     * may never have submitted.
     */
    const user = userEvent.setup();
    render(
      <OnboardingFlow
        initialState={{ ...midway, step: "starting_point" }}
        // A tampered payload carrying consent must not reach the checkbox.
        onStateChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("checkbox", { name: /Let Atlas use AI/ })).not.toBeChecked();
  });

  it("never includes a consent field in what it reports", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));

    const reported = onStateChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(Object.keys(reported).sort()).toEqual([
      "categories",
      "privacyGoal",
      "startingPoint",
      "step",
    ]);
  });
});
