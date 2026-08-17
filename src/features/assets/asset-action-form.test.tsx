import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { AssetActionForm, type AssetActionFormState } from "./asset-action-form";

/**
 * ATL-112 — the form that can say it did nothing.
 *
 * These assert the one behaviour the previous version could not have: that a
 * failed write produces something a user can see. The action itself is a double;
 * which failures it reports is asserted in
 * `src/app/(product)/assets/[id]/edit/revalidation.integration.test.ts`.
 */

const IDLE: AssetActionFormState = { failure: null, attempt: 0 };

/** An action that always returns the given state. */
const actionReturning = (state: AssetActionFormState) =>
  vi.fn(() => Promise.resolve(state)) as unknown as (
    previous: AssetActionFormState,
    formData: FormData,
  ) => Promise<AssetActionFormState>;

function renderForm(state: AssetActionFormState) {
  return render(
    <AssetActionForm
      action={actionReturning(state)}
      initialState={IDLE}
      assetId="11111111-1111-4111-8111-111111111111"
      label="Mark as reviewed"
    >
      <button type="submit">Mark as reviewed</button>
    </AssetActionForm>,
  );
}

describe("before anything is submitted", () => {
  it("shows no error", () => {
    renderForm(IDLE);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("carries the asset id without the caller repeating it", () => {
    // Every one of these forms needs it, so the wrapper owns it rather than
    // seven call sites each remembering a hidden input.
    renderForm(IDLE);

    /**
     * Read through `FormData` rather than by reaching for the hidden input.
     *
     * A hidden input has no role and no accessible name, so there is no
     * Testing Library query that reaches it — and querying the container for it
     * is the node access this file was failing lint on. Asking the form what it
     * would submit asserts the same fact through the same door the Server
     * Action uses, and is the pattern `asset-list.test.tsx` already uses for the
     * filters form.
     */
    const form = screen.getByRole("form", { name: "Mark as reviewed" });
    if (!(form instanceof HTMLFormElement)) throw new Error("the wrapper must render a form");

    expect(new FormData(form).get("assetId")).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("names itself, so its controls are distinguishable from the next form's", () => {
    renderForm(IDLE);

    expect(screen.getByRole("form", { name: "Mark as reviewed" })).toBeInTheDocument();
  });
});

describe("when the action reports a failure", () => {
  it.each([
    ["unavailable", "Something went wrong. Nothing was changed — please try again."],
    ["not_found", "This service is no longer available. Nothing was changed."],
    ["rejected", "Atlas did not recognise that choice, so nothing was changed."],
  ] as const)("announces %s", async (failure, message) => {
    /**
     * The defect, stated as a test: this used to render nothing at all, so a
     * user who clicked the button during a fault believed the change had been
     * recorded.
     */
    renderForm({ failure, attempt: 1 });

    await userEvent.click(screen.getByRole("button", { name: "Mark as reviewed" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("says nothing was changed, which is the part that matters", async () => {
    // A user who is told only "something went wrong" still does not know
    // whether to try again.
    renderForm({ failure: "unavailable", attempt: 1 });

    await userEvent.click(screen.getByRole("button", { name: "Mark as reviewed" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Nothing was changed");
  });

  it("keeps the control usable so the user can retry", async () => {
    renderForm({ failure: "unavailable", attempt: 1 });
    const button = screen.getByRole("button", { name: "Mark as reviewed" });

    await userEvent.click(button);
    await screen.findByRole("alert");

    expect(button).toBeEnabled();
  });

  it("carries no provider detail or error code", async () => {
    // Security §5's neutral-message rule: the user is told what happened to
    // their data, never what the backend said.
    renderForm({ failure: "unavailable", attempt: 1 });

    await userEvent.click(screen.getByRole("button", { name: "Mark as reviewed" }));
    const text = (await screen.findByRole("alert")).textContent ?? "";

    expect(text).not.toMatch(/UNAVAILABLE|NOT_FOUND|supabase|postgres/i);
  });

  it("has no accessibility violations", async () => {
    const { container } = renderForm({ failure: "not_found", attempt: 1 });

    await userEvent.click(screen.getByRole("button", { name: "Mark as reviewed" }));
    await screen.findByRole("alert");

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("when the action succeeds", () => {
  it("shows no error", async () => {
    renderForm(IDLE);

    await userEvent.click(screen.getByRole("button", { name: "Mark as reviewed" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
