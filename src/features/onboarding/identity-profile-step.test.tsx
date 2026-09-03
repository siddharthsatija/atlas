import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IdentityProfileStep } from "@/features/onboarding";
import type { IdentityProfileFieldView, IdentityProfileStepProps } from "@/features/onboarding";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 6).toString("base64") },
}));

/**
 * IdentityProfileStep (ATL-209).
 *
 * First component-level test suite in the codebase. Requires vitest configured
 * with a JSDOM environment (environment: 'jsdom' in vitest.config.ts) and
 * @testing-library/react + @testing-library/user-event in devDependencies.
 *
 * Tests cover the behaviours that matter most for product correctness:
 *
 *   Soft email gate
 *   ├── No warning when there are no fields.
 *   ├── No warning when consent has not been granted (not storage-permitted).
 *   ├── Shows warning when fields exist but no email with includeInDiscovery=true.
 *   └── No warning when at least one email field has includeInDiscovery=true.
 *
 *   Consent gate
 *   ├── Shows consent panel (grant-button) when isStoragePermitted=false.
 *   └── Shows add form (Kind-of-detail select) when isStoragePermitted=true.
 *
 *   Continue button
 *   ├── Always enabled (never blocked, even with the soft gate warning present).
 *   ├── Calls completeAction with the correct isUpgradeMode value.
 *   └── Calls onAdvance for new users after completeAction returns.
 *
 *   Delete confirmation
 *   ├── Clicking Delete shows inline confirm UI.
 *   ├── Keep it cancels without calling removeFieldAction.
 *   └── Delete permanently calls removeFieldAction with the correct field id.
 *
 *   field_in_use error
 *   └── Shows the field-in-use error copy and keeps the field in the list.
 *
 * Selectors use ARIA roles, label text, and data-slot attribute queries —
 * no dependency on a custom testIdAttribute configuration.
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

function slot(name: string): Element | null {
  return document.querySelector(`[data-slot="${name}"]`);
}

function makeField(overrides: Partial<IdentityProfileFieldView> = {}): IdentityProfileFieldView {
  return {
    id: "field-1",
    fieldKey: "phone",
    label: "Mobile",
    maskedValue: "***89",
    includeInDiscovery: false,
    ...overrides,
  };
}

function makeProps(overrides: Partial<IdentityProfileStepProps> = {}): IdentityProfileStepProps {
  return {
    isStoragePermitted: true,
    initialFields: [],
    isUpgradeMode: false,
    grantConsentAction: vi.fn().mockResolvedValue({ failure: null, attempt: 1 }),
    addFieldAction: vi.fn().mockResolvedValue({ ok: false, failure: "unavailable" }),
    setDiscoveryAction: vi.fn().mockResolvedValue({ ok: true }),
    removeFieldAction: vi.fn().mockResolvedValue({ ok: true }),
    completeAction: vi.fn().mockResolvedValue(undefined),
    onAdvance: vi.fn(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("IdentityProfileStep (ATL-209)", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Soft email gate ────────────────────────────────────────────────────────

  describe("soft email gate", () => {
    it("does not show the email warning when there are no fields", () => {
      render(<IdentityProfileStep {...makeProps({ initialFields: [] })} />);

      expect(slot("identity-profile-email-gate")).toBeNull();
    });

    it("does not show the email warning when isStoragePermitted=false", () => {
      const phoneField = makeField({ fieldKey: "phone", includeInDiscovery: false });
      render(
        <IdentityProfileStep
          {...makeProps({ isStoragePermitted: false, initialFields: [phoneField] })}
        />,
      );

      expect(slot("identity-profile-email-gate")).toBeNull();
    });

    it("shows the email warning when fields exist but no discoverable email", () => {
      const phoneField = makeField({ fieldKey: "phone", includeInDiscovery: false });
      render(<IdentityProfileStep {...makeProps({ initialFields: [phoneField] })} />);

      // The gate has role="status" and data-slot="identity-profile-email-gate"
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(slot("identity-profile-email-gate")).not.toBeNull();
    });

    it("does not show the warning when an email field has includeInDiscovery=true", () => {
      const emailField = makeField({
        fieldKey: "email",
        label: "Work email",
        includeInDiscovery: true,
      });
      render(<IdentityProfileStep {...makeProps({ initialFields: [emailField] })} />);

      expect(slot("identity-profile-email-gate")).toBeNull();
    });

    it("shows the warning when an email field exists but includeInDiscovery=false", () => {
      const emailField = makeField({
        fieldKey: "email",
        label: "Work email",
        includeInDiscovery: false,
      });
      render(<IdentityProfileStep {...makeProps({ initialFields: [emailField] })} />);

      expect(slot("identity-profile-email-gate")).not.toBeNull();
    });
  });

  // ── Consent gate ───────────────────────────────────────────────────────────

  describe("consent gate", () => {
    it("shows the consent panel when isStoragePermitted=false", () => {
      render(<IdentityProfileStep {...makeProps({ isStoragePermitted: false })} />);

      // PersonalFieldsConsent renders inside the consent-gate slot
      expect(slot("identity-profile-consent-gate")).not.toBeNull();
      expect(slot("identity-profile-add-form")).toBeNull();
    });

    it("shows the add form (Kind-of-detail select) when isStoragePermitted=true", () => {
      render(<IdentityProfileStep {...makeProps({ isStoragePermitted: true })} />);

      expect(slot("identity-profile-add-form")).not.toBeNull();
      // The kind-of-detail select has a label
      expect(screen.getByLabelText(/kind of detail/i)).toBeInTheDocument();
      expect(slot("identity-profile-consent-gate")).toBeNull();
    });
  });

  // ── Continue button ────────────────────────────────────────────────────────

  describe("Continue button", () => {
    it("is rendered and enabled at all times", () => {
      render(<IdentityProfileStep {...makeProps()} />);

      const btn = slot("identity-profile-continue") as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      expect(btn!.disabled).toBe(false);
    });

    it("is still enabled even when the soft email gate warning is showing", () => {
      const phoneField = makeField({ fieldKey: "phone" });
      render(<IdentityProfileStep {...makeProps({ initialFields: [phoneField] })} />);

      expect(slot("identity-profile-email-gate")).not.toBeNull();
      const btn = slot("identity-profile-continue") as HTMLButtonElement | null;
      expect(btn!.disabled).toBe(false);
    });

    it("calls completeAction with isUpgradeMode=false for new users", async () => {
      const props = makeProps({ isUpgradeMode: false });
      render(<IdentityProfileStep {...props} />);

      await userEvent.click(slot("identity-profile-continue") as HTMLElement);

      expect(props.completeAction).toHaveBeenCalledWith(false);
    });

    it("calls completeAction with isUpgradeMode=true for upgrade-mode users", async () => {
      const props = makeProps({ isUpgradeMode: true });
      render(<IdentityProfileStep {...props} />);

      await userEvent.click(slot("identity-profile-continue") as HTMLElement);

      expect(props.completeAction).toHaveBeenCalledWith(true);
    });

    it("calls onAdvance after completeAction returns for new users", async () => {
      const props = makeProps({ isUpgradeMode: false });
      render(<IdentityProfileStep {...props} />);

      await userEvent.click(slot("identity-profile-continue") as HTMLElement);

      expect(props.onAdvance).toHaveBeenCalledOnce();
    });
  });

  // ── Delete confirmation ────────────────────────────────────────────────────

  describe("inline delete confirmation", () => {
    it("shows the confirm UI after clicking Delete", async () => {
      const field = makeField({ id: "f1", label: "My field" });
      render(<IdentityProfileStep {...makeProps({ initialFields: [field] })} />);

      await userEvent.click(slot("identity-profile-field-delete-trigger") as HTMLElement);

      expect(slot("identity-profile-field-confirm-remove")).not.toBeNull();
    });

    it("cancels without calling removeFieldAction when Keep it is clicked", async () => {
      const props = makeProps({ initialFields: [makeField({ id: "f1" })] });
      render(<IdentityProfileStep {...props} />);

      await userEvent.click(slot("identity-profile-field-delete-trigger") as HTMLElement);
      await userEvent.click(slot("identity-profile-field-cancel-delete") as HTMLElement);

      expect(props.removeFieldAction).not.toHaveBeenCalled();
      expect(slot("identity-profile-field-confirm-remove")).toBeNull();
    });

    it("calls removeFieldAction with the field id when Delete permanently is clicked", async () => {
      const props = makeProps({
        initialFields: [makeField({ id: "f-del-1" })],
        removeFieldAction: vi.fn().mockResolvedValue({ ok: true }),
      });
      render(<IdentityProfileStep {...props} />);

      await userEvent.click(slot("identity-profile-field-delete-trigger") as HTMLElement);
      await userEvent.click(slot("identity-profile-field-confirm-delete") as HTMLElement);

      expect(props.removeFieldAction).toHaveBeenCalledWith("f-del-1");
    });

    it("removes the field row from the list on successful deletion", async () => {
      const props = makeProps({
        initialFields: [makeField({ id: "f-del-2", label: "To delete" })],
        removeFieldAction: vi.fn().mockResolvedValue({ ok: true }),
      });
      render(<IdentityProfileStep {...props} />);

      await userEvent.click(slot("identity-profile-field-delete-trigger") as HTMLElement);
      await userEvent.click(slot("identity-profile-field-confirm-delete") as HTMLElement);

      expect(slot("identity-profile-field-row")).toBeNull();
    });
  });

  // ── field_in_use error ─────────────────────────────────────────────────────

  describe("field_in_use error", () => {
    it("shows the discovery-run error copy when removeFieldAction returns field_in_use", async () => {
      const props = makeProps({
        initialFields: [makeField({ id: "f-busy" })],
        removeFieldAction: vi.fn().mockResolvedValue({
          ok: false,
          fieldInUse: true,
          failure: "field_in_use",
        }),
      });
      render(<IdentityProfileStep {...props} />);

      await userEvent.click(slot("identity-profile-field-delete-trigger") as HTMLElement);
      await userEvent.click(slot("identity-profile-field-confirm-delete") as HTMLElement);

      const error = slot("identity-profile-field-remove-error");
      expect(error).not.toBeNull();
      expect(error!.textContent).toMatch(/active discovery run/i);
    });

    it("keeps the field in the list when removeFieldAction returns field_in_use", async () => {
      const props = makeProps({
        initialFields: [makeField({ id: "f-busy", label: "Busy field" })],
        removeFieldAction: vi.fn().mockResolvedValue({
          ok: false,
          fieldInUse: true,
          failure: "field_in_use",
        }),
      });
      render(<IdentityProfileStep {...props} />);

      await userEvent.click(slot("identity-profile-field-delete-trigger") as HTMLElement);
      await userEvent.click(slot("identity-profile-field-confirm-delete") as HTMLElement);

      expect(slot("identity-profile-field-row")).not.toBeNull();
    });
  });
});
