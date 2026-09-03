import { act, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import type { PersonalFieldActionViewState, PersonalFieldView } from "./personal-fields-view";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ATL-106 — Settings → Personal data, as a surface renders it.
 *
 * What only a render can show: that a stored value is absent from the DOM until
 * the person asks for it, that the three consent states offer different controls,
 * that deletion demands an explicit confirmation, and that the two disclosures
 * ADR-002 and ADR-003 require are actually on screen.
 *
 * The Server Actions are mocked because this file is about the bindings, not the
 * service. ATL-105's own guarantees — the consent gate, encryption, masking,
 * audit-before-return — are asserted against the real implementation in
 * `tests/integration/personal-field-service.test.ts`, and this deliberately does
 * not restate them.
 */

/**
 * Typed rather than bare `vi.fn()`: an untyped mock returns `any`, which the
 * unsafe-return rule catches — and rightly, since the shape the component
 * branches on would then be unchecked in the one place it is simulated.
 */
const revealPersonalFieldAction =
  vi.fn<(fieldId: string) => Promise<{ ok: boolean; value: string | null }>>();
const grantPersonalFieldsConsentAction = vi.fn<() => Promise<PersonalFieldActionViewState>>();

vi.mock("@/app/(product)/settings/actions", () => ({
  revealPersonalFieldAction: (fieldId: string) => revealPersonalFieldAction(fieldId),
  grantPersonalFieldsConsentAction: () => grantPersonalFieldsConsentAction(),
}));

const { PersonalFieldsSection } = await import("./personal-fields-section");
const { PERSONAL_FIELDS_COPY } = await import("./personal-fields-copy");
const { INITIAL_FORM_VIEW_STATE, INITIAL_ACTION_VIEW_STATE } =
  await import("./personal-fields-view");
const { DEFAULT_REVEAL_DURATION_MS } = await import("@/components/ui/sensitive-value");

/**
 * Lets `getByTestId` address the `data-slot` attributes this section already
 * sets, exactly as `finding-detail.test.tsx` does.
 *
 * The editor form is marked with `data-slot` and nothing else — a `<form>` has no
 * role without an accessible name — so reading the same attribute through a
 * supported query is what keeps the assertions out of `no-node-access`.
 *
 * Test-only, and the default is restored below so no other suite inherits it.
 */
configure({ testIdAttribute: "data-slot" });

afterAll(() => {
  configure({ testIdAttribute: "data-testid" });
});

const FIELD_ID = "11111111-1111-4111-8111-111111111111";
const MASKED = "a•••@example.com";
/**
 * The primitive's own accessible name, asserted exactly rather than by pattern:
 * a loose `/reveal|show/` would keep passing if the control stopped naming which
 * field it belongs to, which is the part a screen-reader user depends on.
 */
const REVEAL_CONTROL = "Reveal Personal detail: Personal Gmail";
/**
 * The row's editor trigger. It names what it opens rather than what the form
 * writes — a collapsed row offering "Save changes" would name a write that
 * cannot happen yet — and it names the row, because the list can hold several
 * details of one kind.
 */
const EDIT_TRIGGER = "Edit: Personal Gmail";
const FULL = "alex.person@example.com";

const field = (overrides: Partial<PersonalFieldView> = {}): PersonalFieldView => ({
  id: FIELD_ID,
  fieldKey: "email" as const,
  label: "Personal Gmail",
  maskedValue: MASKED,
  lastUsedAt: null,
  includeInDiscovery: false,
  ...overrides,
});

function section(props: Partial<React.ComponentProps<typeof PersonalFieldsSection>> = {}) {
  const noopForm = vi.fn().mockResolvedValue(INITIAL_FORM_VIEW_STATE);
  const noopButton = vi.fn().mockResolvedValue(INITIAL_ACTION_VIEW_STATE);
  const noopToggle = vi.fn().mockResolvedValue({ ok: true });

  return render(
    <PersonalFieldsSection
      fields={[]}
      permitted
      addAction={noopForm}
      editAction={noopForm}
      deleteAction={noopButton}
      setDiscoveryAction={noopToggle}
      {...props}
    />,
  );
}

beforeEach(() => {
  revealPersonalFieldAction.mockReset();
  revealPersonalFieldAction.mockResolvedValue({ ok: true, value: FULL });
  grantPersonalFieldsConsentAction.mockReset();
  grantPersonalFieldsConsentAction.mockResolvedValue(INITIAL_ACTION_VIEW_STATE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the honest disclosures (ADR-002, ADR-003)", () => {
  it("says the encryption is server-side and not end-to-end", () => {
    section({ fields: [field()] });

    const note = screen.getByText(PERSONAL_FIELDS_COPY.encryptionNote);
    expect(note).toBeInTheDocument();
    /**
     * ADR-003's tradeoffs are explicit that documentation "must not claim
     * otherwise". Asserting the words rather than the element is what stops the
     * sentence being softened later.
     */
    expect(note.textContent).toMatch(/not end-to-end/i);
    expect(note.textContent).toMatch(/Atlas can decrypt/i);
  });

  it("says a field reaches the assistant only in a draft the person approved", () => {
    section({ fields: [field()] });

    const note = screen.getByText(PERSONAL_FIELDS_COPY.aiUsageNote);
    expect(note.textContent).toMatch(/never sends these to the AI assistant on its own/i);
    expect(note.textContent).toMatch(/draft you have approved/i);
  });

  it("shows both disclosures even when writes are unavailable", () => {
    section({ fields: [field()], permitted: false });

    expect(screen.getByText(PERSONAL_FIELDS_COPY.encryptionNote)).toBeInTheDocument();
    expect(screen.getByText(PERSONAL_FIELDS_COPY.aiUsageNote)).toBeInTheDocument();
  });
});

describe("consent has never been granted", () => {
  it("leads with the consent panel rather than an add form", () => {
    section({ fields: [], permitted: false });

    expect(screen.getByText(PERSONAL_FIELDS_COPY.consentTitle)).toBeInTheDocument();
    expect(screen.queryByLabelText(PERSONAL_FIELDS_COPY.valueField)).not.toBeInTheDocument();
  });

  it("explains why, what is stored, the encryption, and the AI rule before asking", () => {
    section({ fields: [], permitted: false });

    /** Scoped to the panel, so "somewhere on the page" does not count. */
    const scope = within(screen.getByTestId("personal-fields-consent"));

    expect(scope.getByText(PERSONAL_FIELDS_COPY.consentTitle)).toBeInTheDocument();

    expect(scope.getByText(PERSONAL_FIELDS_COPY.consentWhy)).toBeInTheDocument();
    expect(scope.getByText(PERSONAL_FIELDS_COPY.consentWhatIsStored)).toBeInTheDocument();
    expect(scope.getByText(PERSONAL_FIELDS_COPY.encryptionNote)).toBeInTheDocument();
    expect(scope.getByText(PERSONAL_FIELDS_COPY.aiUsageNote)).toBeInTheDocument();
  });

  it("offers the grant control", async () => {
    const user = userEvent.setup();
    section({ fields: [], permitted: false });

    await user.click(screen.getByRole("button", { name: PERSONAL_FIELDS_COPY.consentGrant }));

    await waitFor(() => expect(grantPersonalFieldsConsentAction).toHaveBeenCalled());
  });
});

describe("consent has been granted", () => {
  it("offers the add form", () => {
    section({ fields: [], permitted: true });

    expect(screen.getByLabelText(PERSONAL_FIELDS_COPY.labelField)).toBeInTheDocument();
    expect(screen.getByLabelText(PERSONAL_FIELDS_COPY.valueField)).toBeInTheDocument();
    expect(screen.getByLabelText(PERSONAL_FIELDS_COPY.kindField)).toBeInTheDocument();
  });

  it("shows the empty state rather than the consent panel when nothing is saved", () => {
    section({ fields: [], permitted: true });

    expect(screen.getByText(PERSONAL_FIELDS_COPY.emptyTitle)).toBeInTheDocument();
    expect(screen.queryByText(PERSONAL_FIELDS_COPY.consentTitle)).not.toBeInTheDocument();
  });

  it("never puts a value input into the DOM pre-filled", () => {
    section({ fields: [field()], permitted: true });

    /**
     * The add form's value box is empty, and no stored plaintext is anywhere in
     * the tree — the only value present is the mask.
     */
    expect(screen.getByLabelText(PERSONAL_FIELDS_COPY.valueField)).toHaveValue("");
    expect(document.body.textContent).not.toContain(FULL);
  });
});

describe("consent has been withdrawn while fields remain", () => {
  it("keeps the list and explains the change", () => {
    section({ fields: [field()], permitted: false });

    expect(screen.getByText(PERSONAL_FIELDS_COPY.revokedTitle)).toBeInTheDocument();
    expect(screen.getByText(PERSONAL_FIELDS_COPY.revokedBody)).toBeInTheDocument();
    expect(screen.getByText("Personal Gmail")).toBeInTheDocument();
  });

  it("keeps reveal and delete available", () => {
    section({ fields: [field()], permitted: false });

    expect(
      screen.getByRole("button", { name: new RegExp(PERSONAL_FIELDS_COPY.deleteAction, "i") }),
    ).toBeInTheDocument();
    /** The reveal control is the primitive's own toggle. */
    expect(screen.getByRole("button", { name: REVEAL_CONTROL })).toBeInTheDocument();
  });

  it("withdraws add and edit", () => {
    section({ fields: [field()], permitted: false });

    expect(screen.queryByLabelText(PERSONAL_FIELDS_COPY.valueField)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: EDIT_TRIGGER })).not.toBeInTheDocument();
  });

  it("offers consent again, below the list", () => {
    section({ fields: [field()], permitted: false });

    expect(
      screen.getByRole("button", { name: PERSONAL_FIELDS_COPY.consentGrant }),
    ).toBeInTheDocument();
  });
});

describe("the stored value", () => {
  it("renders masked, with the plaintext absent from the DOM", () => {
    section({ fields: [field()], permitted: true });

    expect(screen.getByText(MASKED)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FULL);
  });

  it("reveals only on a deliberate act, through the audited action", async () => {
    const user = userEvent.setup();
    section({ fields: [field()], permitted: true });

    await user.click(screen.getByRole("button", { name: REVEAL_CONTROL }));

    expect(await screen.findByText(FULL)).toBeInTheDocument();
    /**
     * The action is the audited path: `PersonalFieldService.reveal` writes
     * `personal_field.revealed` before returning. The component has no other way
     * to obtain a value.
     */
    expect(revealPersonalFieldAction).toHaveBeenCalledWith(FIELD_ID);
  });

  it("re-masks on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    section({ fields: [field()], permitted: true });
    await user.click(screen.getByRole("button", { name: REVEAL_CONTROL }));
    expect(await screen.findByText(FULL)).toBeInTheDocument();

    /**
     * Inside `act`: the re-mask is a state update driven by a timer rather than by
     * an event, so nothing else flushes it. Same reasoning as
     * `account-identifier.test.tsx`.
     */
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_REVEAL_DURATION_MS);
    });

    expect(screen.queryByText(FULL)).not.toBeInTheDocument();
    expect(screen.getByText(MASKED)).toBeInTheDocument();
  });

  it("shows a refusal without a reason when the action declines", async () => {
    revealPersonalFieldAction.mockResolvedValue({ ok: false, value: null });
    const user = userEvent.setup();
    section({ fields: [field()], permitted: true });

    await user.click(screen.getByRole("button", { name: REVEAL_CONTROL }));

    /**
     * "No such field", "not yours" and "the audit log is down" must stay
     * indistinguishable — the non-oracle rule the service applies.
     */
    await waitFor(() => expect(screen.queryByText(FULL)).not.toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/not found|forbidden|audit/i);
  });
});

describe("last-used context", () => {
  it("is honest when the field has never been used", () => {
    section({ fields: [field({ lastUsedAt: null })], permitted: true });

    /** Null for every row until ATL-058; a blank cell would read as a bug. */
    expect(screen.getByText(PERSONAL_FIELDS_COPY.neverUsed)).toBeInTheDocument();
  });

  it("reports the date once a request has used it", () => {
    section({
      fields: [field({ lastUsedAt: "2026-03-14T10:00:00.000Z" })],
      permitted: true,
    });

    expect(
      screen.getByText(new RegExp(PERSONAL_FIELDS_COPY.lastUsedPrefix, "i")),
    ).toBeInTheDocument();
  });
});

describe("editing one row", () => {
  it("names what the trigger opens, not what the form writes", () => {
    section({ fields: [field()], permitted: true });

    const trigger = screen.getByRole("button", { name: EDIT_TRIGGER });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    /** The submit belongs to a form that is not on screen yet. */
    expect(
      screen.queryByRole("button", { name: PERSONAL_FIELDS_COPY.editSubmit }),
    ).not.toBeInTheDocument();
  });

  it("opens an editor whose value box is empty", async () => {
    const user = userEvent.setup();
    section({ fields: [field()], permitted: true });

    await user.click(screen.getByRole("button", { name: EDIT_TRIGGER }));

    const scope = within(screen.getByTestId("personal-field-edit-form"));

    /**
     * Pre-filling would require sending the plaintext to the browser to render
     * it — the thing `listMasked` exists to avoid. An empty box also carries the
     * meaning the action relies on: leave the stored value alone.
     */
    expect(scope.getByLabelText(PERSONAL_FIELDS_COPY.valueField)).toHaveValue("");
    expect(document.body.textContent).not.toContain(FULL);
  });

  it("submits the row it was opened from", async () => {
    const user = userEvent.setup();
    const editAction = vi.fn().mockResolvedValue(INITIAL_FORM_VIEW_STATE);
    section({ fields: [field()], permitted: true, editAction });

    await user.click(screen.getByRole("button", { name: EDIT_TRIGGER }));
    const editor = within(screen.getByTestId("personal-field-edit-form"));
    await user.type(editor.getByLabelText(PERSONAL_FIELDS_COPY.labelField), " renamed");
    await user.click(editor.getByRole("button", { name: PERSONAL_FIELDS_COPY.editSubmit }));

    await waitFor(() => expect(editAction).toHaveBeenCalled());
    const submitted = editAction.mock.calls[0]?.[1] as FormData;
    expect(submitted.get("fieldId")).toBe(FIELD_ID);
  });

  it("closes without writing when the editor is dismissed", async () => {
    const user = userEvent.setup();
    const editAction = vi.fn().mockResolvedValue(INITIAL_FORM_VIEW_STATE);
    section({ fields: [field()], permitted: true, editAction });

    await user.click(screen.getByRole("button", { name: EDIT_TRIGGER }));
    await user.click(screen.getByRole("button", { name: PERSONAL_FIELDS_COPY.editCancel }));

    expect(screen.queryByTestId("personal-field-edit-form")).not.toBeInTheDocument();
    expect(editAction).not.toHaveBeenCalled();
  });
});

describe("deletion", () => {
  it("requires an explicit confirmation that names the consequence", async () => {
    const user = userEvent.setup();
    const deleteAction = vi.fn().mockResolvedValue(INITIAL_ACTION_VIEW_STATE);
    section({ fields: [field()], permitted: true, deleteAction });

    await user.click(
      screen.getByRole("button", { name: new RegExp(PERSONAL_FIELDS_COPY.deleteAction, "i") }),
    );

    expect(await screen.findByText(PERSONAL_FIELDS_COPY.deleteTitle)).toBeInTheDocument();
    const body = screen.getByText(PERSONAL_FIELDS_COPY.deleteBody);
    expect(body.textContent).toMatch(/permanently/i);
    expect(body.textContent).toMatch(/cannot be recovered/i);

    /** Nothing is deleted by opening the dialog. */
    expect(deleteAction).not.toHaveBeenCalled();
  });

  it("deletes only after the confirm control is used", async () => {
    const user = userEvent.setup();
    const deleteAction = vi.fn().mockResolvedValue(INITIAL_ACTION_VIEW_STATE);
    section({ fields: [field()], permitted: true, deleteAction });

    await user.click(
      screen.getByRole("button", { name: new RegExp(PERSONAL_FIELDS_COPY.deleteAction, "i") }),
    );
    await user.click(screen.getByRole("button", { name: PERSONAL_FIELDS_COPY.deleteConfirm }));

    await waitFor(() => expect(deleteAction).toHaveBeenCalled());
  });

  it("offers a safe way out that describes the safe outcome", async () => {
    const user = userEvent.setup();
    const deleteAction = vi.fn().mockResolvedValue(INITIAL_ACTION_VIEW_STATE);
    section({ fields: [field()], permitted: true, deleteAction });

    await user.click(
      screen.getByRole("button", { name: new RegExp(PERSONAL_FIELDS_COPY.deleteAction, "i") }),
    );
    await user.click(screen.getByRole("button", { name: PERSONAL_FIELDS_COPY.deleteCancel }));

    expect(deleteAction).not.toHaveBeenCalled();
  });
});

describe("accessibility", () => {
  it("has no axe violations with fields listed", async () => {
    const { container } = section({ fields: [field()], permitted: true });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations in the consent state", async () => {
    const { container } = section({ fields: [], permitted: false });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations in the withdrawn state", async () => {
    const { container } = section({ fields: [field()], permitted: false });
    expect(await axe(container)).toHaveNoViolations();
  });
});
