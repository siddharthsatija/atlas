import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { FindingAssistant } from "./finding-assistant";
import { ASSET_ASSISTANT_COPY, FEEDBACK_COPY } from "@/lib/ai/assistant-copy";
import type { AiFeedbackState, AssistantState, ExplanationView } from "@/lib/ai/explanation-view";

/**
 * ATL-053 M2 — the finding assistant panel.
 *
 * Four contracts the ticket and AI behavior impose, and they are what these
 * assert: the conversation never outlives the component, model confidence appears
 * on an AI answer and can never appear on a deterministic one, every answer
 * discloses what was sent, and Cancel changes this component and nothing else.
 */

const FINDING = "22222222-2222-4222-8222-222222222222";
const TITLE = "An old account still holds your address";
const RECORD = "33333333-3333-4333-8333-333333333333";

const aiExplanation: ExplanationView = {
  source: "ai",
  summary: "This account still holds your address.",
  whyItMatters: "Dormant accounts are a common breach source.",
  confidence: "medium",
  uncertainties: ["Atlas cannot see whether the account is still active."],
  sources: [{ id: RECORD, label: "Old shopping account", href: "/assets/a" }],
  actions: [{ label: "Open the asset", actionType: "open_asset", entityId: RECORD }],
  disclosure: { classification: "metadata", recordCount: 1 },
  interactionId: "interaction-1",
};

const fallbackExplanation: ExplanationView = {
  source: "fallback",
  notice: "The assistant is temporarily unavailable, so Atlas wrote this.",
  summary: "An old account still holds your address.",
  whyItMatters: "Based on the information saved in Atlas, this is worth reviewing.",
  recommendedAction: "Close the account or remove the address.",
  sources: [{ id: RECORD, label: "Old shopping account", href: null }],
  actions: [],
  disclosures: ["This finding is based on demo data."],
  disclosure: { classification: "metadata", recordCount: 1 },
};

const answered = (explanation: ExplanationView): AssistantState => ({
  status: "answered",
  explanation,
});

function panel({
  result = answered(aiExplanation),
  request,
  submitFeedback,
}: {
  result?: AssistantState;
  request?: (subjectId: string) => Promise<AssistantState>;
  submitFeedback?: (
    interactionId: string,
    helpful: boolean,
    category?: string,
  ) => Promise<AiFeedbackState>;
} = {}) {
  const ask = request ?? vi.fn(() => Promise.resolve(result));

  const view = render(
    <FindingAssistant
      subjectId={FINDING}
      title={TITLE}
      request={ask}
      {...(submitFeedback ? { submitFeedback } : {})}
    />,
  );

  return { ...view, ask };
}

/** Asks and waits for the answer to land, which every read-path test needs. */
async function ask(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /ask atlas/i }));
}

describe("asking", () => {
  it("asks about the finding it was given", async () => {
    const user = userEvent.setup();
    const { ask: explain } = panel();

    await ask(user);

    await waitFor(() => expect(explain).toHaveBeenCalledWith(FINDING));
  });

  it("says what will be sent before the user asks", () => {
    panel();

    /** §11: the user should know the scope before deciding, not after. */
    expect(screen.getByText(/only the records shown here/i)).toBeInTheDocument();
  });

  it("shows a pending state with a way out", async () => {
    const user = userEvent.setup();
    /** Never resolves, so the pending state is observable. */
    panel({ request: () => new Promise<AssistantState>(() => {}) });

    await ask(user);

    expect(await screen.findByRole("status")).toHaveTextContent(/looking at this finding/i);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });
});

/**
 * M4 — what a screen reader hears, and what Cancel actually does.
 *
 * The announcer is one always-mounted region rather than a `role="status"` per
 * branch. A region that mounts alongside its text is announced unreliably, so
 * the region stays and the text changes.
 */
describe("announcements", () => {
  /**
   * Found by role rather than by `data-slot`: the announcer *is* the panel's
   * status region, so `role="status"` is what a screen reader uses to find it
   * and what this should assert on. Reaching for the DOM attribute would test
   * the markup instead of the behaviour.
   */
  const announcer = () => screen.getByRole("status");

  it("is present before anything happens, so later changes are heard", () => {
    panel();

    /**
     * The whole point. If this element only appeared with the pending state,
     * several screen readers would never announce its first message — they watch
     * regions that were already in the tree.
     */
    expect(announcer()).toBeInTheDocument();
    expect(announcer()).toHaveTextContent("");
  });

  it("announces the wait", async () => {
    const user = userEvent.setup();
    panel({ request: () => new Promise<AssistantState>(() => {}) });

    await ask(user);

    expect(announcer()).toHaveTextContent(/looking at this finding/i);
  });

  it("announces that an answer arrived", async () => {
    const user = userEvent.setup();
    panel();

    await ask(user);
    await screen.findByText(aiExplanation.summary);

    /** The transition a sighted user sees, said out loud for one who cannot. */
    expect(announcer()).toHaveTextContent(/finished explaining/i);
  });

  it("stays silent for refusals, which announce themselves", async () => {
    const user = userEvent.setup();
    panel({ result: { status: "consent_required" } });

    await ask(user);
    await screen.findByRole("alert");

    /**
     * Each refusal renders a visible `role="alert"`, which is announced on
     * appearance. Repeating it here would say the same sentence twice.
     */
    expect(announcer()).toHaveTextContent("");
  });
});

describe("cancelling is keyboard-reachable", () => {
  it("can be reached by Tab and activated by Enter", async () => {
    const user = userEvent.setup();
    panel({ request: () => new Promise<AssistantState>(() => {}) });

    await ask(user);
    await screen.findByRole("button", { name: /cancel/i });

    /**
     * Cancel is the only way out of a wait, so it cannot be mouse-only. A real
     * `<button>` gets this from the platform; asserted so a later refactor to a
     * clickable `div` fails here rather than in someone's hands.
     */
    await user.tab();
    expect(screen.getByRole("button", { name: /cancel/i })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /ask atlas/i })).toBeInTheDocument();
  });
});

describe("an AI answer", () => {
  it("renders the model's confidence", async () => {
    const user = userEvent.setup();
    panel();

    await ask(user);

    expect(await screen.findByText(/medium confidence/i)).toBeInTheDocument();
  });

  it("names it as confidence in the explanation, not in the finding", async () => {
    const user = userEvent.setup();
    panel();

    await ask(user);

    /**
     * The finding's own rule confidence sits a few centimetres above this in the
     * drawer. The wording has to make clear which quantity is which, or the two
     * read as one measurement stated twice.
     */
    expect(await screen.findByText(/confident in this explanation/i)).toBeInTheDocument();
  });

  it("lists what it is unsure about", async () => {
    const user = userEvent.setup();
    panel();

    expect(await screen.findByRole("button", { name: /ask atlas/i })).toBeInTheDocument();
    await ask(user);

    expect(
      await screen.findByText(/cannot see whether the account is still active/i),
    ).toBeInTheDocument();
  });

  it("renders suggested steps as text, never as controls", async () => {
    const user = userEvent.setup();
    panel();

    await ask(user);
    await screen.findByText("Open the asset");

    /**
     * "AI can propose but cannot execute." A button here would be the assistant
     * acting — it chose both the action and its target — even with a user click
     * in between.
     */
    expect(screen.queryByRole("button", { name: /open the asset/i })).not.toBeInTheDocument();
    expect(screen.getByText(/never carries them out for you/i)).toBeInTheDocument();
  });

  it("links each cited record so the user can check it", async () => {
    const user = userEvent.setup();
    panel();

    await ask(user);

    expect(await screen.findByRole("link", { name: "Old shopping account" })).toHaveAttribute(
      "href",
      "/assets/a",
    );
  });
});

describe("a deterministic answer", () => {
  it("shows no confidence of any kind", async () => {
    const user = userEvent.setup();
    panel({ result: answered(fallbackExplanation) });

    await ask(user);
    await screen.findByText(/temporarily unavailable/i);

    /**
     * The type already forbids it — `FallbackExplanationView` has no `confidence`
     * field, so the renderer could not read one. Asserted anyway because a later
     * widening of the variant would pass tsc and fail here.
     */
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/confident in this explanation/i)).not.toBeInTheDocument();
  });

  it("says who wrote it", async () => {
    const user = userEvent.setup();
    panel({ result: answered(fallbackExplanation) });

    await ask(user);

    expect(await screen.findByText(/temporarily unavailable/i)).toBeInTheDocument();
  });

  it("carries the demo disclosure", async () => {
    const user = userEvent.setup();
    panel({ result: answered(fallbackExplanation) });

    await ask(user);

    expect(await screen.findByText(/based on demo data/i)).toBeInTheDocument();
  });

  it("renders the rule's recommendation as prose", async () => {
    const user = userEvent.setup();
    panel({ result: answered(fallbackExplanation) });

    await ask(user);

    expect(await screen.findByText(/close the account or remove the address/i)).toBeInTheDocument();
  });

  it("shows an unlinked record as plain text rather than a dead link", async () => {
    const user = userEvent.setup();
    panel({ result: answered(fallbackExplanation) });

    await ask(user);
    await screen.findByText("Old shopping account");

    expect(screen.queryByRole("link", { name: "Old shopping account" })).not.toBeInTheDocument();
  });
});

describe("the context disclosure", () => {
  it.each([
    ["metadata", /no personal field values/i],
    ["personal", /personal field values you approved/i],
    ["none", /without sending any of your records/i],
  ] as const)("states what was sent for %s", async (classification, wording) => {
    const user = userEvent.setup();
    panel({
      result: answered({
        ...aiExplanation,
        disclosure: { classification, recordCount: 1 },
      }),
    });

    await ask(user);

    expect(await screen.findByText(wording)).toBeInTheDocument();
  });

  it("appears on a deterministic answer too", async () => {
    const user = userEvent.setup();
    panel({ result: answered(fallbackExplanation) });

    await ask(user);

    expect(await screen.findByText(/no personal field values/i)).toBeInTheDocument();
  });
});

describe("clearing", () => {
  it("removes the answer from the view", async () => {
    const user = userEvent.setup();
    panel();

    await ask(user);
    await screen.findByText(aiExplanation.summary);

    await user.click(screen.getByRole("button", { name: /^clear$/i }));

    expect(screen.queryByText(aiExplanation.summary)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask atlas/i })).toBeInTheDocument();
  });

  it("clears local state only — nothing is sent to the server", async () => {
    const user = userEvent.setup();
    const { ask: explain } = panel();

    await ask(user);
    await screen.findByText(aiExplanation.summary);
    await user.click(screen.getByRole("button", { name: /^clear$/i }));

    /**
     * The conversation only ever lived here, so clearing it is a local operation
     * by construction. One call — the original ask — and no second request.
     */
    expect(explain).toHaveBeenCalledTimes(1);
  });

  /*
    There is deliberately no "nothing is written to browser storage" assertion
    here. `src/test/repo-guards.test.ts` already forbids `localStorage` and
    `sessionStorage` anywhere under `src/`, which is a stronger and repo-wide
    guarantee than a check on one component's behaviour during one test — and
    naming the APIs here, even to assert their absence, is what the guard exists
    to catch. The weaker local restatement was removed rather than the guard
    being widened to permit it.
  */
});

describe("cancelling", () => {
  it("returns the panel to idle without waiting for the server", async () => {
    const user = userEvent.setup();
    panel({ request: () => new Promise<AssistantState>(() => {}) });

    await ask(user);
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.getByRole("button", { name: /ask atlas/i })).toBeInTheDocument();
  });

  it("says the request may still finish, because it may", async () => {
    const user = userEvent.setup();
    panel({ request: () => new Promise<AssistantState>(() => {}) });

    await ask(user);
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    /**
     * No `AbortSignal` exists anywhere on this path — the server request runs to
     * completion and records normally. Copy claiming the work stopped would be
     * untrue, and this asserts the honest wording is what ships.
     */
    /**
     * Two matches, on purpose: once visibly, and once in the sr-only announcer
     * that makes it audible — a plain paragraph appearing is not announced on
     * its own. `getByText` would fail on the ambiguity, so both are asserted.
     */
    expect(screen.getAllByText(/may still finish this request/i)).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent(/may still finish this request/i);
  });
});

describe("feedback", () => {
  it("sends only the thumb and a closed-vocabulary category", async () => {
    const user = userEvent.setup();
    const submitFeedback = vi.fn(() => Promise.resolve<AiFeedbackState>({ status: "recorded" }));
    panel({ submitFeedback });

    await ask(user);
    await screen.findByRole("button", { name: FEEDBACK_COPY.no });

    await user.selectOptions(screen.getByRole("combobox"), "too_vague");
    await user.click(screen.getByRole("button", { name: FEEDBACK_COPY.no }));

    await waitFor(() =>
      expect(submitFeedback).toHaveBeenCalledWith("interaction-1", false, "too_vague"),
    );
  });

  it("offers no free-text box at all", async () => {
    const user = userEvent.setup();
    panel({ submitFeedback: vi.fn(() => Promise.resolve<AiFeedbackState>({ status: "idle" })) });

    await ask(user);
    await screen.findByRole("button", { name: FEEDBACK_COPY.yes });

    /** No column exists for one, and free text is where personal data leaks in. */
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("is not offered when no interaction was recorded", async () => {
    const user = userEvent.setup();
    /** Destructured away rather than set to undefined: the field must be absent. */
    const { interactionId: _omitted, ...withoutId } = aiExplanation;
    panel({
      result: answered(withoutId),
      submitFeedback: vi.fn(() => Promise.resolve<AiFeedbackState>({ status: "idle" })),
    });

    await ask(user);
    await screen.findByText(aiExplanation.summary);

    /** Nothing to attach it to; a control that discarded the click would be worse. */
    expect(screen.queryByRole("button", { name: FEEDBACK_COPY.yes })).not.toBeInTheDocument();
  });

  it("reports a failure without losing the answer", async () => {
    const user = userEvent.setup();
    panel({
      submitFeedback: vi.fn(() => Promise.resolve<AiFeedbackState>({ status: "unavailable" })),
    });

    await ask(user);
    await user.click(await screen.findByRole("button", { name: FEEDBACK_COPY.yes }));

    expect(await screen.findByRole("alert")).toHaveTextContent(FEEDBACK_COPY.unavailable);
    expect(screen.getByText(aiExplanation.summary)).toBeInTheDocument();
  });
});

describe("the states that are not answers", () => {
  it("explains consent without offering a retry that cannot help", async () => {
    const user = userEvent.setup();
    panel({ result: { status: "consent_required" } });

    await ask(user);

    /**
     * Wording changed in M4. It previously ended "You can turn it on in
     * Settings", which named a control that does not exist: consent is captured
     * once during onboarding and `/settings` is still the ATL-005 placeholder.
     * Retrying cannot help either, so no button is offered.
     */
    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(/does not have your permission/i);
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("promises no consent control that the product does not have", async () => {
    const user = userEvent.setup();
    const { container } = panel({ result: { status: "consent_required" } });

    await ask(user);
    await screen.findByRole("alert");

    /**
     * Until ATL-074–077 build the privacy controls, sending a user to Settings
     * to grant AI consent sends them somewhere with no such control — which
     * reads as a broken product rather than a missing feature.
     */
    expect(container.textContent ?? "").not.toMatch(/settings/i);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says nothing about this finding was sent, because nothing was", async () => {
    const user = userEvent.setup();
    panel({ result: { status: "consent_required" } });

    await ask(user);

    /**
     * ATL-049 checks consent *before retrieval*, so the refusal path never reads
     * the user's records. That is the most useful thing this state can say, and
     * it is true rather than reassuring-sounding.
     */
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /nothing about this finding was sent/i,
    );
  });

  it("marks each refusal distinctly without exposing an internal code", async () => {
    const user = userEvent.setup();
    panel({ result: { status: "consent_required" } });

    await ask(user);

    /** The panel's own vocabulary — not the policy layer's, not a provider's. */
    expect(await screen.findByRole("alert")).toHaveAttribute("data-refusal", "consent_required");
  });

  it("offers a retry when retrying could work", async () => {
    const user = userEvent.setup();
    panel({ result: { status: "unavailable" } });

    await ask(user);

    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("states a missing finding plainly", async () => {
    const user = userEvent.setup();
    panel({ result: { status: "not_found" } });

    await ask(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer available/i);
  });

  it("names no provider and no error code in any state", async () => {
    const user = userEvent.setup();
    const { container } = panel({ result: { status: "unavailable" } });

    await ask(user);
    await screen.findByRole("alert");

    const rendered = container.textContent ?? "";

    expect(rendered).not.toMatch(/anthropic|claude|sonnet|rate.?limit|overloaded|token/i);
    expect(rendered).not.toMatch(/UNAVAILABLE|NOT_FOUND|API_ERROR/);
  });
});

describe("accessibility", () => {
  it("has no axe violations with an AI answer on screen", async () => {
    const user = userEvent.setup();
    const { container } = panel({
      submitFeedback: vi.fn(() => Promise.resolve<AiFeedbackState>({ status: "idle" })),
    });

    await ask(user);
    await screen.findByText(aiExplanation.summary);

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations with a deterministic answer on screen", async () => {
    const user = userEvent.setup();
    const { container } = panel({ result: answered(fallbackExplanation) });

    await ask(user);
    await screen.findByText(/temporarily unavailable/i);

    expect(await axe(container)).toHaveNoViolations();
  });

  it("announces the pending state to a screen reader", async () => {
    const user = userEvent.setup();
    panel({ request: () => new Promise<AssistantState>(() => {}) });

    await ask(user);

    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("has no axe violations while waiting, with Cancel on screen", async () => {
    const user = userEvent.setup();
    const { container } = panel({ request: () => new Promise<AssistantState>(() => {}) });

    await ask(user);
    await screen.findByRole("button", { name: /cancel/i });

    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations on a refusal", async () => {
    const user = userEvent.setup();
    const { container } = panel({ result: { status: "consent_required" } });

    await ask(user);
    await screen.findByRole("alert");

    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * ATL-054 M3 — the same panel on an asset page.
 *
 * The component is reused rather than wrapped, so what these protect is that
 * reuse did not quietly carry finding semantics onto a surface that has none.
 * Two things could go wrong and both are silent: the panel could talk about
 * "this finding" while a user looks at a service, and it could show a model
 * confidence that the asset-summary contract never produced.
 */

const ASSET = "44444444-4444-4444-8444-444444444444";
const ASSET_TITLE = "Beta Bank";
const ASSET_RECORD = "55555555-5555-4555-8555-555555555555";

const assetSummary: ExplanationView = {
  source: "asset_summary",
  summary: "Beta Bank is recorded as holding financial data.",
  uncertainties: ["Atlas cannot see when this was last confirmed."],
  sources: [{ id: ASSET_RECORD, label: "Financial", href: "/assets/beta/edit" }],
  disclosure: { classification: "metadata", recordCount: 2, subjectName: ASSET_TITLE },
};

function assetPanel(result: AssistantState = answered(assetSummary)) {
  return render(
    <FindingAssistant
      subjectId={ASSET}
      title={ASSET_TITLE}
      request={vi.fn(() => Promise.resolve(result))}
      copy={ASSET_ASSISTANT_COPY}
    />,
  );
}

describe("the same panel, asked about a service", () => {
  const openAsset = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: new RegExp(ASSET_TITLE) }));
    await screen.findByText(assetSummary.summary);
  };

  it("says nothing about findings in any state a user can reach", async () => {
    const user = userEvent.setup();
    assetPanel();

    /** Idle first: the hint is the sentence a user reads before deciding. */
    expect(document.body.textContent).not.toMatch(/finding/i);

    await openAsset(user);

    /**
     * Asserted over the whole rendered panel rather than one string. The failure
     * this catches is a *missed* substitution, and checking only the strings
     * someone remembered to change would miss exactly the one they forgot.
     */
    expect(document.body.textContent).not.toMatch(/finding/i);
  });

  it("names the service in the context disclosure", async () => {
    const user = userEvent.setup();
    assetPanel();

    await openAsset(user);

    /**
     * §11's claim on this surface is a negative one — only this service was read
     * — and a user cannot check it unless the sentence says which service. The
     * whole sentence is asserted, because that is what is read aloud.
     */
    expect(
      screen.getByText(new RegExp(`only ${ASSET_TITLE} and its own records were read`, "i")),
    ).toBeVisible();
  });

  it("shows no confidence, because a summary has none to show", async () => {
    const user = userEvent.setup();
    assetPanel();

    await openAsset(user);

    /**
     * Not a styling choice. `AssetSummaryView` has no `confidence` field, so
     * `AssetSummaryAnswer` could not render one if it tried — this asserts the
     * type-level guarantee reached what the user actually sees.
     */
    expect(document.body.textContent).not.toMatch(/confiden/i);
  });

  it("renders the summary variant, not an explanation", async () => {
    const user = userEvent.setup();
    assetPanel();

    await openAsset(user);

    /**
     * "Why it matters" is the discriminator, and deliberately so: **both** answer
     * renderers always emit that heading, because both of their variants require
     * `whyItMatters`. Its absence is therefore positive evidence that a third
     * renderer ran — expressed in what a user sees rather than in a slot
     * attribute, so it stays true if the markup changes.
     */
    expect(screen.queryByText(ASSET_ASSISTANT_COPY.whyHeading)).toBeNull();
    expect(screen.getByText(ASSET_ASSISTANT_COPY.summaryHeading)).toBeVisible();
  });

  it("proposes no actions, because the contract has none", async () => {
    const user = userEvent.setup();
    assetPanel();

    await openAsset(user);

    expect(screen.queryByText(ASSET_ASSISTANT_COPY.actionsHeading)).toBeNull();
    expect(screen.queryByText(ASSET_ASSISTANT_COPY.proposalNote)).toBeNull();
  });

  it("still shows the records it used", async () => {
    const user = userEvent.setup();
    assetPanel();

    await openAsset(user);

    /** Grounding survives the variant change: every answer cites its sources. */
    expect(screen.getByRole("link", { name: "Financial" })).toHaveAttribute(
      "href",
      "/assets/beta/edit",
    );
  });

  it("opens from the keyboard alone", async () => {
    const user = userEvent.setup();
    assetPanel();

    await user.tab();
    expect(screen.getByRole("button", { name: new RegExp(ASSET_TITLE) })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(await screen.findByText(assetSummary.summary)).toBeVisible();
  });

  it("refuses in the service's words, not the finding's", async () => {
    const user = userEvent.setup();
    assetPanel({ status: "not_found" });

    await user.click(screen.getByRole("button", { name: new RegExp(ASSET_TITLE) }));

    const problem = await screen.findByRole("alert");
    expect(problem).toHaveAttribute("data-refusal", "not_found");
    expect(problem).toHaveTextContent(/service/i);
  });

  it("has no accessibility violations once answered", async () => {
    const user = userEvent.setup();
    const { container } = assetPanel();

    await openAsset(user);

    expect(await axe(container)).toHaveNoViolations();
  });
});
