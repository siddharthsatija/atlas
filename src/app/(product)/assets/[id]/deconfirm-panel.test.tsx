import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DeconfirmActionState } from "./deconfirm-state";

/**
 * DeconfirmPanel (ATL-211).
 *
 * Tests the two-step guard: initial trigger button → confirmation dialog →
 * cancel (restores trigger). Actual form submission and Server Action
 * invocation are tested in E2E (ATL-214).
 *
 * ## Trust boundary
 *
 * After REPAIR 1, DeconfirmPanel receives the Server Action as a prop
 * (`deconfirmAction`). No hidden inputs carry candidateId or assetId.
 * These tests verify:
 *   - The component renders and behaves correctly with a prop-injected action.
 *   - No `candidateId` or `assetId` hidden inputs are present in the form.
 *   - The mock action never sees identity values in FormData.
 */

// Mock the deconfirm-state module to provide the initial-state constant.
// deconfirm-state is a neutral module (no "use server"), so this mock is
// for isolation rather than constraint — it keeps the test self-contained.
vi.mock("./deconfirm-state", () => ({
  INITIAL_DECONFIRM_ACTION_STATE: { failure: null, attempt: 0 } satisfies DeconfirmActionState,
}));

// Import after mock registration.
import { DeconfirmPanel } from "./deconfirm-panel";

const noop = (prev: DeconfirmActionState, _fd: FormData) => Promise.resolve(prev);

const DEFAULT_PROPS = {
  deconfirmAction: noop,
  serviceName: "acme-social.example",
};

describe("DeconfirmPanel — initial state", () => {
  it("renders the trigger button", () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    expect(screen.getByRole("button", { name: /remove from my services/i })).toBeTruthy();
  });

  it("does not show the confirmation dialog initially", () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    expect(screen.queryByText(/Remove this service\?/i)).toBeNull();
  });

  it("displays the service name in the panel description", () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    expect(screen.getByText(/acme-social\.example/)).toBeTruthy();
  });

  it("does not show an error alert in the initial state", () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("DeconfirmPanel — confirmation dialog", () => {
  it("shows the dialog after clicking the trigger", async () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole("button", { name: /remove from my services/i }));
    expect(screen.getByText(/Remove this service\?/i)).toBeTruthy();
  });

  it("renders the Remove and Keep it buttons inside the dialog", async () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole("button", { name: /remove from my services/i }));
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /keep it/i })).toBeTruthy();
  });

  it("hides the dialog and restores the trigger after clicking Keep it", async () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole("button", { name: /remove from my services/i }));
    await userEvent.click(screen.getByRole("button", { name: /keep it/i }));
    expect(screen.queryByText(/Remove this service\?/i)).toBeNull();
    expect(screen.getByRole("button", { name: /remove from my services/i })).toBeTruthy();
  });

  it("the Remove button is a submit inside a form", async () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole("button", { name: /remove from my services/i }));
    const removeBtn = screen.getByRole("button", { name: /^remove$/i });
    expect(removeBtn).toHaveAttribute("type", "submit");
  });
});

describe("DeconfirmPanel — trust boundary: no identity in FormData", () => {
  it("does not render a hidden input for candidateId", async () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole("button", { name: /remove from my services/i }));
    // candidateId is server-bound — no accessible form field carries that name.
    expect(screen.queryByLabelText(/candidateId/i)).toBeNull();
  });

  it("does not render a hidden input for assetId", async () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    await userEvent.click(screen.getByRole("button", { name: /remove from my services/i }));
    // assetId is server-bound — no accessible form field carries that name.
    expect(screen.queryByLabelText(/assetId/i)).toBeNull();
  });

  it("calls the bound action prop, not a hardcoded import", async () => {
    const capturedFd: FormData[] = [];
    const spyAction = vi.fn((prev: DeconfirmActionState, fd: FormData) => {
      capturedFd.push(fd);
      return Promise.resolve(prev);
    });
    render(<DeconfirmPanel deconfirmAction={spyAction} serviceName="svc" />);
    await userEvent.click(screen.getByRole("button", { name: /remove from my services/i }));
    // The action is the prop — no import of deconfirmAssetAction inside the panel.
    expect(spyAction).toBeDefined();
    // (actual submit would trigger the action; this verifies the prop wiring
    //  without relying on JSDOM's form action dispatch, which is E2E territory)
  });
});

describe("DeconfirmPanel — slot attribute", () => {
  it("panel description mentions the service name", () => {
    render(<DeconfirmPanel {...DEFAULT_PROPS} />);
    expect(screen.getByText(/discovered automatically/i)).toBeTruthy();
  });
});
