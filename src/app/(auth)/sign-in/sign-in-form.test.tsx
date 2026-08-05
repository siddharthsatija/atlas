import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAGIC_LINK_MESSAGES } from "@/lib/auth/auth-copy";
import type { MagicLinkFormState } from "./form-state";

/**
 * ATL-014 — sign-in form behaviour.
 *
 * The Server Actions are replaced with doubles so this exercises the *screen*:
 * which state is shown, where focus lands, and what assistive technology is told.
 * The actions' own behaviour is covered by their integration test.
 */

const requestMagicLink = vi.fn();
const startGoogleSignIn = vi.fn();

vi.mock("./actions", () => ({
  requestMagicLinkAction: (previous: MagicLinkFormState, formData: FormData) =>
    requestMagicLink(previous, formData) as Promise<MagicLinkFormState>,
  startGoogleSignInAction: (formData: FormData) => startGoogleSignIn(formData) as Promise<void>,
}));

const { SignInForm } = await import("./sign-in-form");

/** Resolves the action with a given result code. */
function resolveWith(code: MagicLinkFormState["code"]) {
  requestMagicLink.mockImplementation((previous: MagicLinkFormState) =>
    Promise.resolve({ code, attempt: previous.attempt + 1 }),
  );
}

const emailField = () => screen.getByLabelText("Email address");
const submitButton = () => screen.getByRole("button", { name: /sign-in link|sending link/i });

afterEach(() => {
  vi.clearAllMocks();
});

describe("form basics", () => {
  it("offers a labelled email field and a submit control", () => {
    render(<SignInForm />);
    expect(emailField()).toHaveAttribute("type", "email");
    expect(emailField()).toHaveAttribute("autocomplete", "email");
    expect(submitButton()).toBeInTheDocument();
  });

  it("explains the method without promising security", () => {
    render(<SignInForm />);
    expect(screen.getByText(/no password to remember/i)).toBeInTheDocument();
  });

  it("hides Google unless it is configured", () => {
    render(<SignInForm />);
    expect(screen.queryByRole("button", { name: /continue with google/i })).not.toBeInTheDocument();
  });

  it("offers Google when configured", () => {
    render(<SignInForm googleEnabled />);
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });

  it("carries the return path as a hidden field rather than in a URL", () => {
    render(<SignInForm returnPath="/assets" googleEnabled />);
    // Both methods must preserve it — a user who chooses Google should land in
    // the same place as one who chooses email.
    expect(screen.getByTestId("return-path")).toHaveValue("/assets");
    expect(screen.getByTestId("return-path-google")).toHaveValue("/assets");
  });

  it("omits the hidden field when there is no return path", () => {
    render(<SignInForm />);
    expect(screen.queryByTestId("return-path")).not.toBeInTheDocument();
  });
});

describe("result states", () => {
  it.each(["verification_sent", "invalid_email", "rate_limited", "unavailable"] as const)(
    "renders the %s message",
    async (code) => {
      const user = userEvent.setup();
      resolveWith(code);
      render(<SignInForm />);

      await user.type(emailField(), "user@example.com");
      await user.click(submitButton());

      expect(await screen.findByText(MAGIC_LINK_MESSAGES[code].title)).toBeInTheDocument();
      expect(screen.getByText(MAGIC_LINK_MESSAGES[code].description)).toBeInTheDocument();
    },
  );

  it("shows no message before the first submission", () => {
    render(<SignInForm />);
    // The live region exists from the start, but says nothing.
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("never echoes the submitted address back into a message", async () => {
    const user = userEvent.setup();
    resolveWith("unavailable");
    render(<SignInForm />);

    await user.type(emailField(), "dana@example.com");
    await user.click(submitButton());
    await screen.findByText(MAGIC_LINK_MESSAGES.unavailable.title);

    // The address belongs in the field the user typed it into. Repeating it in a
    // message puts it somewhere a screen reader announces and a screenshot
    // captures, for no benefit.
    expect(screen.getByRole("status")).not.toHaveTextContent("dana@example.com");
  });
});

describe("accessible errors and focus", () => {
  it("treats an invalid address as a field error and returns focus to the field", async () => {
    const user = userEvent.setup();
    resolveWith("invalid_email");
    render(<SignInForm />);

    await user.type(emailField(), "not-an-email");
    await user.click(submitButton());

    await waitFor(() => expect(emailField()).toHaveAttribute("aria-invalid", "true"));
    // The fix is in the field, so focus belongs there.
    expect(emailField()).toHaveFocus();
    // And the message is programmatically associated with it.
    expect(emailField()).toHaveAttribute("aria-describedby", screen.getByRole("status").id);
  });

  it("moves focus to the message for a form-level result", async () => {
    const user = userEvent.setup();
    resolveWith("verification_sent");
    render(<SignInForm />);

    await user.type(emailField(), "user@example.com");
    await user.click(submitButton());

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveFocus();
    });
    // The address was fine, so refocusing the field would misdirect the user.
    expect(emailField()).not.toHaveFocus();
  });

  it("does not mark the field invalid for a form-level result", async () => {
    const user = userEvent.setup();
    resolveWith("rate_limited");
    render(<SignInForm />);

    await user.type(emailField(), "user@example.com");
    await user.click(submitButton());
    await screen.findByText(MAGIC_LINK_MESSAGES.rate_limited.title);

    expect(emailField()).not.toHaveAttribute("aria-invalid", "true");
  });

  it("announces the result through a live region", async () => {
    const user = userEvent.setup();
    resolveWith("verification_sent");
    render(<SignInForm />);

    // The region exists before the message does — one inserted alongside its
    // content is announced unreliably.
    const live = screen.getByRole("status");
    expect(live).toBeEmptyDOMElement();

    await user.type(emailField(), "user@example.com");
    await user.click(submitButton());

    await waitFor(() =>
      expect(live).toHaveTextContent(MAGIC_LINK_MESSAGES.verification_sent.title),
    );
  });

  it("re-announces an identical repeated result", async () => {
    // Two failed attempts with the same address produce the same code; without
    // the attempt counter the second would pass silently.
    const user = userEvent.setup();
    resolveWith("invalid_email");
    render(<SignInForm />);

    await user.type(emailField(), "bad");
    await user.click(submitButton());
    await waitFor(() => expect(emailField()).toHaveFocus());

    emailField().blur();
    await user.click(submitButton());

    await waitFor(() => expect(emailField()).toHaveFocus());
    expect(requestMagicLink).toHaveBeenCalledTimes(2);
  });
});

describe("keyboard operation", () => {
  it("submits from the keyboard alone", async () => {
    const user = userEvent.setup();
    resolveWith("verification_sent");
    render(<SignInForm />);

    await user.tab();
    expect(emailField()).toHaveFocus();
    await user.keyboard("user@example.com{Enter}");

    await waitFor(() => expect(requestMagicLink).toHaveBeenCalledTimes(1));
  });

  it("reaches the Google option by keyboard", async () => {
    const user = userEvent.setup();
    render(<SignInForm googleEnabled />);

    await user.tab(); // email
    await user.tab(); // submit
    await user.tab(); // Google
    expect(screen.getByRole("button", { name: /continue with google/i })).toHaveFocus();
  });
});

describe("accessibility", () => {
  it("has no violations in its initial state", async () => {
    const { container } = render(<SignInForm googleEnabled />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations showing a field error", async () => {
    const user = userEvent.setup();
    resolveWith("invalid_email");
    const { container } = render(<SignInForm />);

    await user.type(emailField(), "bad");
    await user.click(submitButton());
    await screen.findByText(MAGIC_LINK_MESSAGES.invalid_email.title);

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations in the verification state", async () => {
    const user = userEvent.setup();
    resolveWith("verification_sent");
    const { container } = render(<SignInForm />);

    await user.type(emailField(), "user@example.com");
    await user.click(submitButton());
    await screen.findByText(MAGIC_LINK_MESSAGES.verification_sent.title);

    expect(await axe(container)).toHaveNoViolations();
  });
});
