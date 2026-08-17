import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { FindingResolve, type ResolveState } from "./finding-resolve";

/**
 * ATL-042 — the inline resolution flow.
 *
 * Inside the ATL-041 drawer, never over it: no nested dialog, so there is no
 * second focus trap here and nothing to assert about one. What these cover is
 * the contract the ticket states — an action must be *selected*, it is shown
 * before submission, and a failure never costs the user their choice.
 */

const IDLE: ResolveState = { failure: null, action: null, attempt: 0 };
const TITLE = "Spotify has not been reviewed in over a year";

/** An action that always answers with the given state. */
const answering = (state: ResolveState) =>
  vi.fn(() => Promise.resolve(state)) as unknown as (
    previous: ResolveState,
    formData: FormData,
  ) => Promise<ResolveState>;

function flow(state: ResolveState = IDLE, initial: ResolveState = IDLE, closed = false) {
  return render(
    <FindingResolve
      findingId="11111111-1111-4111-8111-111111111111"
      title={TITLE}
      action={answering(state)}
      initialState={initial}
      closed={closed}
    />,
  );
}

const start = () => screen.getByRole("button", { name: `Resolve: ${TITLE}` });
const confirm = () => screen.getByRole("button", { name: `Confirm resolution: ${TITLE}` });

describe("before the flow is entered", () => {
  it("offers Resolve and nothing else", () => {
    // Idle: no radios, no Confirm. Nothing can be submitted by accident.
    flow();

    expect(start()).toBeEnabled();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm/ })).not.toBeInTheDocument();
  });

  it("offers nothing at all once the finding is closed", () => {
    // §11.1's lifecycle is one-way. An enabled Resolve would promise a
    // transition the service would refuse.
    const { container } = flow(IDLE, IDLE, true);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("choosing an action", () => {
  it("offers the whole closed vocabulary", async () => {
    flow();

    await userEvent.click(start());

    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.getByRole("group", { name: "What did you do?" })).toBeInTheDocument();
  });

  it("cannot be confirmed until something is selected", async () => {
    // ATL-042: the action is *selected*, never defaulted — so nothing is
    // pre-checked and Confirm stays inert.
    flow();

    await userEvent.click(start());

    expect(screen.queryByRole("radio", { checked: true })).not.toBeInTheDocument();
    expect(confirm()).toBeDisabled();
  });

  it("enables Confirm once an action is chosen", async () => {
    flow();

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /closed the account/i }));

    expect(confirm()).toBeEnabled();
  });

  it("shows the selection in words before submission", async () => {
    /**
     * Confirming should be a decision about something stated, not about a radio
     * the user hopes is still checked.
     */
    flow();

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /removed or narrowed a permission/i }));

    expect(screen.getByText(/You are recording: I removed or narrowed a permission/)).toBeVisible();
  });

  it("can be abandoned without resolving anything", async () => {
    flow();

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(start()).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});

describe("when the action fails", () => {
  it.each([
    ["unavailable", "Something went wrong. Nothing was changed — please try again."],
    ["already_closed", "This finding has already been closed. Nothing was changed."],
    ["not_found", "This finding is no longer available. Nothing was changed."],
    ["action_required", "Choose what you did before confirming."],
  ] as const)("announces %s inline", async (failure, message) => {
    flow({ failure, action: "reviewed", attempt: 1 });

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /reviewed the service/i }));
    await userEvent.click(confirm());

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("keeps the selection rather than resetting the form", async () => {
    /**
     * Frontend §19: "preserve form input during recoverable errors". A store
     * outage must not make the user re-decide something they already decided.
     */
    flow({ failure: "unavailable", action: "data_removed", attempt: 1 });

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /removed information/i }));
    await userEvent.click(confirm());
    await screen.findByRole("alert");

    expect(screen.getByRole("radio", { name: /removed information/i })).toBeChecked();
    expect(screen.getByText(/You are recording: I removed information/)).toBeVisible();
  });

  it("leaves the flow open so the user can retry", async () => {
    flow({ failure: "unavailable", action: "reviewed", attempt: 1 });

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /reviewed the service/i }));
    await userEvent.click(confirm());
    await screen.findByRole("alert");

    expect(confirm()).toBeEnabled();
  });

  it("carries no provider detail or error code", async () => {
    // Security §5's neutral-message rule.
    flow({ failure: "unavailable", action: "reviewed", attempt: 1 });

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /reviewed the service/i }));
    await userEvent.click(confirm());

    const text = (await screen.findByRole("alert")).textContent ?? "";
    expect(text).not.toMatch(/UNAVAILABLE|NOT_FOUND|INVALID_REQUEST|supabase|postgres/i);
  });
});

describe("when the resolution succeeds", () => {
  it("says what was recorded", async () => {
    flow({ failure: null, action: "account_closed", resolved: true, attempt: 1 });

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /closed the account/i }));
    await userEvent.click(confirm());

    expect(await screen.findByText(/Recorded as: I closed the account/)).toBeVisible();
  });

  it("offers no way to resolve it a second time", async () => {
    flow({ failure: null, action: "reviewed", resolved: true, attempt: 1 });

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /reviewed the service/i }));
    await userEvent.click(confirm());
    await screen.findByText(/Recorded as/);

    expect(screen.queryByRole("button", { name: /Confirm/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("names every control for the finding it acts on", () => {
    // A screen-reader user moving between findings hears which one each
    // control belongs to, rather than "Resolve, Resolve, Resolve".
    flow();

    expect(start()).toHaveAccessibleName(`Resolve: ${TITLE}`);
  });

  it("is operable by keyboard alone", async () => {
    flow();

    start().focus();
    await userEvent.keyboard("{Enter}");
    // Arrow keys move within a radio group; Radix is not involved here.
    await userEvent.tab();
    await userEvent.keyboard("{ArrowDown}");

    expect(screen.getByRole("radio", { checked: true })).toBeInTheDocument();
    expect(confirm()).toBeEnabled();
  });

  it("has no violations while idle", async () => {
    const { container } = flow();

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations while choosing", async () => {
    const { container } = flow();

    await userEvent.click(start());

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations showing a failure", async () => {
    const { container } = flow({ failure: "unavailable", action: "reviewed", attempt: 1 });

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /reviewed the service/i }));
    await userEvent.click(confirm());
    await screen.findByRole("alert");

    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * No duplicate React keys on the failure path (#87).
 *
 * The fieldset and the inline alert are siblings in one `<form>` and both want
 * remount-per-attempt behaviour. Both used the bare `attempt`, so after the
 * first failure two children carried the key `1` and React warned that children
 * "may be duplicated and/or omitted" — which could have reconciled the radio
 * group into the alert and lost the user's selection on retry.
 *
 * React reports this by *warning*, not throwing, so no existing assertion could
 * catch it. This makes the warning observable instead.
 *
 * The spy **passes the call through**: the warning still prints. Nothing here
 * silences React — the assertion is on what was emitted, not a suppression of
 * it.
 */
describe("React key hygiene", () => {
  it("emits no duplicate-key warning when a failure renders", async () => {
    /**
     * `spyOn` alone records every call **and** keeps the original, so the
     * warning still reaches the console. No `mockImplementation`, so nothing is
     * suppressed and nothing is re-implemented.
     */
    const spy = vi.spyOn(console, "error");
    const emitted = () => spy.mock.calls.map((call) => call.map((part) => String(part)).join(" "));

    try {
      flow({ failure: "unavailable", action: "reviewed", attempt: 1 });

      await userEvent.click(start());
      await userEvent.click(screen.getByRole("radio", { name: /reviewed the service/i }));
      await userEvent.click(confirm());

      // The alert is on screen, so both keyed siblings have rendered together.
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(emitted().filter((message) => /same key/i.test(message))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
