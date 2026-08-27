import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ATL-058 — Step 1 of the request flow, as a surface renders it.
 *
 * What only a render can show, and what the acceptance criteria ask for: that
 * every include checkbox starts unchecked, that ticking one survives adding a
 * field and a refused submission, that the just-in-time form saves through the
 * consent-gated path, that the recipient is validated and labelled unverified,
 * and that the uncertain-evidence warning appears when it should.
 *
 * The Server Actions are mocked because this file is about the bindings, not the
 * service. `createDraft`'s own guarantees — the vocabulary check, `markUsed`, the
 * best-effort activity write — are asserted against the real implementation in
 * `request-service.integration.test.ts`, and this deliberately does not restate
 * them.
 */

const revealPersonalFieldAction =
  vi.fn<(fieldId: string) => Promise<{ ok: boolean; value: string | null }>>();

vi.mock("@/app/(product)/settings/actions", () => ({
  revealPersonalFieldAction: (fieldId: string) => revealPersonalFieldAction(fieldId),
}));

const { RequestReviewDialog } = await import("./request-review-dialog");
const { REQUEST_REVIEW_COPY } = await import("./request-review-copy");
const { INITIAL_REVIEW_STATE, INITIAL_CAPTURE_STATE } = await import("./request-review-view");
import type { RequestReviewData } from "./request-review-view";

/**
 * Addresses the `data-slot` attributes by `getByTestId`, as
 * `finding-detail.test.tsx` does. Several elements here carry a slot and nothing
 * else — a `<form>` has no role without an accessible name.
 *
 * Test-only, and the default is restored below so no other suite inherits it.
 */
configure({ testIdAttribute: "data-slot" });

afterAll(() => {
  configure({ testIdAttribute: "data-testid" });
});

const EMAIL_FIELD = {
  id: "field-email",
  fieldKey: "email" as const,
  label: "Personal Gmail",
  maskedValue: "a•••@example.com",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const PHONE_FIELD = {
  id: "field-phone",
  fieldKey: "phone" as const,
  label: "Mobile",
  maskedValue: "+1 ••• ••0134",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

function data(overrides: Partial<RequestReviewData> = {}): RequestReviewData {
  return {
    assetId: "asset-1",
    serviceName: "Acme Media",
    assetConfidence: "high",
    evidence: [{ label: "Contact", confidence: "high", source: "you" }],
    offeredFields: [EMAIL_FIELD, PHONE_FIELD],
    hiddenAlternativeKeys: [],
    vaultWritable: true,
    restoredFieldKeys: [],
    restoredRecipient: null,
    ...overrides,
  };
}

function dialog(overrides: Partial<RequestReviewData> = {}) {
  const createDraft = vi.fn().mockResolvedValue(INITIAL_REVIEW_STATE);
  const captureField = vi.fn().mockResolvedValue({ ...INITIAL_CAPTURE_STATE, saved: true });

  const view = render(
    <RequestReviewDialog
      data={data(overrides)}
      createDraft={createDraft}
      captureField={captureField}
      cancelHref="/assets/asset-1"
    />,
  );

  return { ...view, createDraft, captureField };
}

const checkboxFor = (label: string) => screen.getByRole("checkbox", { name: new RegExp(label) });

beforeEach(() => {
  revealPersonalFieldAction.mockReset();
  revealPersonalFieldAction.mockResolvedValue({ ok: true, value: "alex@example.com" });
});

describe("what the step shows before anything is chosen", () => {
  it("names the service the request is about", () => {
    dialog();

    expect(screen.getByRole("heading", { name: /Request deletion: Acme Media/ })).toBeVisible();
  });

  it("starts every include checkbox unchecked (FR-08, ADR-002)", () => {
    /**
     * A security property, not a preference: a checked box would mean Atlas had
     * decided to send someone's identity details to a third party unasked.
     */
    dialog();

    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).not.toBeChecked();
    }
  });

  it("shows each stored value masked, never in full", () => {
    dialog();

    expect(screen.getByText(EMAIL_FIELD.maskedValue)).toBeVisible();
    expect(document.body.textContent).not.toContain("alex@example.com");
  });

  it("says nothing is included unless it is ticked", () => {
    dialog();

    expect(screen.getByText(REQUEST_REVIEW_COPY.fieldsDescription)).toBeVisible();
  });

  it("says Atlas never sends anything", () => {
    /** Security §11 and frontend §9, said before the person commits. */
    dialog();

    const notice = screen.getByTestId("request-draft-only");
    expect(notice.textContent).toMatch(/Atlas never sends/i);
    expect(notice.textContent).toMatch(/you send it yourself/i);
  });

  it("offers a way out that does not submit", () => {
    dialog();

    expect(screen.getByRole("link", { name: REQUEST_REVIEW_COPY.cancel })).toHaveAttribute(
      "href",
      "/assets/asset-1",
    );
  });
});

describe("the evidence review", () => {
  it("lists what the service is believed to hold, with confidence", () => {
    dialog();

    const list = within(screen.getByTestId("request-evidence-list"));
    expect(list.getByText("Contact")).toBeVisible();
    expect(list.getByText(/high confidence/i)).toBeVisible();
  });

  it("warns when the service's own confidence is low (D5)", () => {
    dialog({ assetConfidence: "low" });

    expect(screen.getByTestId("request-evidence-warning")).toBeVisible();
  });

  it("warns when any single category is low", () => {
    dialog({
      assetConfidence: "high",
      evidence: [
        { label: "Contact", confidence: "high", source: null },
        { label: "Location", confidence: "low", source: null },
      ],
    });

    expect(screen.getByTestId("request-evidence-warning")).toBeVisible();
  });

  it("does not warn when everything is confident", () => {
    dialog();

    expect(screen.queryByTestId("request-evidence-warning")).not.toBeInTheDocument();
  });

  it("says so plainly when nothing is recorded", () => {
    // A person can still send a request; it simply asks what they hold.
    dialog({ evidence: [] });

    expect(screen.getByTestId("request-evidence-empty")).toBeVisible();
  });
});

describe("choosing what to include", () => {
  it("ticks and unticks a field", async () => {
    const user = userEvent.setup();
    dialog();

    await user.click(checkboxFor("Personal Gmail"));
    expect(checkboxFor("Personal Gmail")).toBeChecked();

    await user.click(checkboxFor("Personal Gmail"));
    expect(checkboxFor("Personal Gmail")).not.toBeChecked();
  });

  it("keeps a selection while another is made", async () => {
    const user = userEvent.setup();
    dialog();

    await user.click(checkboxFor("Personal Gmail"));
    await user.click(checkboxFor("Mobile"));

    expect(checkboxFor("Personal Gmail")).toBeChecked();
    expect(checkboxFor("Mobile")).toBeChecked();
  });

  it("submits exactly the ticked ids", async () => {
    /**
     * The selection travels as hidden inputs rather than the checkboxes' own
     * names, so what is submitted is exactly what the component believes is
     * selected — the two cannot disagree.
     */
    const user = userEvent.setup();
    const { createDraft } = dialog();

    await user.click(checkboxFor("Personal Gmail"));
    await user.type(screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel), "p@acme.example");
    await user.click(screen.getByRole("button", { name: REQUEST_REVIEW_COPY.submit }));

    await waitFor(() => expect(createDraft).toHaveBeenCalled());

    const submitted = createDraft.mock.calls[0]?.[1] as FormData;
    expect(submitted.getAll("selectedFieldIds")).toEqual([EMAIL_FIELD.id]);
  });

  it("names the service the draft is for", async () => {
    /**
     * The action has no route params — a Server Action is not a route handler —
     * so the asset id travels in the form. Without it the ownership check would
     * run against an empty id and refuse every submission.
     */
    const user = userEvent.setup();
    const { createDraft } = dialog();

    await user.type(screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel), "p@acme.example");
    await user.click(screen.getByRole("button", { name: REQUEST_REVIEW_COPY.submit }));

    await waitFor(() => expect(createDraft).toHaveBeenCalled());

    const submitted = createDraft.mock.calls[0]?.[1] as FormData;
    expect(submitted.get("assetId")).toBe("asset-1");
  });

  it("submits nothing when nothing was ticked", async () => {
    const user = userEvent.setup();
    const { createDraft } = dialog();

    await user.type(screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel), "p@acme.example");
    await user.click(screen.getByRole("button", { name: REQUEST_REVIEW_COPY.submit }));

    await waitFor(() => expect(createDraft).toHaveBeenCalled());

    const submitted = createDraft.mock.calls[0]?.[1] as FormData;
    expect(submitted.getAll("selectedFieldIds")).toEqual([]);
  });

  it("restores a selection from a stored draft", () => {
    /**
     * Once the draft exists the row is the source of truth. This is the read path
     * ATL-060 uses to return someone to this step — resolved from keys to the
     * ids actually on offer.
     */
    dialog({ restoredFieldKeys: ["phone"] });

    expect(checkboxFor("Mobile")).toBeChecked();
    expect(checkboxFor("Personal Gmail")).not.toBeChecked();
  });

  it("ignores a restored key with no field on offer", () => {
    // The vault changed since the draft was made; the checklist shows what exists.
    dialog({ restoredFieldKeys: ["address"] });

    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).not.toBeChecked();
    }
  });

  it("says when a key has alternatives it is not offering (D1)", () => {
    dialog({ hiddenAlternativeKeys: ["email"] });

    expect(screen.getByTestId("request-field-alternatives")).toBeVisible();
  });

  it("says so plainly when the vault is empty", () => {
    dialog({ offeredFields: [] });

    expect(screen.getByTestId("request-fields-empty")).toBeVisible();
  });

  it("reveals one value through the audited action", async () => {
    const user = userEvent.setup();
    dialog();

    await user.click(
      screen.getByRole("button", { name: `Reveal Personal detail: ${EMAIL_FIELD.label}` }),
    );

    expect(await screen.findByText("alex@example.com")).toBeVisible();
    expect(revealPersonalFieldAction).toHaveBeenCalledWith(EMAIL_FIELD.id);
  });
});

describe("just-in-time field capture (ADR-002, FR-13)", () => {
  it("offers the add form only when the vault is writable", () => {
    /**
     * `save` is consent-gated and ATL-105 fails closed, so offering a form whose
     * submission would be refused tells the person less than not offering it.
     */
    dialog({ vaultWritable: false });

    expect(screen.queryByTestId("request-capture-trigger")).not.toBeInTheDocument();
  });

  it("opens the capture form on request", async () => {
    const user = userEvent.setup();
    dialog();

    await user.click(screen.getByTestId("request-capture-trigger"));

    expect(screen.getByTestId("request-field-capture")).toBeVisible();
  });

  it("saves through the consent-recording action", async () => {
    const user = userEvent.setup();
    const { captureField } = dialog();

    await user.click(screen.getByTestId("request-capture-trigger"));

    const capture = within(screen.getByTestId("request-field-capture"));
    await user.type(capture.getByLabelText("Label"), "Work email");
    await user.type(capture.getByLabelText("Value"), "work@example.com");
    await user.click(capture.getByRole("button", { name: "Save detail" }));

    await waitFor(() => expect(captureField).toHaveBeenCalled());
  });

  it("keeps an existing selection while a field is added", async () => {
    /**
     * The persistence claim the acceptance criteria make: a selection survives
     * the sub-flow. Adding a detail must not silently clear what was already
     * ticked.
     */
    const user = userEvent.setup();
    dialog();

    await user.click(checkboxFor("Personal Gmail"));
    await user.click(screen.getByTestId("request-capture-trigger"));

    expect(checkboxFor("Personal Gmail")).toBeChecked();
  });

  it("never pre-fills the value box", async () => {
    const user = userEvent.setup();
    dialog();

    await user.click(screen.getByTestId("request-capture-trigger"));

    const capture = within(screen.getByTestId("request-field-capture"));
    expect(capture.getByLabelText("Value")).toHaveValue("");
  });
});

describe("the recipient", () => {
  it("is empty on a first visit", () => {
    dialog();

    expect(screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel)).toHaveValue("");
  });

  it("is restored from a stored draft", () => {
    dialog({ restoredRecipient: "privacy@acme.example" });

    expect(screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel)).toHaveValue(
      "privacy@acme.example",
    );
  });

  it("says Atlas does not verify it (FR-08)", () => {
    /**
     * The claim qualifies the value, so it sits with the field rather than in a
     * footnote — and it is wired as a description, so it is announced on focus.
     */
    dialog();

    expect(screen.getByTestId("request-recipient-unverified")).toBeVisible();
    expect(screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel)).toHaveAccessibleDescription(
      new RegExp(REQUEST_REVIEW_COPY.recipientUnverified.slice(0, 30)),
    );
  });

  it("offers no suggestion or autofill", () => {
    // Suggesting an address would imply Atlas had checked one. It has not.
    const input = screen.queryByLabelText(REQUEST_REVIEW_COPY.recipientLabel);
    dialog();

    expect(input ?? screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel)).toHaveAttribute(
      "autocomplete",
      "off",
    );
  });
});

describe("when the submission is refused", () => {
  const refused = (failure: "missing_recipient" | "invalid_recipient" | "unavailable") =>
    vi.fn().mockResolvedValue({ failure, attempt: 1 });

  /**
   * A value the **browser** accepts and the **server** does not.
   *
   * The input is `type="email" required`, so the browser refuses an empty value
   * and an obviously malformed one before any round trip — which means a test
   * that submits either asserts against a submission that never happened. `a@b`
   * passes HTML's email check and fails `isPlausibleEmail`, whose pattern
   * requires a dotted domain, so it is the narrow gap where a server refusal is
   * reachable from the UI at all.
   *
   * That gap is small on purpose. The client check is a courtesy; the server
   * check is the gate, and it refuses the same values whether or not JavaScript
   * ran.
   */
  const SERVER_ONLY_REFUSAL = "a@b";

  const fillRecipient = async (user: ReturnType<typeof userEvent.setup>, value: string) => {
    await user.type(screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel), value);
  };

  it("explains why the address was refused", async () => {
    const user = userEvent.setup();

    render(
      <RequestReviewDialog
        data={data()}
        createDraft={refused("invalid_recipient")}
        captureField={vi.fn()}
        cancelHref="/assets/asset-1"
      />,
    );

    await fillRecipient(user, SERVER_ONLY_REFUSAL);
    await user.click(screen.getByRole("button", { name: REQUEST_REVIEW_COPY.submit }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      REQUEST_REVIEW_COPY.failureInvalidRecipient,
    );
  });

  it("has different words for a missing address than an invalid one", () => {
    /**
     * Asserted on the copy rather than through the UI, because `required` means
     * an empty address never reaches the server from this form — the state exists
     * for a submission without JavaScript, or a tampered one. Two sentences that
     * had drifted into saying the same thing would tell someone who typed a typo
     * that they had typed nothing.
     */
    expect(REQUEST_REVIEW_COPY.failureMissingRecipient).not.toBe(
      REQUEST_REVIEW_COPY.failureInvalidRecipient,
    );
    expect(REQUEST_REVIEW_COPY.failureMissingRecipient).toMatch(/enter/i);
    expect(REQUEST_REVIEW_COPY.failureInvalidRecipient).toMatch(/does not look like/i);
  });

  it("marks the field itself, not just the message", async () => {
    const user = userEvent.setup();
    render(
      <RequestReviewDialog
        data={data()}
        createDraft={refused("invalid_recipient")}
        captureField={vi.fn()}
        cancelHref="/assets/asset-1"
      />,
    );

    await fillRecipient(user, SERVER_ONLY_REFUSAL);
    await user.click(screen.getByRole("button", { name: REQUEST_REVIEW_COPY.submit }));

    await waitFor(() =>
      expect(screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel)).toHaveAttribute(
        "aria-invalid",
        "true",
      ),
    );
  });

  it("keeps the selection so nothing has to be re-ticked", async () => {
    /**
     * The persistence the acceptance criteria require, across the one boundary
     * most likely to lose it. Retyping an address is a nuisance; re-choosing what
     * to disclose is a decision nobody should be asked to make twice.
     */
    const user = userEvent.setup();
    render(
      <RequestReviewDialog
        data={data()}
        createDraft={refused("invalid_recipient")}
        captureField={vi.fn()}
        cancelHref="/assets/asset-1"
      />,
    );

    await user.click(checkboxFor("Personal Gmail"));
    await fillRecipient(user, SERVER_ONLY_REFUSAL);
    await user.click(screen.getByRole("button", { name: REQUEST_REVIEW_COPY.submit }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(checkboxFor("Personal Gmail")).toBeChecked();
  });

  it("will not submit an empty address at all", async () => {
    /**
     * `required` means the browser refuses before the round trip. The server
     * refuses it again regardless — a client check is never the gate — but the
     * person is told immediately rather than after a request.
     */
    const user = userEvent.setup();
    const createDraft = vi.fn().mockResolvedValue(INITIAL_REVIEW_STATE);

    render(
      <RequestReviewDialog
        data={data()}
        createDraft={createDraft}
        captureField={vi.fn()}
        cancelHref="/assets/asset-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: REQUEST_REVIEW_COPY.submit }));

    expect(createDraft).not.toHaveBeenCalled();
  });

  it("does not put the refused address back into the DOM", async () => {
    /**
     * `settings/form-state.ts`'s rule, applied here: re-populating a value Atlas
     * declined to store would put it back into the RSC payload. The recipient is
     * re-rendered from the stored draft, which on a first visit is empty.
     */
    const user = userEvent.setup();
    render(
      <RequestReviewDialog
        data={data()}
        createDraft={refused("unavailable")}
        captureField={vi.fn()}
        cancelHref="/assets/asset-1"
      />,
    );

    await user.type(screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel), "typo@acme.example");
    await user.click(screen.getByRole("button", { name: REQUEST_REVIEW_COPY.submit }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(screen.getByLabelText(REQUEST_REVIEW_COPY.recipientLabel)).not.toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });
});

describe("@a11y accessibility", () => {
  it("has no axe violations", async () => {
    const { baseElement } = dialog();

    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it("has none with the warning and the capture form open", async () => {
    const user = userEvent.setup();
    const { baseElement } = dialog({ assetConfidence: "low" });

    await user.click(screen.getByTestId("request-capture-trigger"));

    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it("labels every checkbox with the detail it includes", () => {
    dialog();

    expect(checkboxFor("Personal Gmail")).toBeVisible();
    expect(checkboxFor("Mobile")).toBeVisible();
  });

  it("is operable by keyboard alone", async () => {
    const user = userEvent.setup();
    dialog();

    checkboxFor("Personal Gmail").focus();
    await user.keyboard(" ");

    expect(checkboxFor("Personal Gmail")).toBeChecked();
  });
});
