import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Settings server actions — ATL-209 additions and changes (ATL-106 + ATL-209).
 *
 * This file covers the two ATL-209 changes to `settings/actions.ts`:
 *
 *   1. `deletePersonalFieldAction` now calls `removeField()` (not `remove()`), so
 *      in-progress discovery runs block deletion.  Tests assert:
 *        - FIELD_IN_USE is mapped to the "field_in_use" failure (not "unavailable").
 *        - The service call is `removeField`, not `remove`.
 *        - Successful deletion revalidates /settings.
 *
 *   2. `setIncludeInDiscoveryAction` is a new direct-call action (not useActionState).
 *      Tests assert:
 *        - Happy path returns { ok: true } and revalidates /settings.
 *        - Service failure returns { ok: false } without revalidating.
 *        - The user id comes from requireVerifiedUser, not from the caller.
 *
 * The existing actions (add, edit, grantConsent, reveal) are tested elsewhere;
 * their ATL-209 behaviour is unchanged.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 4).toString("base64") },
}));

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]): void => {
    mockRevalidatePath(...args);
  },
}));

const mockRequireVerifiedUser = vi.fn();
vi.mock("@/server/auth/require-user", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  requireVerifiedUser: () => mockRequireVerifiedUser(),
}));

// PersonalFieldService: only the methods touched by the two ATL-209 actions.
const mockRemoveField = vi.fn();
const mockSetIncludeInDiscovery = vi.fn();
vi.mock("@/server/personal-fields/personal-field-service", () => ({
  PersonalFieldService: {
    create: () => ({
      removeField: mockRemoveField,
      setIncludeInDiscovery: mockSetIncludeInDiscovery,
    }),
  },
}));

// ConsentService is imported by the module but only used by grantConsent; stub it.
vi.mock("@/server/consent/consent-service", () => ({
  ConsentService: { create: () => ({ grant: vi.fn() }) },
}));

import {
  deletePersonalFieldAction,
  setIncludeInDiscoveryAction,
} from "@/app/(product)/settings/actions";
import { INITIAL_PERSONAL_FIELD_ACTION_STATE } from "@/app/(product)/settings/form-state";

// ── Helpers ────────────────────────────────────────────────────────────────────

const FAKE_USER = { id: "user-settings-atl209" };

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  return fd;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("settings/actions — ATL-209 (ATL-106 + ATL-209)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireVerifiedUser.mockResolvedValue(FAKE_USER);
  });

  // ── deletePersonalFieldAction ───────────────────────────────────────────────

  describe("deletePersonalFieldAction", () => {
    it("calls removeField (not remove) with the server-resolved user id and fieldId", async () => {
      mockRemoveField.mockResolvedValue({ ok: true, data: { id: "field-99" } });
      const fd = makeFormData({ fieldId: "field-99" });

      await deletePersonalFieldAction(INITIAL_PERSONAL_FIELD_ACTION_STATE, fd);

      expect(mockRemoveField).toHaveBeenCalledOnce();
      const [calledUserId, calledFieldId] = mockRemoveField.mock.calls[0] as [string, string];
      expect(calledUserId).toBe(FAKE_USER.id);
      expect(calledFieldId).toBe("field-99");
    });

    it("revalidates /settings on successful deletion", async () => {
      mockRemoveField.mockResolvedValue({ ok: true, data: { id: "field-99" } });

      await deletePersonalFieldAction(
        INITIAL_PERSONAL_FIELD_ACTION_STATE,
        makeFormData({ fieldId: "field-99" }),
      );

      expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
    });

    it("maps FIELD_IN_USE to failure 'field_in_use' (not 'unavailable')", async () => {
      mockRemoveField.mockResolvedValue({ ok: false, code: "FIELD_IN_USE" });

      const result = await deletePersonalFieldAction(
        INITIAL_PERSONAL_FIELD_ACTION_STATE,
        makeFormData({ fieldId: "field-in-use" }),
      );

      expect(result.failure).toBe("field_in_use");
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("maps NOT_FOUND to failure 'not_found'", async () => {
      mockRemoveField.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

      const result = await deletePersonalFieldAction(
        INITIAL_PERSONAL_FIELD_ACTION_STATE,
        makeFormData({ fieldId: "missing" }),
      );

      expect(result.failure).toBe("not_found");
    });

    it("maps other service codes to failure 'unavailable'", async () => {
      mockRemoveField.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

      const result = await deletePersonalFieldAction(
        INITIAL_PERSONAL_FIELD_ACTION_STATE,
        makeFormData({ fieldId: "field-1" }),
      );

      expect(result.failure).toBe("unavailable");
    });

    it("increments attempt on each call", async () => {
      mockRemoveField.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
      const previous = { failure: null, attempt: 3 };

      const result = await deletePersonalFieldAction(previous, makeFormData({ fieldId: "f" }));

      expect(result.attempt).toBe(4);
    });

    it("does not revalidate when the service returns a failure", async () => {
      mockRemoveField.mockResolvedValue({ ok: false, code: "FIELD_IN_USE" });

      await deletePersonalFieldAction(
        INITIAL_PERSONAL_FIELD_ACTION_STATE,
        makeFormData({ fieldId: "field-1" }),
      );

      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });
  });

  // ── setIncludeInDiscoveryAction ─────────────────────────────────────────────

  describe("setIncludeInDiscoveryAction", () => {
    it("calls setIncludeInDiscovery with userId, fieldId, and enabled=true", async () => {
      mockSetIncludeInDiscovery.mockResolvedValue({ ok: true, data: {} });

      await setIncludeInDiscoveryAction("field-42", true);

      expect(mockSetIncludeInDiscovery).toHaveBeenCalledWith(FAKE_USER.id, "field-42", true);
    });

    it("calls setIncludeInDiscovery with enabled=false when toggling off", async () => {
      mockSetIncludeInDiscovery.mockResolvedValue({ ok: true, data: {} });

      await setIncludeInDiscoveryAction("field-42", false);

      expect(mockSetIncludeInDiscovery.mock.calls[0]?.[2]).toBe(false);
    });

    it("returns { ok: true } and revalidates /settings on success", async () => {
      mockSetIncludeInDiscovery.mockResolvedValue({ ok: true, data: {} });

      const result = await setIncludeInDiscoveryAction("field-42", true);

      expect(result.ok).toBe(true);
      expect(mockRevalidatePath).toHaveBeenCalledWith("/settings");
    });

    it("returns { ok: false } and does not revalidate on service failure", async () => {
      mockSetIncludeInDiscovery.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

      const result = await setIncludeInDiscoveryAction("field-42", true);

      expect(result.ok).toBe(false);
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it("uses the server-resolved user id, not a caller-supplied one", async () => {
      mockSetIncludeInDiscovery.mockResolvedValue({ ok: true, data: {} });

      await setIncludeInDiscoveryAction("field-42", true);

      // First argument must be the id from requireVerifiedUser.
      expect(mockSetIncludeInDiscovery.mock.calls[0]?.[0]).toBe(FAKE_USER.id);
    });
  });
});
