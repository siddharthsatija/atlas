/**
 * discovery-consent-actions.test.ts (ATL-210).
 *
 * Server action tests for onboarding discovery consent. Key invariants:
 *
 * 1. Disallowed consent types (including discovery_connected_sources) are
 *    rejected WITHOUT calling auth or the service.
 * 2. Empty-string arguments are rejected without calling auth or the service.
 * 3. The userId comes exclusively from requireVerifiedUser, never from input.
 * 4. A service throw returns failure: "unavailable" and increments attempt.
 * 5. Success returns failure: null and increments attempt.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: vi.fn(() => ({})),
}));
vi.mock("@/server/auth/require-user", () => ({
  requireVerifiedUser: vi.fn(),
}));
vi.mock("@/server/discovery/discovery-consent-service", () => ({
  DiscoveryConsentService: {
    create: vi.fn(),
  },
}));

import { requireVerifiedUser } from "@/server/auth/require-user";
import { DiscoveryConsentService } from "@/server/discovery/discovery-consent-service";
import {
  grantDiscoveryConsentForOnboardingAction,
  acknowledgeDisclosureForOnboardingAction,
} from "./discovery-consent-actions";

const INITIAL = { failure: null, attempt: 0 };

const mockGrantConsent = vi.fn();
const mockRecordAck = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireVerifiedUser).mockResolvedValue({ id: "user-123" } as Awaited<
    ReturnType<typeof requireVerifiedUser>
  >);
  vi.mocked(DiscoveryConsentService).create.mockReturnValue({
    grantConsent: mockGrantConsent,
    recordFirstDisclosureAcknowledgment: mockRecordAck,
  } as unknown as ReturnType<typeof DiscoveryConsentService.create>);
  mockGrantConsent.mockResolvedValue(undefined);
  mockRecordAck.mockResolvedValue(undefined);
});

describe("grantDiscoveryConsentForOnboardingAction", () => {
  it("grants consent and returns success", async () => {
    const result = await grantDiscoveryConsentForOnboardingAction(
      "discovery_hashed_query",
      INITIAL,
    );
    expect(result.failure).toBeNull();
    expect(result.attempt).toBe(1);
    expect(mockGrantConsent).toHaveBeenCalledWith("user-123", "discovery_hashed_query");
  });

  it("rejects discovery_connected_sources without calling auth", async () => {
    const result = await grantDiscoveryConsentForOnboardingAction(
      "discovery_connected_sources",
      INITIAL,
    );
    expect(result.failure).toBe("unavailable");
    expect(requireVerifiedUser).not.toHaveBeenCalled();
    expect(mockGrantConsent).not.toHaveBeenCalled();
  });

  it("rejects unknown consent types without calling auth", async () => {
    const result = await grantDiscoveryConsentForOnboardingAction(
      "discovery_unknown_type" as never,
      INITIAL,
    );
    expect(result.failure).toBe("unavailable");
    expect(requireVerifiedUser).not.toHaveBeenCalled();
  });

  it("returns failure when service throws", async () => {
    mockGrantConsent.mockRejectedValue(new Error("DB error"));
    const result = await grantDiscoveryConsentForOnboardingAction("discovery_identifying", INITIAL);
    expect(result.failure).toBe("unavailable");
    expect(result.attempt).toBe(1);
  });

  it("increments attempt on each call", async () => {
    const r1 = await grantDiscoveryConsentForOnboardingAction("discovery_hashed_query", INITIAL);
    const r2 = await grantDiscoveryConsentForOnboardingAction("discovery_hashed_query", r1);
    expect(r2.attempt).toBe(2);
  });

  it("uses userId from requireVerifiedUser, not from args", async () => {
    vi.mocked(requireVerifiedUser).mockResolvedValue({ id: "real-user" } as never);
    await grantDiscoveryConsentForOnboardingAction("discovery_hashed_query", INITIAL);
    expect(mockGrantConsent).toHaveBeenCalledWith("real-user", expect.any(String));
  });
});

describe("acknowledgeDisclosureForOnboardingAction", () => {
  it("records acknowledgment and returns success", async () => {
    const result = await acknowledgeDisclosureForOnboardingAction(
      "field-1",
      "provider.example",
      "v1.0",
      INITIAL,
    );
    expect(result.failure).toBeNull();
    expect(result.attempt).toBe(1);
    expect(mockRecordAck).toHaveBeenCalledWith("user-123", "field-1", "provider.example", "v1.0");
  });

  it("rejects empty fieldId without calling auth", async () => {
    const result = await acknowledgeDisclosureForOnboardingAction(
      "",
      "provider.example",
      "v1.0",
      INITIAL,
    );
    expect(result.failure).toBe("unavailable");
    expect(requireVerifiedUser).not.toHaveBeenCalled();
  });

  it("rejects empty providerClass without calling auth", async () => {
    const result = await acknowledgeDisclosureForOnboardingAction("field-1", "", "v1.0", INITIAL);
    expect(result.failure).toBe("unavailable");
    expect(requireVerifiedUser).not.toHaveBeenCalled();
  });

  it("rejects empty disclosureContractVersion without calling auth", async () => {
    const result = await acknowledgeDisclosureForOnboardingAction(
      "field-1",
      "provider.example",
      "",
      INITIAL,
    );
    expect(result.failure).toBe("unavailable");
    expect(requireVerifiedUser).not.toHaveBeenCalled();
  });

  it("returns failure when service throws", async () => {
    mockRecordAck.mockRejectedValue(new Error("DB error"));
    const result = await acknowledgeDisclosureForOnboardingAction(
      "field-1",
      "provider.example",
      "v1.0",
      INITIAL,
    );
    expect(result.failure).toBe("unavailable");
  });

  it("uses userId from requireVerifiedUser", async () => {
    vi.mocked(requireVerifiedUser).mockResolvedValue({ id: "ack-user" } as never);
    await acknowledgeDisclosureForOnboardingAction("f", "p", "v", INITIAL);
    expect(mockRecordAck).toHaveBeenCalledWith("ack-user", "f", "p", "v");
  });
});
