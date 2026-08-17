import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ATL-035 — the identifier as a surface renders it.
 *
 * What only a render can show: that the full value is absent from the DOM until
 * the user asks for it, that asking is a deliberate act rather than a hover or a
 * focus, and that it goes away again on its own.
 *
 * The Server Action is mocked because this file is about the binding, not the
 * service — the service's own guarantees (ownership, audit-before-return) are
 * asserted against the real implementation in
 * `src/server/assets/asset-identifier-reveal.integration.test.ts`.
 */

/**
 * Typed rather than a bare `vi.fn()`: an untyped mock returns `any`, which the
 * unsafe-return rule catches — and rightly, since the shape the component
 * branches on would then be unchecked in the one place it is simulated.
 */
const revealAccountIdentifierAction =
  vi.fn<(assetId: string) => Promise<{ ok: boolean; value: string | null }>>();

vi.mock("@/app/(product)/assets/[id]/actions", () => ({
  revealAccountIdentifierAction: (assetId: string) => revealAccountIdentifierAction(assetId),
}));

const { AccountIdentifier } = await import("./account-identifier");
const { DEFAULT_REVEAL_DURATION_MS } = await import("@/components/ui/sensitive-value");

const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const MASKED = "d••••••y@example.com";
const FULL = "dana.scully@example.com";

beforeEach(() => {
  revealAccountIdentifierAction.mockReset();
  revealAccountIdentifierAction.mockResolvedValue({ ok: true, value: FULL });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Named `mountField` rather than `setup`: the testing-library lint rule tracks
 * render results by the identifier they came from, and a helper called `setup`
 * makes it read every `userEvent.setup()` in the file as one.
 */
const mountField = () => render(<AccountIdentifier masked={MASKED} assetId={ASSET_ID} />);

describe("before the user asks", () => {
  it("shows the masked value", () => {
    mountField();

    expect(screen.getByText(MASKED)).toBeInTheDocument();
  });

  it("has the full value nowhere in the DOM", () => {
    /**
     * The criterion is "masked by default", and the strong form of it is that
     * the value is not present and hidden — it is not present. A CSS-hidden
     * value is still in the markup, the accessibility tree, and any screenshot.
     */
    const { container } = mountField();

    expect(container.innerHTML).not.toContain(FULL);
    expect(container.innerHTML).not.toContain("dana.scully");
  });

  it("does not call the server merely by rendering", () => {
    // Reveal is a user action. Fetching eagerly would audit a disclosure that
    // nobody asked for, and put the value in the page regardless.
    mountField();

    expect(revealAccountIdentifierAction).not.toHaveBeenCalled();
  });

  it("offers reveal as a named control", () => {
    mountField();

    expect(screen.getByRole("button", { name: "Reveal Account identifier" })).toBeInTheDocument();
  });
});

describe("revealing", () => {
  it("shows the full value after an explicit action", async () => {
    const user = userEvent.setup();
    mountField();

    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));

    expect(await screen.findByText(FULL)).toBeInTheDocument();
  });

  it("asks the server for this asset, by id", async () => {
    // The id travels in the action's arguments — a POST body — never a URL.
    const user = userEvent.setup();
    mountField();

    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));

    await waitFor(() => expect(revealAccountIdentifierAction).toHaveBeenCalledWith(ASSET_ID));
  });

  it("is reachable and operable by keyboard alone", async () => {
    const user = userEvent.setup();
    mountField();

    await user.tab();
    expect(screen.getByRole("button", { name: "Reveal Account identifier" })).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(await screen.findByText(FULL)).toBeInTheDocument();
  });

  it("can be hidden again deliberately", async () => {
    const user = userEvent.setup();
    mountField();

    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));
    await screen.findByText(FULL);

    await user.click(screen.getByRole("button", { name: "Hide Account identifier" }));

    expect(screen.queryByText(FULL)).not.toBeInTheDocument();
    expect(screen.getByText(MASKED)).toBeInTheDocument();
  });

  it("announces the reveal without announcing the value", async () => {
    const user = userEvent.setup();
    mountField();

    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));
    await screen.findByText(FULL);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/revealed/i);
    expect(status.textContent).not.toContain(FULL);
  });
});

describe("re-masking", () => {
  it("hides the value again on its own", async () => {
    /**
     * Security §8: reveal is temporary. A value left on an unattended screen is
     * the failure the timeout exists to prevent, and the duration is the
     * primitive's — this component deliberately does not set its own.
     */
    /**
     * `shouldAdvanceTime` keeps real time moving while the fake clock is
     * installed. Without it, Testing Library's own polling waits on a clock only
     * this test advances, and the two deadlock — the reveal never resolves and
     * the failure looks like a component fault rather than a harness one.
     */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mountField();

    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));
    await screen.findByText(FULL);

    // Inside `act`: the re-mask is a state update driven by a timer rather than
    // by an event, so nothing else flushes it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_REVEAL_DURATION_MS);
    });

    expect(screen.queryByText(FULL)).not.toBeInTheDocument();
    expect(screen.getByText(MASKED)).toBeInTheDocument();
  });
});

describe("when the server refuses", () => {
  it("shows a refusal and no value", async () => {
    const user = userEvent.setup();
    revealAccountIdentifierAction.mockResolvedValue({ ok: false, value: null });
    const { container } = mountField();

    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/could not/i));
    expect(container.innerHTML).not.toContain(FULL);
  });

  it("says nothing about why", async () => {
    /**
     * "Not yours", "no such asset" and "the audit log is down" are three
     * different sentences, and distinguishing them turns a guessed id into an
     * oracle. The service already refuses them identically; the UI must not
     * undo that.
     */
    const user = userEvent.setup();
    revealAccountIdentifierAction.mockResolvedValue({ ok: false, value: null });
    mountField();

    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).not.toMatch(/not found|forbidden|audit|permission|exist/i);
  });

  it("recovers if a later attempt succeeds", async () => {
    const user = userEvent.setup();
    revealAccountIdentifierAction.mockResolvedValueOnce({ ok: false, value: null });
    mountField();

    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/could not/i));

    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));

    expect(await screen.findByText(FULL)).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("has no violations while masked", async () => {
    const { container } = mountField();

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations while revealed", async () => {
    const user = userEvent.setup();
    const { container } = mountField();

    await user.click(screen.getByRole("button", { name: "Reveal Account identifier" }));
    await screen.findByText(FULL);

    expect(await axe(container)).toHaveNoViolations();
  });
});
