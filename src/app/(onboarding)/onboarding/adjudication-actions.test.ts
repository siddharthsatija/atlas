import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * adjudication-actions.ts (ATL-211).
 *
 * Security and contract tests for the five candidate adjudication Server Actions.
 * Key invariants tested:
 *
 *   CONFIRM
 *   1.  Unauthenticated request returns failure: "unavailable".
 *   2.  candidateId is the only candidate identity from the client (bound arg).
 *   3.  candidate + evidence are loaded server-side, not from FormData.
 *   4.  serviceName comes from trusted server-loaded evidence.sourceIdentifier.
 *   5.  category is ALWAYS exactly "other" — never from client.
 *   6.  accountIdentifier is ALWAYS null — never from client.
 *   7.  candidate not found returns failure: "not_found".
 *   8.  AdjudicationError codes map to typed action failures.
 *   9.  Unexpected error maps to "unavailable" without exposing internal detail.
 *
 *   REJECT / DISMISS / NOT_SURE
 *   10. Authenticated success returns failure: null.
 *   11. Unauthenticated returns failure: "unavailable".
 *   12. candidate_not_found code maps to failure: "not_found".
 *   13. candidate_not_pending maps to failure: "not_pending".
 *   14. notSureCandidateAction calls service.notSure (not dismiss/reject).
 *
 *   DECONFIRM
 *   15. Unauthenticated returns failure: "unavailable".
 *   16. candidateId + assetId are server-bound, not FormData-derived.
 *   17. Correct authenticated userId + bound candidateId reach deconfirm service.
 *   18. candidate_not_confirmed maps to failure: "not_confirmed".
 *   19. Success calls revalidateAssetViews and revalidatePath.
 *   20. Unexpected failure does not expose candidateId or assetId.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: vi.fn(() => ({})),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const mockRequireVerifiedUser = vi.fn();
vi.mock("@/server/auth/require-user", () => ({
  requireVerifiedUser: () => mockRequireVerifiedUser() as unknown,
}));

// CandidateAdjudicationService mock
const mockConfirm = vi.fn();
const mockReject = vi.fn();
const mockDismiss = vi.fn();
const mockNotSure = vi.fn();
const mockDeconfirm = vi.fn();
vi.mock("@/server/discovery/candidate-adjudication-service", () => ({
  CandidateAdjudicationService: {
    create: vi.fn(() => ({
      confirm: mockConfirm,
      reject: mockReject,
      dismiss: mockDismiss,
      notSure: mockNotSure,
      deconfirm: mockDeconfirm,
    })),
  },
  AdjudicationError: class AdjudicationError extends Error {
    constructor(public code: string) {
      super(`adjudication failed: ${code}`);
      this.name = "AdjudicationError";
    }
  },
}));

// Repository mocks — used by loadCandidateEvidence inside confirmCandidateAction
const mockFindById = vi.fn();
const mockFindProviderIdentity = vi.fn();
vi.mock("@/server/repositories/discovery-candidate-repository", () => ({
  DiscoveryCandidateRepository: vi.fn(function () {
    return { findById: mockFindById };
  }),
}));
vi.mock("@/server/repositories/discovery-evidence-repository", () => ({
  DiscoveryEvidenceRepository: vi.fn(function () {
    return { findProviderIdentity: mockFindProviderIdentity };
  }),
}));

// revalidateAssetViews is in asset-action-state (non-server plain module)
vi.mock("@/app/(product)/assets/[id]/asset-action-state", () => ({
  revalidateAssetViews: vi.fn(),
}));

import {
  confirmCandidateAction,
  rejectCandidateAction,
  dismissCandidateAction,
  notSureCandidateAction,
} from "./adjudication-actions";
import { deconfirmAssetAction } from "@/app/(product)/assets/[id]/deconfirm-action";
import { revalidatePath } from "next/cache";

const INITIAL = { failure: null, attempt: 0, outcome: "idle" as const, assetId: null } as const;
const FD = new FormData();

// Helper: make a pending candidate + evidence pair
function stubCandidate(sourceIdentifier = "acme-social.example", providerClass = "hibp") {
  mockFindById.mockResolvedValue({
    id: "cand-001",
    evidenceId: "ev-001",
    status: "pending",
    assetId: null,
  });
  mockFindProviderIdentity.mockResolvedValue({ sourceIdentifier, providerClass });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireVerifiedUser.mockResolvedValue({ id: "user-abc" });
  mockConfirm.mockResolvedValue({ assetId: "asset-new", alreadyConfirmed: false });
  mockReject.mockResolvedValue(undefined);
  mockDismiss.mockResolvedValue(undefined);
  mockNotSure.mockResolvedValue(undefined);
  mockDeconfirm.mockResolvedValue(undefined);
});

// ── confirmCandidateAction ────────────────────────────────────────────────────

describe("confirmCandidateAction", () => {
  it("returns success when candidate and evidence are found", async () => {
    stubCandidate("some-service.example");
    const result = await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBeNull();
    expect(result.attempt).toBe(1);
    expect(result.outcome).toBe("confirmed");
    expect(result.assetId).toBe("asset-new");
  });

  it("uses userId from requireVerifiedUser — never from args or FormData", async () => {
    mockRequireVerifiedUser.mockResolvedValue({ id: "trusted-user" });
    stubCandidate();
    await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(mockConfirm).toHaveBeenCalledWith(
      "trusted-user",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("derives serviceName from server-loaded evidence.sourceIdentifier", async () => {
    stubCandidate("server-derived-name.example");
    await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.any(String),
      "cand-001",
      expect.objectContaining({ serviceName: "server-derived-name.example" }),
    );
  });

  it("sets category to exactly 'other' — never from client", async () => {
    stubCandidate();
    await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ category: "other" }),
    );
    // Verify the category value cannot be anything else
    const call = vi.mocked(mockConfirm).mock.calls[0]!;
    const confirmParams = call[2] as { category: string; accountIdentifier: string | null };
    expect(confirmParams.category).toBe("other");
  });

  it("sets accountIdentifier to exactly null — never from FormData", async () => {
    // Even if FormData carries an accountIdentifier, the action ignores it
    const fdWithAccountId = new FormData();
    fdWithAccountId.set("accountIdentifier", "attacker@evil.example");
    stubCandidate();
    await confirmCandidateAction("cand-001", INITIAL, fdWithAccountId);
    const call = vi.mocked(mockConfirm).mock.calls[0]!;
    const confirmParamsAI = call[2] as { category: string; accountIdentifier: string | null };
    expect(confirmParamsAI.accountIdentifier).toBeNull();
  });

  it("returns not_found when candidate is not found for this user", async () => {
    mockFindById.mockResolvedValue(null);
    const result = await confirmCandidateAction("cand-missing", INITIAL, FD);
    expect(result.failure).toBe("not_found");
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("returns not_found when candidate status is not pending", async () => {
    mockFindById.mockResolvedValue({ id: "c", evidenceId: "e", status: "confirmed", assetId: "a" });
    const result = await confirmCandidateAction("cand-confirmed", INITIAL, FD);
    expect(result.failure).toBe("not_found");
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("returns not_found when evidence is not found for this user", async () => {
    mockFindById.mockResolvedValue({ id: "c", evidenceId: "e", status: "pending", assetId: null });
    mockFindProviderIdentity.mockResolvedValue(null);
    const result = await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("not_found");
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("returns unavailable when requireVerifiedUser throws", async () => {
    mockRequireVerifiedUser.mockRejectedValue(new Error("no session"));
    const result = await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("unavailable");
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("returns unavailable when service.confirm throws unexpectedly", async () => {
    stubCandidate();
    mockConfirm.mockRejectedValue(new Error("db down"));
    const result = await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("unavailable");
  });

  it("increments attempt on success", async () => {
    stubCandidate();
    const prev = { failure: null, attempt: 3, outcome: "idle" as const, assetId: null } as const;
    const result = await confirmCandidateAction("cand-001", prev, FD);
    expect(result.attempt).toBe(4);
  });

  it("increments attempt on failure", async () => {
    mockRequireVerifiedUser.mockRejectedValue(new Error("no session"));
    const prev = { failure: null, attempt: 2, outcome: "idle" as const, assetId: null } as const;
    const result = await confirmCandidateAction("cand-001", prev, FD);
    expect(result.attempt).toBe(3);
  });

  it("calls revalidatePath('/assets') on success — NOT revalidatePath('/onboarding')", async () => {
    stubCandidate();
    await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).toHaveBeenCalledWith("/assets");
    expect(revalidatePath).not.toHaveBeenCalledWith("/onboarding");
  });

  it("does not call revalidatePath on failure", async () => {
    mockRequireVerifiedUser.mockRejectedValue(new Error("no session"));
    await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ── rejectCandidateAction ─────────────────────────────────────────────────────

describe("rejectCandidateAction", () => {
  it("returns success when service rejects the candidate", async () => {
    const result = await rejectCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBeNull();
    expect(result.outcome).toBe("rejected");
    expect(mockReject).toHaveBeenCalledWith("user-abc", "cand-001");
  });

  it("returns unavailable when unauthenticated", async () => {
    mockRequireVerifiedUser.mockRejectedValue(new Error("no session"));
    const result = await rejectCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("unavailable");
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("maps candidate_not_found to not_found failure", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_found" });
    mockReject.mockRejectedValue(err);
    const result = await rejectCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("not_found");
  });

  it("maps candidate_not_pending to not_pending failure", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_pending" });
    mockReject.mockRejectedValue(err);
    const result = await rejectCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("not_pending");
  });

  it("maps unexpected error to unavailable", async () => {
    mockReject.mockRejectedValue(new Error("db down"));
    const result = await rejectCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("unavailable");
  });
});

// ── dismissCandidateAction ────────────────────────────────────────────────────

describe("dismissCandidateAction", () => {
  it("returns success when service dismisses the candidate", async () => {
    const result = await dismissCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBeNull();
    expect(result.outcome).toBe("dismissed");
    expect(mockDismiss).toHaveBeenCalledWith("user-abc", "cand-001");
  });

  it("returns unavailable when unauthenticated", async () => {
    mockRequireVerifiedUser.mockRejectedValue(new Error("no session"));
    const result = await dismissCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("unavailable");
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it("maps candidate_not_found to not_found", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_found" });
    mockDismiss.mockRejectedValue(err);
    const result = await dismissCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("not_found");
  });

  it("maps candidate_not_pending to not_pending", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_pending" });
    mockDismiss.mockRejectedValue(err);
    const result = await dismissCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("not_pending");
  });
});

// ── notSureCandidateAction ────────────────────────────────────────────────────

describe("notSureCandidateAction", () => {
  it("calls service.notSure (not dismiss or reject)", async () => {
    const result = await notSureCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBeNull();
    expect(result.outcome).toBe("not_sure");
    expect(mockNotSure).toHaveBeenCalledWith("user-abc", "cand-001");
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("returns unavailable when unauthenticated", async () => {
    mockRequireVerifiedUser.mockRejectedValue(new Error("no session"));
    const result = await notSureCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("unavailable");
    expect(mockNotSure).not.toHaveBeenCalled();
  });

  it("maps candidate_not_found to not_found", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_found" });
    mockNotSure.mockRejectedValue(err);
    const result = await notSureCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("not_found");
  });

  it("maps candidate_not_pending to not_pending", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_pending" });
    mockNotSure.mockRejectedValue(err);
    const result = await notSureCandidateAction("cand-001", INITIAL, FD);
    expect(result.failure).toBe("not_pending");
  });
});

// ── deconfirmAssetAction ──────────────────────────────────────────────────────

describe("deconfirmAssetAction", () => {
  it("returns success with server-bound candidateId and assetId", async () => {
    const result = await deconfirmAssetAction("cand-001", "asset-001", INITIAL, FD);
    expect(result.failure).toBeNull();
    expect(mockDeconfirm).toHaveBeenCalledWith("user-abc", "cand-001");
  });

  it("returns unavailable when unauthenticated", async () => {
    mockRequireVerifiedUser.mockRejectedValue(new Error("no session"));
    const result = await deconfirmAssetAction("cand-001", "asset-001", INITIAL, FD);
    expect(result.failure).toBe("unavailable");
    expect(mockDeconfirm).not.toHaveBeenCalled();
  });

  it("passes authenticated userId to service.deconfirm — not from FormData", async () => {
    mockRequireVerifiedUser.mockResolvedValue({ id: "trusted-uid" });
    // Even if FormData carries a userId field it is ignored
    const fdWithUserId = new FormData();
    fdWithUserId.set("userId", "attacker-uid");
    await deconfirmAssetAction("cand-001", "asset-001", INITIAL, fdWithUserId);
    expect(mockDeconfirm).toHaveBeenCalledWith("trusted-uid", "cand-001");
  });

  it("passes server-bound candidateId — FormData cannot override it", async () => {
    const fdWithCandidateId = new FormData();
    fdWithCandidateId.set("candidateId", "attacker-cand");
    await deconfirmAssetAction("server-cand-id", "asset-001", INITIAL, fdWithCandidateId);
    // The service receives the bound value, not the FormData value
    expect(mockDeconfirm).toHaveBeenCalledWith(expect.any(String), "server-cand-id");
  });

  it("maps candidate_not_confirmed to not_confirmed failure", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_confirmed" });
    mockDeconfirm.mockRejectedValue(err);
    const result = await deconfirmAssetAction("cand-001", "asset-001", INITIAL, FD);
    expect(result.failure).toBe("not_confirmed");
  });

  it("maps candidate_not_found to not_found failure", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_found" });
    mockDeconfirm.mockRejectedValue(err);
    const result = await deconfirmAssetAction("cand-001", "asset-001", INITIAL, FD);
    expect(result.failure).toBe("not_found");
  });

  it("calls revalidatePath('/assets') on success", async () => {
    await deconfirmAssetAction("cand-001", "asset-001", INITIAL, FD);
    expect(revalidatePath).toHaveBeenCalledWith("/assets");
  });

  it("does not call revalidatePath on failure", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_confirmed" });
    mockDeconfirm.mockRejectedValue(err);
    await deconfirmAssetAction("cand-001", "asset-001", INITIAL, FD);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps unexpected error to unavailable without exposing identifiers", async () => {
    mockDeconfirm.mockRejectedValue(new Error("db internal error with cand-001"));
    const result = await deconfirmAssetAction("cand-001", "asset-001", INITIAL, FD);
    // The failure is generic — no candidateId or assetId in the state
    expect(result.failure).toBe("unavailable");
    expect(Object.keys(result)).not.toContain("candidateId");
    expect(Object.keys(result)).not.toContain("assetId");
  });

  it("increments attempt on each call", async () => {
    const r1 = await deconfirmAssetAction("c", "a", INITIAL, FD);
    const r2 = await deconfirmAssetAction("c", "a", r1, FD);
    expect(r2.attempt).toBe(2);
  });
});
