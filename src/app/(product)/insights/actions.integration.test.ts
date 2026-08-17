import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Insights Server Actions at their own boundary — `resolveFindingAction`
 * (ATL-042), `dismissFindingAction` and `restoreFindingAction` (ATL-043).
 *
 * The flow is already covered from both sides: `finding-resolve.test.tsx` proves
 * what the user sees, and `finding-service.integration.test.ts` proves what is
 * written. Neither exercises the action itself, which is where three decisions
 * actually live — validating the submitted action before the service is called,
 * mapping a service code to a failure the user can read, and revalidating the
 * route only when something changed.
 *
 * A Server Action is an independently invocable POST, so the untrusted input
 * here is genuinely untrusted: `formData` is asserted to arrive with anything,
 * including nothing.
 *
 * `FindingService` is faked at the module boundary, deliberately. What this file
 * asserts is the action's own behaviour — that it calls the service with the
 * verified user's id and translates the answer — not the service's, which has
 * its own suite.
 */

const resolveFinding = vi.fn();
const dismissFinding = vi.fn();
const undismissFinding = vi.fn();
const revalidatePath = vi.fn();
/**
 * Typed, unlike the other two: its return value is *used* by the module under
 * test, so an untyped `vi.fn()` would hand the action an `any` and quietly
 * disable the type checking that proves the user id comes from the session.
 */
const requireVerifiedUser = vi.fn<() => Promise<{ id: string }>>();

const USER = "11111111-1111-4111-8111-111111111111";
const FINDING = "22222222-2222-4222-8222-222222222222";

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/server/auth/require-user", () => ({
  requireVerifiedUser: () => requireVerifiedUser(),
}));

vi.mock("@/server/findings/finding-service", () => ({
  FindingService: {
    create: () => ({ resolveFinding, dismissFinding, undismissFinding, getFindingDetail }),
  },
}));

/**
 * ATL-053's dependencies, added to this file rather than a new one so the whole
 * action module keeps a single boundary suite.
 *
 * The service-role client is stubbed because ATL-053 imports it at module scope,
 * and evaluating it would pull in the validated env module — an environment
 * requirement this suite has never had and should not acquire.
 *
 * The policy layer and the interaction repository are faked at their module
 * boundaries for the same reason the finding service is: both have their own
 * suites, and what is asserted here is the *action's* behaviour. The presenter is
 * deliberately **not** faked — it is the thing under test on the read path.
 */
const getFindingDetail = vi.fn();
const answer = vi.fn();
const recordFeedback = vi.fn();

vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

vi.mock("@/server/ai/composition", () => ({ createAiPolicyService: () => ({ answer }) }));

vi.mock("@/server/repositories/ai-interaction-repository", () => ({
  AiInteractionRepository: class {
    recordFeedback = recordFeedback;
  },
}));

const {
  resolveFindingAction,
  dismissFindingAction,
  restoreFindingAction,
  explainFindingAction,
  submitAiFeedbackAction,
} = await import("./actions");
const { INITIAL_RESOLVE_STATE, INITIAL_DISMISS_STATE, INITIAL_RESTORE_STATE } =
  await import("./form-state");

type State = typeof INITIAL_RESOLVE_STATE;
type DismissState = typeof INITIAL_DISMISS_STATE;
type RestoreState = typeof INITIAL_RESTORE_STATE;

function formData(entries: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

/** Submits with a valid finding id, so only the action field varies. */
const submit = (entries: Record<string, string | File>, previous: State = INITIAL_RESOLVE_STATE) =>
  resolveFindingAction(previous, formData({ findingId: FINDING, ...entries }));

/** ATL-043's two actions, submitted the same way. */
const submitDismiss = (
  entries: Record<string, string | File>,
  previous: DismissState = INITIAL_DISMISS_STATE,
) => dismissFindingAction(previous, formData({ findingId: FINDING, ...entries }));

const submitRestore = (previous: RestoreState = INITIAL_RESTORE_STATE) =>
  restoreFindingAction(previous, formData({ findingId: FINDING }));

beforeEach(() => {
  resolveFinding.mockReset();
  dismissFinding.mockReset();
  undismissFinding.mockReset();
  revalidatePath.mockReset();
  requireVerifiedUser.mockReset();
  getFindingDetail.mockReset();
  answer.mockReset();
  recordFeedback.mockReset();

  requireVerifiedUser.mockResolvedValue({ id: USER });
  resolveFinding.mockResolvedValue({ ok: true, data: { id: FINDING, status: "resolved" } });
  dismissFinding.mockResolvedValue({ ok: true, data: { id: FINDING, status: "dismissed" } });
  undismissFinding.mockResolvedValue({ ok: true, data: { id: FINDING, status: "open" } });
});

describe("the action is validated at the boundary", () => {
  it("rejects a missing action without calling the service", async () => {
    /**
     * ATL-042: "resolution requires selecting or confirming the action taken".
     * The control disables Confirm until something is chosen, but a Server
     * Action can be posted directly — so the requirement is enforced here, not
     * in the component.
     */
    const state = await submit({});

    expect(state.failure).toBe("action_required");
    expect(resolveFinding).not.toHaveBeenCalled();
  });

  it("rejects an action outside the closed vocabulary", async () => {
    // The database's check constraint would also refuse it. That is the second
    // gate; sending a value the application knows is invalid is not a design.
    const state = await submit({ action: "shrugged" });

    expect(state.failure).toBe("action_required");
    expect(resolveFinding).not.toHaveBeenCalled();
  });

  it("rejects a non-string field", async () => {
    // A `File` is not a string. Reaching the service with `[object File]`
    // stringified into the column is the failure this prevents.
    const state = await submit({ action: new File(["x"], "action.txt") });

    expect(state.failure).toBe("action_required");
    expect(resolveFinding).not.toHaveBeenCalled();
  });

  it.each(["reviewed", "permission_revoked", "data_removed", "account_closed", "other"] as const)(
    "passes %s through to the service",
    async (action) => {
      await submit({ action });

      expect(resolveFinding).toHaveBeenCalledWith(USER, FINDING, action);
    },
  );

  it("takes the user id from the session and never from the form", async () => {
    // CLAUDE.md: never trust a client-provided user id. A form field claiming
    // one must have no effect whatsoever.
    await submit({ action: "reviewed", userId: "33333333-3333-4333-8333-333333333333" });

    expect(resolveFinding).toHaveBeenCalledWith(USER, FINDING, "reviewed");
  });
});

describe("a service failure is surfaced", () => {
  it.each([
    ["NOT_FOUND", "not_found"],
    ["INVALID_REQUEST", "already_closed"],
    ["UNAVAILABLE", "unavailable"],
  ] as const)("maps %s to %s", async (code, failure) => {
    resolveFinding.mockResolvedValue({ ok: false, code });

    const state = await submit({ action: "reviewed" });

    expect(state.failure).toBe(failure);
    expect(state.resolved).toBeUndefined();
  });

  it("maps an unrecognised code to the neutral failure rather than succeeding", async () => {
    /**
     * ATL-112's lesson: an action that cannot classify a result must not fall
     * through to success. A user told their finding was resolved when it was
     * not is the worst outcome available here.
     */
    resolveFinding.mockResolvedValue({ ok: false, code: "FORBIDDEN" });

    const state = await submit({ action: "reviewed" });

    expect(state.failure).toBe("unavailable");
    expect(state.resolved).toBeUndefined();
  });

  it("carries no provider detail or error code into the state", async () => {
    // Security §5: the surface says what happened, never how the store said it.
    resolveFinding.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const state = await submit({ action: "reviewed" });

    expect(JSON.stringify(state)).not.toMatch(/UNAVAILABLE|NOT_FOUND|INVALID_REQUEST/);
  });
});

describe("the selection survives every failure", () => {
  it("returns the action the user just chose when the service fails", async () => {
    // Frontend §19: "preserve form input during recoverable errors".
    resolveFinding.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const state = await submit({ action: "account_closed" });

    expect(state.action).toBe("account_closed");
  });

  it("keeps the previous selection when the submitted one is unusable", async () => {
    /**
     * A stale or tampered submission should not erase what the user had already
     * decided — the panel re-renders from this state, and blanking it would
     * silently discard their choice.
     */
    const previous: State = { failure: null, action: "data_removed", attempt: 3 };

    const state = await submit({ action: "" }, previous);

    expect(state.failure).toBe("action_required");
    expect(state.action).toBe("data_removed");
  });

  it("advances the attempt counter on every outcome", async () => {
    /**
     * The live region is read when its content *changes*, so a repeated
     * identical failure needs a changing key to be announced twice.
     */
    resolveFinding.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });
    const first = await submit({ action: "reviewed" });
    const second = await submit({ action: "reviewed" }, first);

    resolveFinding.mockResolvedValue({ ok: true, data: { id: FINDING } });
    const third = await submit({ action: "reviewed" }, second);

    expect([first.attempt, second.attempt, third.attempt]).toEqual([1, 2, 3]);
  });
});

describe("revalidation follows the write, not the attempt", () => {
  it("revalidates the insights route on success", async () => {
    // A resolved finding leaves the Recommended view and enters Resolved, so a
    // cached tree would show the user a finding they just closed.
    await submit({ action: "reviewed" });

    expect(revalidatePath).toHaveBeenCalledWith("/insights");
  });

  it("does not revalidate when the action was rejected at the boundary", async () => {
    await submit({ action: "shrugged" });

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["NOT_FOUND", "INVALID_REQUEST", "UNAVAILABLE"] as const)(
    "does not revalidate after %s",
    async (code) => {
      resolveFinding.mockResolvedValue({ ok: false, code });

      await submit({ action: "reviewed" });

      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("reports the resolution only once the service confirmed it", async () => {
    const state = await submit({ action: "reviewed" });

    expect(state).toMatchObject({ failure: null, action: "reviewed", resolved: true });
  });
});

describe("dismissing: the reason is optional (ATL-043)", () => {
  it("dismisses with no reason at all", async () => {
    /**
     * Frontend §5.4 makes the reason optional, which is the structural
     * difference from resolve: an absent reason is a valid submission, not a
     * validation failure.
     */
    const state = await submitDismiss({});

    expect(state).toMatchObject({ failure: null, reason: null, dismissed: true });
    expect(dismissFinding).toHaveBeenCalledWith(USER, FINDING, undefined);
  });

  it.each(["not_relevant", "accepted_risk"] as const)("passes %s through", async (reason) => {
    await submitDismiss({ reason });

    expect(dismissFinding).toHaveBeenCalledWith(USER, FINDING, reason);
  });

  it("drops an unknown reason but still dismisses", async () => {
    /**
     * Dismissal is the user's decision either way. Refusing it over a reason
     * they did not have to give would fail on the wrong thing — so the value is
     * dropped and the action proceeds without it.
     */
    const state = await submitDismiss({ reason: "shrugged" });

    expect(dismissFinding).toHaveBeenCalledWith(USER, FINDING, undefined);
    expect(state.dismissed).toBe(true);
    expect(state.reason).toBeNull();
  });

  it("refuses to treat `incorrect` as a reason", async () => {
    // OQ-04: a disputed finding is answered by correcting the record. Accepting
    // it here would let someone declare the finding wrong while the data stood.
    await submitDismiss({ reason: "incorrect" });

    expect(dismissFinding).toHaveBeenCalledWith(USER, FINDING, undefined);
  });

  it("takes the user id from the session, never the form", async () => {
    await submitDismiss({ reason: "not_relevant", userId: "33333333-3333-4333-8333-333333333333" });

    expect(dismissFinding).toHaveBeenCalledWith(USER, FINDING, "not_relevant");
  });

  it.each([
    ["NOT_FOUND", "not_found"],
    ["INVALID_REQUEST", "already_closed"],
    ["UNAVAILABLE", "unavailable"],
    ["FORBIDDEN", "unavailable"],
  ] as const)("maps %s to %s", async (code, failure) => {
    dismissFinding.mockResolvedValue({ ok: false, code });

    const state = await submitDismiss({ reason: "accepted_risk" });

    expect(state.failure).toBe(failure);
    expect(state.dismissed).toBeUndefined();
  });

  it("keeps the reason across a failure", async () => {
    dismissFinding.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const state = await submitDismiss({ reason: "accepted_risk" });

    expect(state.reason).toBe("accepted_risk");
  });

  it("revalidates only on success", async () => {
    dismissFinding.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });
    await submitDismiss({ reason: "not_relevant" });
    expect(revalidatePath).not.toHaveBeenCalled();

    dismissFinding.mockResolvedValue({ ok: true, data: { id: FINDING } });
    await submitDismiss({ reason: "not_relevant" });
    expect(revalidatePath).toHaveBeenCalledWith("/insights");
  });
});

describe("undo (ATL-043)", () => {
  it("restores through the service, with the session's user", async () => {
    const state = await submitRestore();

    expect(undismissFinding).toHaveBeenCalledWith(USER, FINDING);
    expect(state).toMatchObject({ failure: null, restored: true });
  });

  it("reads no reason", async () => {
    // Undo is a single decision with nothing to qualify; the original
    // dismissal's reason stays on the timeline where it was written.
    await restoreFindingAction(
      INITIAL_RESTORE_STATE,
      formData({ findingId: FINDING, reason: "accepted_risk" }),
    );

    expect(undismissFinding).toHaveBeenCalledWith(USER, FINDING);
  });

  it.each([
    ["NOT_FOUND", "not_found"],
    ["INVALID_REQUEST", "already_closed"],
    ["UNAVAILABLE", "unavailable"],
    ["FORBIDDEN", "unavailable"],
  ] as const)("maps %s to %s", async (code, failure) => {
    undismissFinding.mockResolvedValue({ ok: false, code });

    const state = await submitRestore();

    expect(state.failure).toBe(failure);
    expect(state.restored).toBeUndefined();
  });

  it("does not revalidate a restore that did not happen", async () => {
    undismissFinding.mockResolvedValue({ ok: false, code: "INVALID_REQUEST" });

    await submitRestore();

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("advances its own attempt counter", async () => {
    undismissFinding.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const first = await submitRestore();
    const second = await submitRestore(first);

    expect([first.attempt, second.attempt]).toEqual([1, 2]);
  });

  it("carries no provider detail or error code", async () => {
    undismissFinding.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const state = await submitRestore();

    expect(JSON.stringify(state)).not.toMatch(/UNAVAILABLE|NOT_FOUND|INVALID_REQUEST/);
  });
});

/**
 * ATL-053 — asking about a finding, and giving feedback on the answer.
 *
 * The three things that live in the action itself: the user id comes from the
 * session, the evidence labels come from a server re-read rather than the caller,
 * and no provider vocabulary survives into what is returned.
 */

const RECORD = "33333333-3333-4333-8333-333333333333";

const detail = {
  ok: true,
  data: {
    id: FINDING,
    evidenceRecords: [
      { id: RECORD, kind: "asset", label: "Old shopping account", href: "/assets/a" },
    ],
  },
};

const aiAnswer = {
  status: "answered",
  source: "ai",
  classification: "metadata",
  interactionId: "interaction-1",
  value: {
    summary: "This account still holds your address.",
    whyItMatters: "Dormant accounts are a common breach source.",
    evidenceReferences: [RECORD],
    confidence: "medium",
    uncertainties: [],
    recommendedActions: [],
  },
};

describe("asking about a finding", () => {
  it("asks about the session's user, never an id from the caller", async () => {
    getFindingDetail.mockResolvedValue(detail);
    answer.mockResolvedValue(aiAnswer);

    await explainFindingAction(FINDING);

    /**
     * The action takes only a finding id, so there is no user parameter to abuse
     * — asserted anyway, because adding one later would be a silent authorization
     * regression that nothing else in this suite would catch.
     */
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, subjectId: FINDING, purpose: "explain_finding" }),
    );
    expect(getFindingDetail).toHaveBeenCalledWith(USER, FINDING);
  });

  it("sends no user message, the question being the prompt's own", async () => {
    getFindingDetail.mockResolvedValue(detail);
    answer.mockResolvedValue(aiAnswer);

    await explainFindingAction(FINDING);

    /** ATL-055 made this optional so this path could omit it rather than invent one. */
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ userMessage: undefined });
  });

  it("labels citations from its own read of the finding", async () => {
    getFindingDetail.mockResolvedValue(detail);
    answer.mockResolvedValue(aiAnswer);

    const state = await explainFindingAction(FINDING);
    if (state.status !== "answered") throw new Error("expected an answer");

    expect(state.explanation.sources).toEqual([
      { id: RECORD, label: "Old shopping account", href: "/assets/a" },
    ]);
  });

  it("refuses a finding that is not the caller's without asking anything", async () => {
    getFindingDetail.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    const state = await explainFindingAction(FINDING);

    expect(state.status).toBe("not_found");
    /** The policy layer never sees an id the caller does not own. */
    expect(answer).not.toHaveBeenCalled();
  });

  it("reports unavailable when the finding cannot be read at all", async () => {
    getFindingDetail.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const state = await explainFindingAction(FINDING);

    expect(state.status).toBe("unavailable");
    expect(answer).not.toHaveBeenCalled();
  });

  it("passes consent_required through so the panel can ask", async () => {
    getFindingDetail.mockResolvedValue(detail);
    answer.mockResolvedValue({ status: "consent_required" });

    expect((await explainFindingAction(FINDING)).status).toBe("consent_required");
  });

  it("returns no provider vocabulary or service code", async () => {
    getFindingDetail.mockResolvedValue(detail);
    answer.mockResolvedValue({ status: "unavailable" });

    const state = await explainFindingAction(FINDING);

    const rendered = JSON.stringify(state);

    /** Vendor and failure-mode words, in any casing. */
    expect(rendered).not.toMatch(/anthropic|claude|sonnet|rate.?limit|provider|overloaded/i);
    /**
     * Service codes, case-**sensitively**. `unavailable` is the UI's own status
     * word and legitimately appears; `UNAVAILABLE` is the internal code and must
     * not. Matching case-insensitively here would fail on the correct output.
     */
    expect(rendered).not.toMatch(/NOT_FOUND|UNAVAILABLE|INVALID_REQUEST/);
  });
});

describe("feedback on an answer", () => {
  it("writes only helpful and a closed-vocabulary category, scoped to the owner", async () => {
    recordFeedback.mockResolvedValue({ id: "interaction-1" });

    const state = await submitAiFeedbackAction("interaction-1", false, "too_vague");

    expect(state.status).toBe("recorded");
    expect(recordFeedback).toHaveBeenCalledWith({
      interactionId: "interaction-1",
      /** Explicit predicate: this write runs as service_role and bypasses RLS. */
      userId: USER,
      helpful: false,
      category: "too_vague",
    });
  });

  it("drops an unrecognised category rather than discarding the thumb", async () => {
    recordFeedback.mockResolvedValue({ id: "interaction-1" });

    await submitAiFeedbackAction("interaction-1", true, "the answer was rude");

    /**
     * The category is the qualifier; the thumb is the signal. Refusing the whole
     * submission over a bad qualifier would throw away the part that matters —
     * and the free text is never stored, here or on the table.
     */
    expect(recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ helpful: true, category: undefined }),
    );
  });

  it("stores no free text under any key", async () => {
    recordFeedback.mockResolvedValue({ id: "interaction-1" });

    await submitAiFeedbackAction("interaction-1", true, "the answer was rude");

    expect(JSON.stringify(recordFeedback.mock.calls[0]?.[0])).not.toContain("rude");
  });

  it("answers unavailable for an interaction that updated nothing", async () => {
    /**
     * Another user's row matches no predicate and returns null. Reported the same
     * way a storage failure is, so neither confirms that the id names a real row.
     */
    recordFeedback.mockResolvedValue(null);

    expect((await submitAiFeedbackAction("someone-elses-row", true)).status).toBe("unavailable");
  });

  it("survives a storage outage without throwing at the user", async () => {
    recordFeedback.mockRejectedValue(new Error("store down"));

    expect((await submitAiFeedbackAction("interaction-1", true)).status).toBe("unavailable");
  });
});
