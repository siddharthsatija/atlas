import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * adjudication-actions.ts — ATL-212 revalidation tests.
 *
 * All four adjudication actions (confirm, reject, dismiss, notSure) must call
 * revalidatePath("/discover") on success so the Discover nav badge reflects the
 * updated pending-candidate count without a manual full-page reload.
 *
 * ATL-211 invariants preserved:
 *   - confirmCandidateAction calls revalidatePath("/assets") (unchanged from ATL-211).
 *   - confirmCandidateAction does NOT call revalidatePath("/onboarding").
 *   - rejectCandidateAction / dismissCandidateAction / notSureCandidateAction
 *     still call revalidatePath("/onboarding") (unchanged from ATL-211).
 *   - No action calls revalidatePath on failure.
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

const mockConfirm = vi.fn();
const mockReject = vi.fn();
const mockDismiss = vi.fn();
const mockNotSure = vi.fn();
vi.mock("@/server/discovery/candidate-adjudication-service", () => ({
  CandidateAdjudicationService: {
    create: vi.fn(() => ({
      confirm: mockConfirm,
      reject: mockReject,
      dismiss: mockDismiss,
      notSure: mockNotSure,
    })),
  },
}));

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
vi.mock("@/app/(product)/assets/[id]/asset-action-state", () => ({
  revalidateAssetViews: vi.fn(),
}));

import {
  confirmCandidateAction,
  rejectCandidateAction,
  dismissCandidateAction,
  notSureCandidateAction,
} from "./adjudication-actions";
import { revalidatePath } from "next/cache";

const INITIAL = { failure: null, attempt: 0, outcome: "idle" as const, assetId: null } as const;
const FD = new FormData();

function stubPendingCandidate() {
  mockFindById.mockResolvedValue({
    id: "cand-001",
    evidenceId: "ev-001",
    status: "pending",
    assetId: null,
  });
  mockFindProviderIdentity.mockResolvedValue({
    sourceIdentifier: "svc.example",
    providerClass: "hibp",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireVerifiedUser.mockResolvedValue({ id: "user-abc" });
  mockConfirm.mockResolvedValue({ assetId: "asset-new", alreadyConfirmed: false });
  mockReject.mockResolvedValue(undefined);
  mockDismiss.mockResolvedValue(undefined);
  mockNotSure.mockResolvedValue(undefined);
});

// ── ATL-212: /discover revalidation ───────────────────────────────────────────

describe("ATL-212 — revalidatePath('/discover') on all four adjudication outcomes", () => {
  it("confirmCandidateAction calls revalidatePath('/discover') on success", async () => {
    stubPendingCandidate();
    await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).toHaveBeenCalledWith("/discover");
  });

  it("rejectCandidateAction calls revalidatePath('/discover') on success", async () => {
    await rejectCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).toHaveBeenCalledWith("/discover");
  });

  it("dismissCandidateAction calls revalidatePath('/discover') on success", async () => {
    await dismissCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).toHaveBeenCalledWith("/discover");
  });

  it("notSureCandidateAction calls revalidatePath('/discover') on success", async () => {
    await notSureCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).toHaveBeenCalledWith("/discover");
  });

  // ATL-211 preserved: confirm still revalidates /assets
  it("confirmCandidateAction still calls revalidatePath('/assets') — ATL-211 preserved", async () => {
    stubPendingCandidate();
    await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).toHaveBeenCalledWith("/assets");
  });

  // ATL-211 preserved: confirm must NOT revalidate /onboarding
  it("confirmCandidateAction does NOT call revalidatePath('/onboarding')", async () => {
    stubPendingCandidate();
    await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).not.toHaveBeenCalledWith("/onboarding");
  });

  // ATL-211 preserved: reject/dismiss/notSure still revalidate /onboarding
  it("rejectCandidateAction still calls revalidatePath('/onboarding') — ATL-211 preserved", async () => {
    await rejectCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).toHaveBeenCalledWith("/onboarding");
  });

  it("dismissCandidateAction still calls revalidatePath('/onboarding') — ATL-211 preserved", async () => {
    await dismissCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).toHaveBeenCalledWith("/onboarding");
  });

  it("notSureCandidateAction still calls revalidatePath('/onboarding') — ATL-211 preserved", async () => {
    await notSureCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).toHaveBeenCalledWith("/onboarding");
  });
});

// ── No revalidation on failure ─────────────────────────────────────────────────

describe("ATL-212 — no revalidatePath('/discover') on failure", () => {
  it("confirmCandidateAction does not revalidate /discover when unauthenticated", async () => {
    mockRequireVerifiedUser.mockRejectedValue(new Error("no session"));
    await confirmCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).not.toHaveBeenCalledWith("/discover");
  });

  it("rejectCandidateAction does not revalidate /discover when candidate_not_found", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_found" });
    mockReject.mockRejectedValue(err);
    await rejectCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).not.toHaveBeenCalledWith("/discover");
  });

  it("dismissCandidateAction does not revalidate /discover when unauthenticated", async () => {
    mockRequireVerifiedUser.mockRejectedValue(new Error("no session"));
    await dismissCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).not.toHaveBeenCalledWith("/discover");
  });

  it("notSureCandidateAction does not revalidate /discover when candidate_not_pending", async () => {
    const err = Object.assign(new Error(), { code: "candidate_not_pending" });
    mockNotSure.mockRejectedValue(err);
    await notSureCandidateAction("cand-001", INITIAL, FD);
    expect(revalidatePath).not.toHaveBeenCalledWith("/discover");
  });
});
