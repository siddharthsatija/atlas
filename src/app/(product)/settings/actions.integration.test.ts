import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  INITIAL_PERSONAL_FIELD_ACTION_STATE as INITIAL_ACTION_STATE,
  INITIAL_PERSONAL_FIELD_STATE as INITIAL_FORM_STATE,
} from "./form-state";

/**
 * ATL-106 — the Settings → Personal data Server Actions.
 *
 * ## What this layer owns, and what it deliberately does not
 *
 * `PersonalFieldService` already has integration coverage against a real
 * repository in `tests/integration/personal-field-service.test.ts`: the
 * fail-closed consent gate, the encryption round trip, decrypt-then-mask, and the
 * `personal_field.revealed` event written *before* a plaintext is returned. None
 * of that is restated here — it would duplicate those assertions and fail twice
 * for one cause.
 *
 * What only exists at this layer is the **action contract**: that the user id
 * comes from the session and never from the payload, that each action reaches the
 * service method it claims to with the arguments it claims to, that a service
 * code becomes the right failure, that the cache is invalidated only after a write
 * that happened, and that a refusal to reveal carries no reason.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const FIELD = "44444444-4444-4444-8444-444444444444";

const save = vi.fn();
const edit = vi.fn();
const remove = vi.fn();
const removeField = vi.fn();
const reveal = vi.fn();
const grant = vi.fn();
/** Typed, so `mock.calls` yields `string` rather than `any` when read below. */
const revalidatePath = vi.fn<(path: string) => void>();

vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 5).toString("base64") },
}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/server/auth/require-user", () => ({
  requireVerifiedUser: () => Promise.resolve({ id: USER }),
}));

vi.mock("@/server/personal-fields/personal-field-service", () => ({
  PersonalFieldService: { create: () => ({ save, edit, remove, removeField, reveal }) },
}));

vi.mock("@/server/consent/consent-service", () => ({
  ConsentService: { create: () => ({ grant }) },
}));

const {
  addPersonalFieldAction,
  editPersonalFieldAction,
  deletePersonalFieldAction,
  revealPersonalFieldAction,
  grantPersonalFieldsConsentAction,
} = await import("./actions");

const form = (fields: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
};

const VALID = { fieldKey: "email", label: "Personal Gmail", value: "alex@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  save.mockResolvedValue({ ok: true, data: { id: FIELD } });
  edit.mockResolvedValue({ ok: true, data: { id: FIELD } });
  remove.mockResolvedValue({ ok: true, data: null });
  removeField.mockResolvedValue({ ok: true, data: null });
  reveal.mockResolvedValue({ ok: true, data: "alex@example.com" });
  grant.mockResolvedValue(undefined);
});

describe("granting storage consent", () => {
  it("records the consent for the signed-in user", async () => {
    const state = await grantPersonalFieldsConsentAction(INITIAL_ACTION_STATE);

    expect(grant).toHaveBeenCalledWith(USER, "personal_fields_storage");
    expect(state).toEqual({ failure: null, attempt: 1 });
  });

  it("stores nothing while granting", async () => {
    /**
     * ADR-002: consent is a user action, not a side effect of persistence. An
     * action that saved a value on the way through would make the record describe
     * something other than what the person agreed to.
     */
    await grantPersonalFieldsConsentAction(INITIAL_ACTION_STATE);

    expect(save).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("reports unavailable when nothing was recorded, and invalidates nothing", async () => {
    grant.mockRejectedValue(new Error("audit chain down"));

    const state = await grantPersonalFieldsConsentAction(INITIAL_ACTION_STATE);

    expect(state).toEqual({ failure: "unavailable", attempt: 1 });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("adding a field", () => {
  it("saves what the form carried, as the signed-in user", async () => {
    const state = await addPersonalFieldAction(INITIAL_FORM_STATE, form(VALID));

    expect(save).toHaveBeenCalledWith(USER, {
      fieldKey: "email",
      label: "Personal Gmail",
      value: "alex@example.com",
    });
    expect(state).toEqual({
      failure: null,
      label: null,
      fieldKey: null,
      saved: true,
      attempt: 1,
    });
  });

  it("refuses an unrecognised kind without reaching the service", async () => {
    /**
     * The check constraint would refuse it too, but answering here keeps the
     * database as the second gate rather than the first — and keeps a value that
     * was never going to be stored out of the encryption path.
     */
    const state = await addPersonalFieldAction(
      INITIAL_FORM_STATE,
      form({ ...VALID, fieldKey: "passport_number" }),
    );

    expect(save).not.toHaveBeenCalled();
    expect(state).toEqual({
      failure: "invalid",
      label: "Personal Gmail",
      fieldKey: null,
      attempt: 1,
    });
  });

  it("surfaces the consent gate as its own failure", async () => {
    /**
     * `CONSENT_REQUIRED` is not `INVALID_REQUEST`: the person did nothing wrong,
     * and the section shows the grant panel rather than a validation error.
     */
    save.mockResolvedValue({ ok: false, code: "CONSENT_REQUIRED" });

    const state = await addPersonalFieldAction(INITIAL_FORM_STATE, form(VALID));

    expect(state.failure).toBe("consent_required");
  });

  it.each([
    ["INVALID_REQUEST", "invalid"],
    ["NOT_FOUND", "not_found"],
    ["UNAVAILABLE", "unavailable"],
    ["INTERNAL_ERROR", "unavailable"],
  ])("maps %s to %s", async (code, failure) => {
    save.mockResolvedValue({ ok: false, code });

    expect((await addPersonalFieldAction(INITIAL_FORM_STATE, form(VALID))).failure).toBe(failure);
  });

  it("never returns the value in the state it hands back", async () => {
    /**
     * A preserved value would be re-serialised into the RSC payload after Atlas
     * declined to store it — a plaintext on the wire with nothing to show for it.
     * The label survives because retyping it is a nuisance rather than a risk.
     */
    save.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const state = await addPersonalFieldAction(INITIAL_FORM_STATE, form(VALID));

    expect(JSON.stringify(state)).not.toContain(VALID.value);
    expect(state.label).toBe("Personal Gmail");
  });
});

describe("editing a field", () => {
  it("forwards only the parts the person filled in", async () => {
    await editPersonalFieldAction(
      INITIAL_FORM_STATE,
      form({ fieldId: FIELD, label: "Work email", value: "" }),
    );

    /**
     * Exact, not `objectContaining`: forwarding `value: ""` is how a blank input
     * silently erases a stored value.
     */
    expect(edit).toHaveBeenCalledWith(USER, FIELD, { label: "Work email" });
  });

  it("forwards a value when one was typed", async () => {
    await editPersonalFieldAction(
      INITIAL_FORM_STATE,
      form({ fieldId: FIELD, label: "", value: "new@example.com" }),
    );

    expect(edit).toHaveBeenCalledWith(USER, FIELD, { value: "new@example.com" });
  });

  it("is gated exactly as a save is", async () => {
    /** An edit writes restricted data too, so withdrawal has to stop it. */
    edit.mockResolvedValue({ ok: false, code: "CONSENT_REQUIRED" });

    expect(
      (await editPersonalFieldAction(INITIAL_FORM_STATE, form({ fieldId: FIELD }))).failure,
    ).toBe("consent_required");
  });

  it("reports a foreign or missing field identically", async () => {
    edit.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    expect(
      (await editPersonalFieldAction(INITIAL_FORM_STATE, form({ fieldId: FIELD }))).failure,
    ).toBe("not_found");
  });
});

describe("deleting a field", () => {
  it("removes the field the form named", async () => {
    const state = await deletePersonalFieldAction(INITIAL_ACTION_STATE, form({ fieldId: FIELD }));

    expect(removeField).toHaveBeenCalledWith(USER, FIELD);
    expect(state).toEqual({ failure: null, attempt: 1 });
  });

  it("stays available after consent is withdrawn", async () => {
    /**
     * ADR-002 and security §14: deletion is the safe direction, and gating it
     * would stop someone removing the very values their withdrawal was about. The
     * service does not refuse this, so the action must not either — which is what
     * the absence of a `CONSENT_REQUIRED` branch above the call shows.
     */
    const state = await deletePersonalFieldAction(INITIAL_ACTION_STATE, form({ fieldId: FIELD }));

    expect(state.failure).toBeNull();
    expect(removeField).toHaveBeenCalledTimes(1);
  });
});

describe("revealing a field", () => {
  it("returns the plaintext the service released", async () => {
    expect(await revealPersonalFieldAction(FIELD)).toEqual({
      ok: true,
      value: "alex@example.com",
    });
    expect(reveal).toHaveBeenCalledWith(USER, FIELD);
  });

  it("has no path to a value that skips the service", async () => {
    /**
     * The audit event (`personal_field.revealed`) is written inside
     * `PersonalFieldService.reveal`, before the value is returned. The evidence
     * available at this layer is that the action calls that method and reads
     * nothing else — a listed method is the only source of a plaintext here.
     */
    reveal.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const result = await revealPersonalFieldAction(FIELD);

    expect(result.value).toBeNull();
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it.each(["NOT_FOUND", "FORBIDDEN", "UNAVAILABLE"])(
    "answers %s with the same reasonless refusal",
    async (code) => {
      reveal.mockResolvedValue({ ok: false, code });

      /**
       * The non-oracle rule (ATL-030). Telling "no such field" apart from "not
       * yours" is what makes a guessed id useful to someone who should not have
       * one, so the code is dropped rather than mapped.
       */
      expect(await revealPersonalFieldAction(FIELD)).toEqual({ ok: false, value: null });
    },
  );

  it("does not invalidate the page", async () => {
    /** A reveal changes nothing stored; re-rendering would only re-mask it. */
    await revealPersonalFieldAction(FIELD);

    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("what a write invalidates", () => {
  const paths = () => revalidatePath.mock.calls.map(([path]) => path);

  it.each([
    ["an add", () => addPersonalFieldAction(INITIAL_FORM_STATE, form(VALID)), save],
    [
      "an edit",
      () => editPersonalFieldAction(INITIAL_FORM_STATE, form({ fieldId: FIELD, label: "x" })),
      edit,
    ],
    [
      "a delete",
      () => deletePersonalFieldAction(INITIAL_ACTION_STATE, form({ fieldId: FIELD })),
      removeField,
    ],
  ])("invalidates only /settings after %s", async (_label, run) => {
    await run();

    /**
     * Exact, not `toContain`: a personal field appears on one path, so
     * invalidating more would be work with no reader.
     */
    expect(paths()).toEqual(["/settings"]);
  });

  it.each([
    ["a failed add", () => addPersonalFieldAction(INITIAL_FORM_STATE, form(VALID)), save],
    [
      "a failed edit",
      () => editPersonalFieldAction(INITIAL_FORM_STATE, form({ fieldId: FIELD, label: "x" })),
      edit,
    ],
    [
      "a failed delete",
      () => deletePersonalFieldAction(INITIAL_ACTION_STATE, form({ fieldId: FIELD })),
      removeField,
    ],
  ])("invalidates nothing after %s", async (_label, run, mocked) => {
    mocked.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    await run();

    expect(paths()).toEqual([]);
  });
});

describe("identity and input", () => {
  it("ignores a user id supplied by the caller", async () => {
    /**
     * Architecture §10, CLAUDE.md: "never trust client-provided user IDs". A
     * tampered form carrying someone else's id must be inert — the action reads
     * the session and passes that.
     */
    await addPersonalFieldAction(INITIAL_FORM_STATE, form({ ...VALID, userId: OTHER }));

    expect(save).toHaveBeenCalledWith(USER, {
      fieldKey: "email",
      label: "Personal Gmail",
      value: "alex@example.com",
    });
  });

  it.each([
    [
      "a delete",
      () =>
        deletePersonalFieldAction(INITIAL_ACTION_STATE, form({ fieldId: FIELD, userId: OTHER })),
      removeField,
    ],
    [
      "an edit",
      () =>
        editPersonalFieldAction(
          INITIAL_FORM_STATE,
          form({ fieldId: FIELD, label: "x", userId: OTHER }),
        ),
      edit,
    ],
  ])("passes the session user to %s regardless of the payload", async (_label, run, mocked) => {
    await run();

    expect(mocked.mock.calls[0]?.[0]).toBe(USER);
  });

  it("treats a File as an absent field rather than as text", async () => {
    /**
     * `FormData.get` returns `string | File`, and a `File` stringifies to
     * `[object File]` — a plausible-looking id or value. The `text` helper drops
     * anything that is not a string.
     */
    removeField.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    const data = new FormData();
    data.append("fieldId", new File([], "not-an-id.txt"));

    expect(await deletePersonalFieldAction(INITIAL_ACTION_STATE, data)).toEqual({
      failure: "not_found",
      attempt: 1,
    });
    expect(removeField).toHaveBeenCalledWith(USER, "");
  });
});

describe("attempt semantics", () => {
  it("increments from whatever the previous state carried", async () => {
    /**
     * `attempt` keys the alert that reports a failure, so a second identical
     * failure is announced again rather than sitting silently in the DOM.
     */
    const state = await addPersonalFieldAction({ ...INITIAL_FORM_STATE, attempt: 4 }, form(VALID));

    expect(state.attempt).toBe(5);
  });

  it("increments on failure as well as success", async () => {
    save.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const once = await addPersonalFieldAction(INITIAL_FORM_STATE, form(VALID));
    const twice = await addPersonalFieldAction(once, form(VALID));

    expect([once.attempt, twice.attempt]).toEqual([1, 2]);
  });
});
