import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * identity-profile-actions.ts (ATL-209).
 *
 * Server actions for the Identity Profile onboarding step. Tests cover:
 *
 *   - Authorization: every action calls `requireVerifiedUser` and the user id
 *     never comes from a caller-supplied argument.
 *   - Key restriction: `saveOnboardingFieldAction` accepts only the four
 *     discovery-relevant keys (email, full_name, phone, address) and rejects
 *     username and other.
 *   - Empty-value guard: empty label or value → invalid, never stored.
 *   - Consent requirement: save returns consent_required when the service says so.
 *   - field_in_use: removeOnboardingFieldAction surfaces this failure with
 *     fieldInUse=true so the component can display the truthful copy.
 *   - not_found: removeOnboardingFieldAction surfaces this failure correctly.
 *   - completeIdentityProfileStepAction: redirects only for upgrade-mode users;
 *     new users receive a normal return.
 *
 * Isolation: server modules are stubbed at the boundary, not at the database.
 * The module under test is imported *after* vi.mock calls so hoisting applies.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 5).toString("base64") },
}));

// Redirect throws in Next.js; capture the throw so tests can assert on it.
const mockRedirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({ redirect: (path: string) => mockRedirect(path) }));

const mockRequireVerifiedUser = vi.fn();
vi.mock("@/server/auth/require-user", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  requireVerifiedUser: () => mockRequireVerifiedUser(),
}));

// ConsentService used by grantStorageConsentForOnboardingAction directly.
const mockConsentGrant = vi.fn();
vi.mock("@/server/consent/consent-service", () => ({
  ConsentService: { create: () => ({ grant: mockConsentGrant }) },
}));

// PersonalFieldService calls made by the field-mutation actions.
const mockSave = vi.fn();
const mockSetInclude = vi.fn();
const mockRemoveField = vi.fn();
vi.mock("@/server/personal-fields/personal-field-service", () => ({
  PersonalFieldService: {
    create: () => ({
      save: mockSave,
      setIncludeInDiscovery: mockSetInclude,
      removeField: mockRemoveField,
    }),
  },
}));

// OnboardingService.completeIdentityProfileStep called by completeIdentityProfileStepAction.
const mockCompleteStep = vi.fn();
vi.mock("@/server/onboarding/onboarding-service", () => ({
  OnboardingService: { create: () => ({ completeIdentityProfileStep: mockCompleteStep }) },
}));

// maskValue is used inside saveOnboardingFieldAction to mask the returned value.
vi.mock("@/lib/formatting/mask", () => ({ maskValue: (v: string) => `***${v.slice(-2)}` }));

import {
  grantStorageConsentForOnboardingAction,
  saveOnboardingFieldAction,
  setOnboardingFieldDiscoveryAction,
  removeOnboardingFieldAction,
  completeIdentityProfileStepAction,
} from "@/app/(onboarding)/onboarding/identity-profile-actions";

// ── Helpers ────────────────────────────────────────────────────────────────────

const FAKE_USER = { id: "user-atl209" };
const INITIAL_ACTION_STATE = { failure: null, attempt: 0 };

function fakeField(overrides: Record<string, unknown> = {}) {
  return {
    id: "field-1",
    fieldKey: "email",
    label: "Work email",
    maskedValue: "***il",
    includeInDiscovery: false,
    userId: FAKE_USER.id,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    lastUsedAt: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("identity-profile-actions (ATL-209)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireVerifiedUser.mockResolvedValue(FAKE_USER);
  });

  // ── grantStorageConsentForOnboardingAction ──────────────────────────────────

  describe("grantStorageConsentForOnboardingAction", () => {
    it("calls ConsentService.grant with personal_fields_storage", async () => {
      mockConsentGrant.mockResolvedValue(undefined);
      const result = await grantStorageConsentForOnboardingAction(INITIAL_ACTION_STATE);

      expect(mockConsentGrant).toHaveBeenCalledWith(FAKE_USER.id, "personal_fields_storage");
      expect(result.failure).toBeNull();
    });

    it("returns { failure: 'unavailable' } when ConsentService.grant throws", async () => {
      mockConsentGrant.mockRejectedValue(new Error("db down"));
      const result = await grantStorageConsentForOnboardingAction(INITIAL_ACTION_STATE);

      expect(result.failure).toBe("unavailable");
      expect(result.attempt).toBe(1);
    });

    it("uses the user id from requireVerifiedUser, not from the caller", async () => {
      mockConsentGrant.mockResolvedValue(undefined);
      await grantStorageConsentForOnboardingAction(INITIAL_ACTION_STATE);

      // The grant call must use the server-resolved user id.
      expect(mockConsentGrant.mock.calls[0]?.[0]).toBe(FAKE_USER.id);
    });
  });

  // ── saveOnboardingFieldAction ───────────────────────────────────────────────

  describe("saveOnboardingFieldAction", () => {
    it("saves an allowed key and returns the field view", async () => {
      const saved = fakeField();
      mockSave.mockResolvedValue({ ok: true, data: saved });

      const result = await saveOnboardingFieldAction("email", "Work email", "test@example.com");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.field.fieldKey).toBe("email");
        expect(result.field.label).toBe("Work email");
        // maskedValue comes from maskValue mock: "***il"
        expect(result.field.maskedValue).toBeDefined();
      }
    });

    it("rejects the 'username' key", async () => {
      const result = await saveOnboardingFieldAction("username", "Handle", "@handle");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe("invalid");
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("rejects the 'other' key", async () => {
      const result = await saveOnboardingFieldAction("other", "Other", "value");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe("invalid");
      expect(mockSave).not.toHaveBeenCalled();
    });

    it.each(["email", "full_name", "phone", "address"] as const)(
      "accepts allowed key: %s",
      async (key) => {
        mockSave.mockResolvedValue({ ok: true, data: fakeField({ fieldKey: key }) });
        const result = await saveOnboardingFieldAction(key, "Label", "Value");
        expect(result.ok).toBe(true);
      },
    );

    it("returns { failure: 'invalid' } for an empty label", async () => {
      const result = await saveOnboardingFieldAction("email", "   ", "value@example.com");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe("invalid");
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("returns { failure: 'invalid' } for an empty value", async () => {
      const result = await saveOnboardingFieldAction("email", "Work email", "   ");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe("invalid");
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("returns { failure: 'consent_required' } when the service requires consent", async () => {
      mockSave.mockResolvedValue({ ok: false, code: "CONSENT_REQUIRED" });

      const result = await saveOnboardingFieldAction("email", "Work email", "test@example.com");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe("consent_required");
    });

    it("returns { failure: 'unavailable' } for any other service failure", async () => {
      mockSave.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

      const result = await saveOnboardingFieldAction("email", "Work email", "test@example.com");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure).toBe("unavailable");
    });

    it("calls save with the server-resolved user id", async () => {
      mockSave.mockResolvedValue({ ok: true, data: fakeField() });
      await saveOnboardingFieldAction("email", "Work email", "test@example.com");

      expect(mockSave.mock.calls[0]?.[0]).toBe(FAKE_USER.id);
    });

    it("trims whitespace from label and value before saving", async () => {
      mockSave.mockResolvedValue({ ok: true, data: fakeField() });
      await saveOnboardingFieldAction("email", "  Work email  ", "  test@example.com  ");

      const [, input] = mockSave.mock.calls[0] as [string, { label: string; value: string }];
      expect(input.label).toBe("Work email");
      expect(input.value).toBe("test@example.com");
    });
  });

  // ── setOnboardingFieldDiscoveryAction ───────────────────────────────────────

  describe("setOnboardingFieldDiscoveryAction", () => {
    it("calls setIncludeInDiscovery with userId, fieldId, and enabled", async () => {
      mockSetInclude.mockResolvedValue({ ok: true, data: fakeField({ includeInDiscovery: true }) });

      const result = await setOnboardingFieldDiscoveryAction("field-1", true);

      expect(mockSetInclude).toHaveBeenCalledWith(FAKE_USER.id, "field-1", true);
      expect(result.ok).toBe(true);
    });

    it("returns { ok: false } when the service fails", async () => {
      mockSetInclude.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

      const result = await setOnboardingFieldDiscoveryAction("field-1", true);

      expect(result.ok).toBe(false);
    });

    it("uses the server-resolved user id", async () => {
      mockSetInclude.mockResolvedValue({ ok: true, data: fakeField() });
      await setOnboardingFieldDiscoveryAction("field-1", false);

      expect(mockSetInclude.mock.calls[0]?.[0]).toBe(FAKE_USER.id);
    });
  });

  // ── removeOnboardingFieldAction ─────────────────────────────────────────────

  describe("removeOnboardingFieldAction", () => {
    it("returns { ok: true } on successful deletion", async () => {
      mockRemoveField.mockResolvedValue({ ok: true, data: { id: "field-1" } });

      const result = await removeOnboardingFieldAction("field-1");

      expect(result.ok).toBe(true);
    });

    it("returns { ok: false, fieldInUse: true, failure: 'field_in_use' } on FIELD_IN_USE", async () => {
      mockRemoveField.mockResolvedValue({ ok: false, code: "FIELD_IN_USE" });

      const result = await removeOnboardingFieldAction("field-1");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure).toBe("field_in_use");
        expect(result.fieldInUse).toBe(true);
      }
    });

    it("returns { ok: false, fieldInUse: false, failure: 'not_found' } on NOT_FOUND", async () => {
      mockRemoveField.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

      const result = await removeOnboardingFieldAction("field-1");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure).toBe("not_found");
        expect(result.fieldInUse).toBe(false);
      }
    });

    it("returns { ok: false, fieldInUse: false, failure: 'unavailable' } for other failures", async () => {
      mockRemoveField.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

      const result = await removeOnboardingFieldAction("field-1");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure).toBe("unavailable");
        expect(result.fieldInUse).toBe(false);
      }
    });

    it("calls removeField with the server-resolved user id, not a caller-supplied one", async () => {
      mockRemoveField.mockResolvedValue({ ok: true, data: { id: "field-1" } });
      await removeOnboardingFieldAction("field-1");

      expect(mockRemoveField.mock.calls[0]?.[0]).toBe(FAKE_USER.id);
    });
  });

  // ── completeIdentityProfileStepAction ──────────────────────────────────────

  describe("completeIdentityProfileStepAction", () => {
    it("calls completeIdentityProfileStep with the server-resolved user id", async () => {
      mockCompleteStep.mockResolvedValue(undefined);

      await completeIdentityProfileStepAction(false);

      expect(mockCompleteStep).toHaveBeenCalledWith(FAKE_USER.id);
    });

    it("calls redirect('/overview') for upgrade-mode users", async () => {
      mockCompleteStep.mockResolvedValue(undefined);

      await expect(completeIdentityProfileStepAction(true)).rejects.toThrow(
        "NEXT_REDIRECT:/overview",
      );
      expect(mockRedirect).toHaveBeenCalledWith("/overview");
    });

    it("returns normally (no redirect) for new users", async () => {
      mockCompleteStep.mockResolvedValue(undefined);

      await expect(completeIdentityProfileStepAction(false)).resolves.toBeUndefined();
      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it("calls completeIdentityProfileStep before redirect, not after", async () => {
      const callOrder: string[] = [];
      mockCompleteStep.mockImplementation(() => {
        callOrder.push("complete");
        return Promise.resolve();
      });
      mockRedirect.mockImplementation((path: string) => {
        callOrder.push("redirect");
        throw new Error(`NEXT_REDIRECT:${path}`);
      });

      await expect(completeIdentityProfileStepAction(true)).rejects.toThrow();

      expect(callOrder).toEqual(["complete", "redirect"]);
    });
  });
});
