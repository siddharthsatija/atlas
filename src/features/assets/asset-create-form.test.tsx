import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { AssetCreateForm, type AssetCreateFormState } from "./asset-create-form";

/**
 * ATL-032 — the create form.
 *
 * The account identifier tests exist because the E2E run caught a real leak that
 * every unit test at the time missed: `preservedValues` correctly dropped the
 * identifier from the *server's* response, but the input was uncontrolled, so
 * the DOM kept the typed value regardless — and the client-side validation path
 * never reached the server at all.
 *
 * Testing the pure function proved the wrong thing. These assert the property
 * that actually matters: after a failed submission, the field is empty.
 */

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const initialState: AssetCreateFormState = {
  errors: {},
  failure: null,
  values: {},
  attempt: 0,
};

/**
 * An action that always fails server-side, the way a storage outage would.
 *
 * Declares both parameters so callers can assert on the submitted `FormData` —
 * which is how "the identifier is still sent on a valid attempt" is checked.
 */
const failingAction = (
  state: AssetCreateFormState,
  _formData: FormData,
): Promise<AssetCreateFormState> =>
  Promise.resolve({
    errors: {},
    failure: "unavailable",
    // Note what is absent: the server never returns the identifier.
    values: { serviceName: "Spotify", category: "entertainment" },
    attempt: state.attempt + 1,
  });

const setupForm = (action = vi.fn(failingAction)) => {
  render(<AssetCreateForm action={action} initialState={initialState} />);
  return { action };
};

const identifierField = () => screen.getByLabelText("Account identifier (optional)");

describe("the account identifier after a failed submission", () => {
  it("is cleared when the client rejects the form", async () => {
    /**
     * The path the E2E run caught. Client-side validation calls
     * `preventDefault`, so the action never runs and nothing on the server can
     * clear anything — the field has to clear itself.
     */
    const user = userEvent.setup();
    const { action } = setupForm();

    await user.type(identifierField(), "dana.scully@example.com");
    // Service name left empty, so the client parse fails.
    await user.click(screen.getByRole("button", { name: "Save service" }));

    expect(action).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(identifierField()).toHaveValue("");
    });
  });

  it("is cleared when the server rejects the submission", async () => {
    /**
     * The second path. An uncontrolled input would keep the DOM value here too,
     * however carefully the returned state omitted it.
     */
    const user = userEvent.setup();
    setupForm();

    await user.type(screen.getByLabelText("Service name"), "Spotify");
    await user.selectOptions(screen.getByLabelText("Kind of service"), "entertainment");
    await user.type(identifierField(), "dana.scully@example.com");
    await user.click(screen.getByRole("button", { name: "Save service" }));

    await waitFor(() => {
      expect(identifierField()).toHaveValue("");
    });
  });

  it("does not appear anywhere in the rendered tree afterwards", async () => {
    // Not merely absent from the input — absent from the document.
    const user = userEvent.setup();
    const { container } = render(
      <AssetCreateForm action={vi.fn(failingAction)} initialState={initialState} />,
    );

    await user.type(
      screen.getByLabelText("Account identifier (optional)"),
      "dana.scully@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Save service" }));

    await waitFor(() => {
      expect(container.innerHTML).not.toContain("dana.scully");
    });
  });

  it("still submits the identifier on an otherwise valid attempt", async () => {
    /**
     * The guard against over-correcting. Clearing too eagerly — in the submit
     * handler rather than after the action returns — would send an empty
     * identifier for a form that was fine, silently dropping what the user
     * entered.
     */
    const user = userEvent.setup();
    const action = vi.fn(failingAction);
    render(<AssetCreateForm action={action} initialState={initialState} />);

    await user.type(screen.getByLabelText("Service name"), "Spotify");
    await user.selectOptions(screen.getByLabelText("Kind of service"), "entertainment");
    await user.type(identifierField(), "dana.scully@example.com");
    await user.click(screen.getByRole("button", { name: "Save service" }));

    await waitFor(() => {
      expect(action).toHaveBeenCalled();
    });
    const submitted = action.mock.calls[0]?.[1];
    expect(submitted?.get("accountIdentifier")).toBe("dana.scully@example.com");
  });

  it("explains that it will need retyping", () => {
    // An empty field the user did not empty is confusing unless it is explained.
    setupForm();

    expect(screen.getByText(/you will need to type this again/i)).toBeInTheDocument();
  });
});

describe("everything else survives a failure", () => {
  it("keeps the service name and category", async () => {
    // ATL-032: "Form preserves input on recoverable errors" — the identifier is
    // the one deliberate exception.
    const user = userEvent.setup();
    setupForm();

    await user.type(screen.getByLabelText("Service name"), "Spotify");
    await user.selectOptions(screen.getByLabelText("Kind of service"), "entertainment");
    await user.click(screen.getByRole("button", { name: "Save service" }));

    /**
     * Both in one wait: the re-seed happens in a single render pass, so
     * asserting them separately can observe the moment after React reset the
     * form and before the values were restored.
     */
    await waitFor(() => {
      expect(screen.getByLabelText("Service name")).toHaveValue("Spotify");
      expect(screen.getByLabelText("Kind of service")).toHaveValue("entertainment");
    });
  });

  it("shows a calm message when the save itself failed", async () => {
    const user = userEvent.setup();
    setupForm();

    await user.type(screen.getByLabelText("Service name"), "Spotify");
    await user.selectOptions(screen.getByLabelText("Kind of service"), "entertainment");
    await user.click(screen.getByRole("button", { name: "Save service" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/went wrong saving this service/i);
  });
});

describe("validation", () => {
  it("reports a missing service name without contacting the server", async () => {
    const user = userEvent.setup();
    const { action } = setupForm();

    await user.click(screen.getByRole("button", { name: "Save service" }));

    expect(await screen.findByText(/Enter the name of the service/i)).toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });

  it("reports a domain typed with a scheme", async () => {
    const user = userEvent.setup();
    setupForm();

    await user.type(screen.getByLabelText("Service name"), "Spotify");
    await user.selectOptions(screen.getByLabelText("Kind of service"), "entertainment");
    await user.type(screen.getByLabelText("Website (optional)"), "https://spotify.com");
    await user.click(screen.getByRole("button", { name: "Save service" }));

    expect(await screen.findByText(/Enter a domain like example\.com/i)).toBeInTheDocument();
  });

  it("associates each message with its field", async () => {
    const user = userEvent.setup();
    setupForm();

    await user.click(screen.getByRole("button", { name: "Save service" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Service name")).toHaveAttribute("aria-invalid", "true");
    });
    expect(screen.getByLabelText("Service name")).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining("serviceName-error"),
    );
  });
});

describe("accessibility", () => {
  it("has no violations", async () => {
    const { container } = render(
      <AssetCreateForm action={vi.fn(failingAction)} initialState={initialState} />,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
