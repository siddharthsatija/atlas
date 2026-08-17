import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import {
  FindingDismiss,
  DISMISSAL_SCORE_NOTE,
  type DismissState,
  type RestoreState,
} from "./finding-dismiss";

/**
 * ATL-043 — dismissal and undo, inline in the ATL-041 drawer.
 *
 * Three contracts the ticket and ADR-004 impose, and they are what these
 * assert: the reason is genuinely optional, the score consequence is stated
 * before the user acts rather than after, and undo is always available on a
 * dismissed finding.
 */

const IDLE_DISMISS: DismissState = { failure: null, reason: null, attempt: 0 };
const IDLE_RESTORE: RestoreState = { failure: null, attempt: 0 };
const TITLE = "Spotify has not been reviewed in over a year";

const answering = <T,>(state: T) =>
  vi.fn(() => Promise.resolve(state)) as unknown as (previous: T, formData: FormData) => Promise<T>;

function flow({
  dismissResult = IDLE_DISMISS,
  restoreResult = IDLE_RESTORE,
  initialDismiss = IDLE_DISMISS,
  status = "open",
}: {
  dismissResult?: DismissState;
  restoreResult?: RestoreState;
  initialDismiss?: DismissState;
  status?: string;
} = {}) {
  return render(
    <FindingDismiss
      findingId="11111111-1111-4111-8111-111111111111"
      title={TITLE}
      dismiss={{ action: answering(dismissResult), initialState: initialDismiss }}
      restore={{ action: answering(restoreResult), initialState: IDLE_RESTORE }}
      status={status}
    />,
  );
}

const start = () => screen.getByRole("button", { name: `Dismiss: ${TITLE}` });
const confirm = () => screen.getByRole("button", { name: `Confirm dismissal: ${TITLE}` });
const restore = () => screen.getByRole("button", { name: `Restore: ${TITLE}` });

describe("before the flow is entered", () => {
  it("offers Dismiss and nothing else", () => {
    flow();

    expect(start()).toBeEnabled();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm/ })).not.toBeInTheDocument();
  });

  it("offers nothing at all on a resolved finding", () => {
    /**
     * Undo here is deliberately not the inverse of resolution: that assertion
     * has already been counted by ADR-004's protective-actions factor, and
     * §11.1's lifecycle is one-way out of `resolved`.
     */
    const { container } = flow({ status: "resolved" });

    expect(container).toBeEmptyDOMElement();
  });
});

describe("the reason is optional", () => {
  it("can be confirmed with nothing selected", async () => {
    // Frontend §5.4: "Dismissal requires an optional reason". Requiring one
    // would make the user justify a decision they may make without a reason.
    flow();

    await userEvent.click(start());

    expect(screen.queryByRole("radio", { checked: true })).not.toBeInTheDocument();
    expect(confirm()).toBeEnabled();
  });

  it("says so in the legend", async () => {
    flow();

    await userEvent.click(start());

    expect(screen.getByRole("group", { name: /optional/i })).toBeInTheDocument();
  });

  it("offers the whole closed vocabulary and nothing more", async () => {
    flow();

    await userEvent.click(start());

    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByRole("radio", { name: /incorrect|wrong/i })).not.toBeInTheDocument();
  });

  it("can be abandoned without dismissing anything", async () => {
    flow();

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(start()).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});

describe("the score consequence", () => {
  it("is stated before the user confirms, not after", async () => {
    /**
     * ADR-004 keeps the full deduction until the condition clears, and the
     * OQ-04 amendment makes that a rule. A user who dismisses expecting their
     * score to improve has been misled by silence.
     */
    flow();

    await userEvent.click(start());

    expect(screen.getByText(DISMISSAL_SCORE_NOTE)).toBeVisible();
  });

  it("promises no improvement anywhere in the flow", async () => {
    flow();

    await userEvent.click(start());

    /**
     * The negative has to exclude the negated form, or it matches the very
     * sentence it is checking for — "does not improve your score" contains
     * "improve your score". What must not appear is an *affirmative* promise.
     */
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/does not improve your privacy score/i);
    expect(text).not.toMatch(/\b(improves|will improve|helps? your|raises?) your/i);
  });
});

describe("when the dismissal fails", () => {
  it.each([
    ["unavailable", "Something went wrong. Nothing was changed — please try again."],
    ["already_closed", "This finding has already been closed. Nothing was changed."],
    ["not_found", "This finding is no longer available. Nothing was changed."],
  ] as const)("announces %s inline", async (failure, message) => {
    flow({ dismissResult: { failure, reason: "accepted_risk", attempt: 1 } });

    await userEvent.click(start());
    await userEvent.click(confirm());

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("keeps the chosen reason rather than resetting the form", async () => {
    // Frontend §19: "preserve form input during recoverable errors".
    flow({ dismissResult: { failure: "unavailable", reason: "not_relevant", attempt: 1 } });

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /not relevant to me/i }));
    await userEvent.click(confirm());
    await screen.findByRole("alert");

    expect(screen.getByRole("radio", { name: /not relevant to me/i })).toBeChecked();
  });

  it("carries no provider detail or error code", async () => {
    flow({ dismissResult: { failure: "unavailable", reason: null, attempt: 1 } });

    await userEvent.click(start());
    await userEvent.click(confirm());

    const text = (await screen.findByRole("alert")).textContent ?? "";
    expect(text).not.toMatch(/UNAVAILABLE|NOT_FOUND|INVALID_REQUEST|supabase|postgres/i);
  });
});

describe("once the finding is dismissed", () => {
  it("offers undo, with no time limit stated or implied", () => {
    flow({ status: "dismissed" });

    expect(restore()).toBeEnabled();
    expect(document.body.textContent).toMatch(/at any time/i);
  });

  it("offers undo immediately after dismissing, without waiting for a reload", async () => {
    // The panel reads its own result as well as the route's data, so the
    // affordance is correct before revalidation comes back.
    flow({
      dismissResult: { failure: null, reason: "accepted_risk", dismissed: true, attempt: 1 },
    });

    await userEvent.click(start());
    await userEvent.click(confirm());

    expect(await screen.findByRole("button", { name: `Restore: ${TITLE}` })).toBeEnabled();
  });

  it("says which reason was recorded", async () => {
    flow({ dismissResult: { failure: null, reason: "not_relevant", dismissed: true, attempt: 1 } });

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("radio", { name: /not relevant to me/i }));
    await userEvent.click(confirm());

    expect(await screen.findByText(/This is not relevant to me/)).toBeVisible();
  });

  it("offers no way to dismiss it twice", () => {
    flow({ status: "dismissed" });

    expect(screen.queryByRole("button", { name: `Dismiss: ${TITLE}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("announces an undo failure without claiming anything changed", async () => {
    flow({ status: "dismissed", restoreResult: { failure: "unavailable", attempt: 1 } });

    await userEvent.click(restore());

    expect(await screen.findByRole("alert")).toHaveTextContent(/Nothing was changed/);
  });

  it("stops offering undo once it has succeeded", async () => {
    flow({ status: "dismissed", restoreResult: { failure: null, restored: true, attempt: 1 } });

    await userEvent.click(restore());

    expect(await screen.findByRole("button", { name: `Dismiss: ${TITLE}` })).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("names every control for the finding it acts on", () => {
    flow();

    expect(start()).toHaveAccessibleName(`Dismiss: ${TITLE}`);
  });

  it("is operable by keyboard alone", async () => {
    flow();

    start().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    await userEvent.keyboard("{ArrowDown}");

    expect(screen.getByRole("radio", { checked: true })).toBeInTheDocument();
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

  it("has no violations offering undo", async () => {
    const { container } = flow({ status: "dismissed" });

    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * Undo returns the panel to rest (task #130).
 *
 * `choosing` is set when the user opens the dismissal form, and before the fix
 * it was cleared only by Cancel. It therefore survived a dismissal — hidden
 * behind the `isDismissed` branch — and reappeared the instant a restore
 * succeeded, dropping the user back into "Why are you dismissing this?"
 * immediately after they had undone exactly that. Reproduced in a browser with
 * one worker: the finding was open, the status badge read `open`, and the
 * dismissal form was on screen.
 *
 * `attempt` matters in these fixtures. The reset is edge-triggered on the
 * counter `restoreFindingAction` increments, so a restore result that reused the
 * initial `attempt` would not fire it — which is exactly what the real action
 * never does.
 */
describe("undoing a dismissal", () => {
  const dismissed: DismissState = { failure: null, reason: null, dismissed: true, attempt: 1 };
  const restored: RestoreState = { failure: null, restored: true, attempt: 1 };

  /** Walks the real sequence: open the form, dismiss, then restore. */
  async function dismissThenRestore(restoreResult: RestoreState = restored) {
    flow({ dismissResult: dismissed, restoreResult });

    await userEvent.click(start());
    await userEvent.click(confirm());
    await userEvent.click(restore());
  }

  it("returns to the Dismiss button rather than the form", async () => {
    await dismissThenRestore();

    expect(start()).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("lets the user dismiss again afterwards", async () => {
    /**
     * The regression the obvious fixes introduce. Deriving `choosing &&
     * !restoreState.restored`, or resetting unconditionally during render,
     * both read correctly once and then never let the form reopen — `restored`
     * stays true for the life of the component. Edge-triggering on `attempt` is
     * what keeps this working.
     */
    await dismissThenRestore();

    await userEvent.click(start());

    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(confirm()).toBeInTheDocument();
  });

  it("leaves the panel alone when the restore fails", async () => {
    /**
     * Only a *successful* restore returns to rest. A failed one has changed
     * nothing, so the undo offer and its error must both stay on screen.
     */
    await dismissThenRestore({ failure: "unavailable", attempt: 1 });

    expect(restore()).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/something went wrong/i);
    expect(screen.queryByRole("button", { name: `Dismiss: ${TITLE}` })).not.toBeInTheDocument();
  });

  it("still lets Cancel abandon the form, unchanged", async () => {
    flow();

    await userEvent.click(start());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(start()).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});

/**
 * No duplicate React keys on the failure path (#87).
 *
 * The fieldset and the inline alert are siblings in one `<form>` and both want
 * remount-per-attempt behaviour. Both used the bare `attempt`, so after the
 * first failure two children carried the key `1` and React warned that children
 * "may be duplicated and/or omitted" — which could have reconciled the radio
 * group into the alert and lost the user's reason on retry.
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
      flow({ dismissResult: { failure: "unavailable", reason: null, attempt: 1 } });

      await userEvent.click(start());
      await userEvent.click(confirm());

      // The alert is on screen, so both keyed siblings have rendered together.
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(emitted().filter((message) => /same key/i.test(message))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
