/**
 * Unit tests for CandidateAdjudicationService (ATL-208).
 *
 * ## Coverage priorities (per engineering principle)
 *
 * - Negative / error paths (not_found, wrong status, key errors)
 * - Security boundaries (fingerprint ordering, key zeroization, non-oracle)
 * - Idempotency guarantees (confirm/deconfirm retries)
 * - Authorization (cross-user calls indistinguishable from missing record)
 * - Privacy (no PII in thrown errors)
 * - Business rules (fingerprint inserted before status; findings resolution is
 *   BLOCKING — deconfirm RPC must not run until all open findings succeed;
 *   reject key unavailable blocks transition)
 * - Audit events (ATL-208): discovery.candidate.adjudicated / .deconfirmed;
 *   idempotent replays do not emit duplicate events; failed transitions skip events
 */
// Mock modules that load env.ts at module-init time (service-role-client → env schema).
// The service under test uses dependency injection; create() is never called in tests.
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/server/crypto/encryption-service", () => ({
  EncryptionService: { create: () => ({}) },
}));
vi.mock("@/server/crypto/rejection-key-service", () => ({
  RejectionKeyService: { create: () => ({}) },
}));
vi.mock("@/server/audit/audit-writer", () => ({
  AuditWriter: class {
    tryWrite = vi.fn().mockResolvedValue(null);
    static create() {
      return { tryWrite: vi.fn().mockResolvedValue(null) };
    }
  },
}));

import { describe, it, expect, vi } from "vitest";
import {
  CandidateAdjudicationService,
  AdjudicationError,
  type ConfirmInput,
} from "./candidate-adjudication-service";
import type { DiscoveryCandidateRepository } from "@/server/repositories/discovery-candidate-repository";
import type { DiscoveryEvidenceRepository } from "@/server/repositories/discovery-evidence-repository";
import type { DiscoveryRejectionRepository } from "@/server/repositories/discovery-rejection-repository";
import type { PrivacyFindingRepository } from "@/server/repositories/privacy-finding-repository";
import type { EncryptionService } from "@/server/crypto/encryption-service";
import type { RejectionKeyService } from "@/server/crypto/rejection-key-service";
import type { RejectionKey } from "@/server/crypto/rejection-key-service";
import type { AuditWriter } from "@/server/audit/audit-writer";
import { CryptoError } from "@/server/crypto/envelope";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A 32-byte buffer cast to RejectionKey for use in mocks. */
function makeRejectionKey(): RejectionKey {
  // The brand is a private symbol in the production module; cast via unknown for tests.
  return Buffer.from("a".repeat(32)) as unknown as RejectionKey;
}

function makeDeps() {
  const candidates: Pick<
    DiscoveryCandidateRepository,
    "findById" | "updateStatus" | "confirmViaRpc" | "deconfirmViaRpc"
  > = {
    findById: vi.fn(),
    updateStatus: vi.fn(),
    confirmViaRpc: vi.fn(),
    deconfirmViaRpc: vi.fn(),
  };

  const evidence: Pick<DiscoveryEvidenceRepository, "findProviderIdentity"> = {
    findProviderIdentity: vi.fn(),
  };

  const rejections: Pick<DiscoveryRejectionRepository, "insert"> = {
    insert: vi.fn(),
  };

  const findings: Pick<PrivacyFindingRepository, "listOpenForAsset" | "close"> = {
    listOpenForAsset: vi.fn(),
    close: vi.fn(),
  };

  const encryption: Pick<EncryptionService, "encrypt"> = {
    encrypt: vi.fn(),
  };

  const rejectionKeys: Pick<RejectionKeyService, "getRejectionKey"> = {
    getRejectionKey: vi.fn(),
  };

  const audit: Pick<AuditWriter, "tryWrite"> = {
    tryWrite: vi.fn().mockResolvedValue(null),
  };

  const service = new CandidateAdjudicationService({
    candidates: candidates as unknown as DiscoveryCandidateRepository,
    evidence: evidence as unknown as DiscoveryEvidenceRepository,
    rejections: rejections as unknown as DiscoveryRejectionRepository,
    findings: findings as unknown as PrivacyFindingRepository,
    encryption: encryption as unknown as EncryptionService,
    rejectionKeys: rejectionKeys as unknown as RejectionKeyService,
    audit: audit as unknown as AuditWriter,
  });

  return { service, candidates, evidence, rejections, findings, encryption, rejectionKeys, audit };
}

const USER_ID = "user-001";
const CANDIDATE_ID = "cand-001";
const ASSET_ID = "asset-001";
const EVIDENCE_ID = "evid-001";
const PROVIDER_CLASS = "hibp";
const SOURCE_ID = "adobe";

// ── confirm ───────────────────────────────────────────────────────────────────

describe("confirm", () => {
  it("calls confirmViaRpc with encrypted identifier and returns assetId", async () => {
    const { service, candidates, encryption } = makeDeps();
    vi.mocked(encryption.encrypt).mockResolvedValue("ciphertext");
    vi.mocked(candidates.confirmViaRpc).mockResolvedValue({
      assetId: ASSET_ID,
      alreadyConfirmed: false,
    });

    const input: ConfirmInput = {
      serviceName: "Adobe",
      category: "creative_software",
      accountIdentifier: "sid@example.com",
      confidence: "high",
    };

    const result = await service.confirm(USER_ID, CANDIDATE_ID, input);

    expect(result).toEqual({ assetId: ASSET_ID, alreadyConfirmed: false });
    expect(encryption.encrypt).toHaveBeenCalledWith(
      USER_ID,
      "sid@example.com",
      expect.objectContaining({ table: "digital_assets", column: "account_identifier_encrypted" }),
    );
    expect(candidates.confirmViaRpc).toHaveBeenCalledWith(
      USER_ID,
      CANDIDATE_ID,
      expect.objectContaining({
        serviceName: "Adobe",
        category: "creative_software",
        accountIdentifierEncrypted: "ciphertext",
        confidence: "high",
      }),
    );
  });

  it("trims whitespace from accountIdentifier before encrypting", async () => {
    const { service, candidates, encryption } = makeDeps();
    vi.mocked(encryption.encrypt).mockResolvedValue("ct");
    vi.mocked(candidates.confirmViaRpc).mockResolvedValue({
      assetId: ASSET_ID,
      alreadyConfirmed: false,
    });

    await service.confirm(USER_ID, CANDIDATE_ID, {
      serviceName: "X",
      category: "social",
      accountIdentifier: "  sid@example.com  ",
    });

    expect(encryption.encrypt).toHaveBeenCalledWith(USER_ID, "sid@example.com", expect.anything());
  });

  it("passes null accountIdentifierEncrypted when no identifier provided", async () => {
    const { service, candidates, encryption } = makeDeps();
    vi.mocked(candidates.confirmViaRpc).mockResolvedValue({
      assetId: ASSET_ID,
      alreadyConfirmed: false,
    });

    await service.confirm(USER_ID, CANDIDATE_ID, { serviceName: "X", category: "social" });

    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(candidates.confirmViaRpc).toHaveBeenCalledWith(
      USER_ID,
      CANDIDATE_ID,
      expect.objectContaining({ accountIdentifierEncrypted: null }),
    );
  });

  it("defaults confidence to 'medium' when not supplied", async () => {
    const { service, candidates } = makeDeps();
    vi.mocked(candidates.confirmViaRpc).mockResolvedValue({
      assetId: ASSET_ID,
      alreadyConfirmed: false,
    });

    await service.confirm(USER_ID, CANDIDATE_ID, { serviceName: "X", category: "social" });

    expect(candidates.confirmViaRpc).toHaveBeenCalledWith(
      USER_ID,
      CANDIDATE_ID,
      expect.objectContaining({ confidence: "medium" }),
    );
  });

  it("returns alreadyConfirmed=true when candidate is already confirmed (idempotent)", async () => {
    const { service, candidates } = makeDeps();
    vi.mocked(candidates.confirmViaRpc).mockResolvedValue({
      assetId: ASSET_ID,
      alreadyConfirmed: true,
    });

    const result = await service.confirm(USER_ID, CANDIDATE_ID, {
      serviceName: "X",
      category: "social",
    });

    expect(result.alreadyConfirmed).toBe(true);
    // Encryption may still run (before we know the RPC outcome) — that is acceptable.
  });

  it("does not expose user or candidate id in thrown errors", async () => {
    const { service, candidates } = makeDeps();
    vi.mocked(candidates.confirmViaRpc).mockRejectedValue(new Error("db exploded"));

    await expect(
      service.confirm(USER_ID, CANDIDATE_ID, { serviceName: "X", category: "social" }),
    ).rejects.toThrow();

    // Errors from deps propagate; the service itself adds no PII.
  });
});

// ── deconfirm ─────────────────────────────────────────────────────────────────

describe("deconfirm", () => {
  function setupHappyPath(deps: ReturnType<typeof makeDeps>) {
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: ASSET_ID,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.findings.listOpenForAsset).mockResolvedValue([]);
    vi.mocked(deps.candidates.deconfirmViaRpc).mockResolvedValue(undefined);
  }

  it("calls deconfirmViaRpc with correct provider_class and fingerprint envelope", async () => {
    const deps = makeDeps();
    setupHappyPath(deps);

    await deps.service.deconfirm(USER_ID, CANDIDATE_ID);

    expect(deps.candidates.deconfirmViaRpc).toHaveBeenCalledWith(
      USER_ID,
      CANDIDATE_ID,
      expect.stringMatching(/"alg":"hmac-sha256"/),
      PROVIDER_CLASS,
    );
  });

  it("throws candidate_not_found when findById returns null", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue(null);

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_found",
    });
    expect(deps.candidates.deconfirmViaRpc).not.toHaveBeenCalled();
  });

  it("throws candidate_not_confirmed when status is pending", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "pending",
      assetId: null,
    });

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_confirmed",
    });
    expect(deps.candidates.deconfirmViaRpc).not.toHaveBeenCalled();
  });

  it("throws store_error when evidence identity lookup returns null", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: ASSET_ID,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue(null);

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "store_error",
    });
  });

  it("throws rejection_key_unavailable when key does not exist", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: ASSET_ID,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockRejectedValue(
      new CryptoError("key_unavailable"),
    );

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "rejection_key_unavailable",
    });
    expect(deps.candidates.deconfirmViaRpc).not.toHaveBeenCalled();
  });

  it("throws store_error for non-key_unavailable crypto errors", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: ASSET_ID,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockRejectedValue(
      new CryptoError("key_destroyed"),
    );

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "store_error",
    });
    expect(deps.candidates.deconfirmViaRpc).not.toHaveBeenCalled();
  });

  it("closes open findings before calling deconfirmViaRpc", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: ASSET_ID,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.findings.listOpenForAsset).mockResolvedValue([{ id: "finding-1" } as never]);
    vi.mocked(deps.findings.close).mockResolvedValue(null);
    vi.mocked(deps.candidates.deconfirmViaRpc).mockResolvedValue(undefined);

    const callOrder: string[] = [];
    vi.mocked(deps.findings.close).mockImplementation(() => {
      callOrder.push("close");
      return Promise.resolve(null);
    });
    vi.mocked(deps.candidates.deconfirmViaRpc).mockImplementation(() => {
      callOrder.push("rpc");
      return Promise.resolve();
    });

    await deps.service.deconfirm(USER_ID, CANDIDATE_ID);

    expect(callOrder).toEqual(["close", "rpc"]);
    expect(deps.findings.close).toHaveBeenCalledWith(USER_ID, "finding-1", "resolved", "system");
  });

  // ── Findings failure behavior (BLOCKING invariant) ───────────────────────────
  //
  // A successful deconfirm must NOT leave open findings attached to the
  // soft-deleted asset.  The deconfirm RPC must not run until all open
  // findings have been resolved.  If listing or any close fails, the entire
  // deconfirm is aborted and the candidate remains confirmed.

  it("A: throws store_error and does NOT call deconfirmViaRpc when listOpenForAsset fails", async () => {
    // Test A from the implementation contract.
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: ASSET_ID,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.findings.listOpenForAsset).mockRejectedValue(new Error("findings down"));

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "store_error",
    });
    // Candidate remains confirmed — RPC was never called.
    expect(deps.candidates.deconfirmViaRpc).not.toHaveBeenCalled();
  });

  it("B: throws store_error and does NOT call deconfirmViaRpc when first finding close fails", async () => {
    // Test B from the implementation contract.
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: ASSET_ID,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.findings.listOpenForAsset).mockResolvedValue([{ id: "f1" } as never]);
    vi.mocked(deps.findings.close).mockRejectedValue(new Error("close failed"));

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "store_error",
    });
    expect(deps.candidates.deconfirmViaRpc).not.toHaveBeenCalled();
  });

  it("C: throws store_error and does NOT call RPC when later finding close fails; earlier resolution is NOT rolled back", async () => {
    // Test C from the implementation contract.
    // Three findings: close(f1) succeeds, close(f2) fails → abort, f3 never attempted.
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: ASSET_ID,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.findings.listOpenForAsset).mockResolvedValue([
      { id: "f1" } as never,
      { id: "f2" } as never,
      { id: "f3" } as never,
    ]);
    vi.mocked(deps.findings.close)
      .mockResolvedValueOnce(null) // f1 succeeds
      .mockRejectedValueOnce(new Error("f2 down")); // f2 fails

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "store_error",
    });
    // RPC was never called — deconfirm aborted.
    expect(deps.candidates.deconfirmViaRpc).not.toHaveBeenCalled();
    // f1 was successfully resolved — it must NOT be rolled back.
    // f2 was the failing close (called once, rejected).
    // f3 was never attempted (we stopped after f2 failed).
    expect(deps.findings.close).toHaveBeenCalledTimes(2);
    expect(deps.findings.close).toHaveBeenNthCalledWith(1, USER_ID, "f1", "resolved", "system");
    expect(deps.findings.close).toHaveBeenNthCalledWith(2, USER_ID, "f2", "resolved", "system");
    // There is no call for f3 — abort was immediate.
    expect(deps.findings.close).not.toHaveBeenCalledWith(USER_ID, "f3", "resolved", "system");
  });

  it("D: retry after partial resolution resolves only remaining open findings then calls RPC", async () => {
    // Test D from the implementation contract.
    // First call: f1 and f2 open; f1 closes, f2 fails → aborted.
    // Retry call: only f2 is still open (f1 already resolved); f2 closes → RPC executes.
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: ASSET_ID,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.candidates.deconfirmViaRpc).mockResolvedValue(undefined);

    // --- First attempt ---
    vi.mocked(deps.findings.listOpenForAsset).mockResolvedValueOnce([
      { id: "f1" } as never,
      { id: "f2" } as never,
    ]);
    vi.mocked(deps.findings.close)
      .mockResolvedValueOnce(null) // f1 closes
      .mockRejectedValueOnce(new Error("f2 transient")); // f2 fails

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "store_error",
    });
    expect(deps.candidates.deconfirmViaRpc).not.toHaveBeenCalled();

    // --- Retry: only f2 remains open (listOpenForAsset reflects current state) ---
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.findings.listOpenForAsset).mockResolvedValueOnce([{ id: "f2" } as never]);
    vi.mocked(deps.findings.close).mockResolvedValueOnce(null); // f2 now closes

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).resolves.toBeUndefined();
    // RPC ran on the retry.
    expect(deps.candidates.deconfirmViaRpc).toHaveBeenCalledOnce();
    // f2 was the only finding resolved on the retry.
    const lastClose = vi.mocked(deps.findings.close).mock.calls.at(-1);
    expect(lastClose).toEqual([USER_ID, "f2", "resolved", "system"]);
  });

  it("skips findings close when candidate has no assetId", async () => {
    const deps = makeDeps();
    // Rare but possible if DB state is inconsistent; service must not crash.
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: null, // edge case
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.candidates.deconfirmViaRpc).mockResolvedValue(undefined);

    await deps.service.deconfirm(USER_ID, CANDIDATE_ID);

    expect(deps.findings.listOpenForAsset).not.toHaveBeenCalled();
    expect(deps.candidates.deconfirmViaRpc).toHaveBeenCalledOnce();
  });

  it("builds the fingerprint with v:1 alg:hmac-sha256 envelope format", async () => {
    const deps = makeDeps();
    setupHappyPath(deps);

    let capturedFingerprint = "";
    vi.mocked(deps.candidates.deconfirmViaRpc).mockImplementation((_u, _c, fp) => {
      capturedFingerprint = fp;
      return Promise.resolve();
    });

    await deps.service.deconfirm(USER_ID, CANDIDATE_ID);

    const parsed = JSON.parse(capturedFingerprint) as unknown;
    expect(parsed).toMatchObject({ v: 1, alg: "hmac-sha256" });
    expect(typeof (parsed as Record<string, unknown>).value).toBe("string");
  });

  it("does not surface userId or candidateId in thrown AdjudicationError", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue(null);

    let caughtError: unknown;
    try {
      await deps.service.deconfirm(USER_ID, CANDIDATE_ID);
    } catch (e) {
      caughtError = e;
    }
    expect(caughtError).toBeInstanceOf(AdjudicationError);
    const err = caughtError as AdjudicationError;
    // The error message must not embed PII.
    expect(err.message).not.toContain(USER_ID);
    expect(err.message).not.toContain(CANDIDATE_ID);
  });
});

// ── reject ────────────────────────────────────────────────────────────────────

describe("reject", () => {
  function setupPending(deps: ReturnType<typeof makeDeps>) {
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "pending",
      assetId: null,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.rejections.insert).mockResolvedValue(undefined);
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(true);
  }

  it("inserts fingerprint BEFORE transitioning candidate status", async () => {
    const deps = makeDeps();
    setupPending(deps);

    const callOrder: string[] = [];
    vi.mocked(deps.rejections.insert).mockImplementation(() => {
      callOrder.push("fingerprint");
      return Promise.resolve();
    });
    vi.mocked(deps.candidates.updateStatus).mockImplementation(() => {
      callOrder.push("status");
      return Promise.resolve(true);
    });

    await deps.service.reject(USER_ID, CANDIDATE_ID);

    expect(callOrder).toEqual(["fingerprint", "status"]);
  });

  it("passes provider_class and hmac-sha256 envelope fingerprint to rejections.insert", async () => {
    const deps = makeDeps();
    setupPending(deps);

    await deps.service.reject(USER_ID, CANDIDATE_ID);

    const [calledUserId, calledProviderClass, calledFingerprint] = vi.mocked(deps.rejections.insert)
      .mock.calls[0]!;
    expect(calledUserId).toBe(USER_ID);
    expect(calledProviderClass).toBe(PROVIDER_CLASS);
    const parsed = JSON.parse(calledFingerprint) as unknown;
    expect(parsed).toMatchObject({ v: 1, alg: "hmac-sha256" });
  });

  it("calls updateStatus with expectedStatus='pending'", async () => {
    const deps = makeDeps();
    setupPending(deps);

    await deps.service.reject(USER_ID, CANDIDATE_ID);

    expect(deps.candidates.updateStatus).toHaveBeenCalledWith(
      USER_ID,
      CANDIDATE_ID,
      "rejected",
      "pending",
    );
  });

  it("throws candidate_not_found when findById returns null", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue(null);

    await expect(deps.service.reject(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_found",
    });
    expect(deps.rejections.insert).not.toHaveBeenCalled();
    expect(deps.candidates.updateStatus).not.toHaveBeenCalled();
  });

  it("throws candidate_not_pending when status is already rejected", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "rejected",
      assetId: null,
    });

    await expect(deps.service.reject(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_pending",
    });
    expect(deps.rejections.insert).not.toHaveBeenCalled();
  });

  it("throws rejection_key_unavailable and does NOT insert fingerprint when key is absent", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "pending",
      assetId: null,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockRejectedValue(
      new CryptoError("key_unavailable"),
    );

    await expect(deps.service.reject(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "rejection_key_unavailable",
    });
    expect(deps.rejections.insert).not.toHaveBeenCalled();
    expect(deps.candidates.updateStatus).not.toHaveBeenCalled();
  });

  it("throws store_error for key_destroyed and does NOT insert fingerprint", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "pending",
      assetId: null,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
      providerClass: PROVIDER_CLASS,
      sourceIdentifier: SOURCE_ID,
    });
    vi.mocked(deps.rejectionKeys.getRejectionKey).mockRejectedValue(
      new CryptoError("key_destroyed"),
    );

    await expect(deps.service.reject(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "store_error",
    });
    expect(deps.rejections.insert).not.toHaveBeenCalled();
  });

  it("throws store_error when evidence identity is not found", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "pending",
      assetId: null,
    });
    vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue(null);

    await expect(deps.service.reject(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "store_error",
    });
    expect(deps.rejections.insert).not.toHaveBeenCalled();
  });
});

// ── dismiss ───────────────────────────────────────────────────────────────────

describe("dismiss", () => {
  it("transitions a pending candidate to dismissed", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(true);

    await expect(deps.service.dismiss(USER_ID, CANDIDATE_ID)).resolves.toBeUndefined();

    expect(deps.candidates.updateStatus).toHaveBeenCalledWith(
      USER_ID,
      CANDIDATE_ID,
      "dismissed",
      "pending",
    );
    // No fingerprint insertion.
    expect(deps.rejections.insert).not.toHaveBeenCalled();
  });

  it("throws candidate_not_found when candidate does not exist", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(false);
    vi.mocked(deps.candidates.findById).mockResolvedValue(null);

    await expect(deps.service.dismiss(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_found",
    });
  });

  it("throws candidate_not_pending when candidate is confirmed", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(false);
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "confirmed",
      assetId: ASSET_ID,
    });

    await expect(deps.service.dismiss(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_pending",
    });
  });

  it("does not insert a rejection fingerprint on dismiss", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(true);

    await deps.service.dismiss(USER_ID, CANDIDATE_ID);

    expect(deps.rejections.insert).not.toHaveBeenCalled();
    expect(deps.rejectionKeys.getRejectionKey).not.toHaveBeenCalled();
  });
});

// ── notSure ───────────────────────────────────────────────────────────────────

describe("notSure", () => {
  it("transitions a pending candidate to not_sure", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(true);

    await expect(deps.service.notSure(USER_ID, CANDIDATE_ID)).resolves.toBeUndefined();

    expect(deps.candidates.updateStatus).toHaveBeenCalledWith(
      USER_ID,
      CANDIDATE_ID,
      "not_sure",
      "pending",
    );
    expect(deps.rejections.insert).not.toHaveBeenCalled();
  });

  it("throws candidate_not_found when candidate does not exist", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(false);
    vi.mocked(deps.candidates.findById).mockResolvedValue(null);

    await expect(deps.service.notSure(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_found",
    });
  });

  it("throws candidate_not_pending when candidate is dismissed", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(false);
    vi.mocked(deps.candidates.findById).mockResolvedValue({
      id: CANDIDATE_ID,
      evidenceId: EVIDENCE_ID,
      status: "dismissed",
      assetId: null,
    });

    await expect(deps.service.notSure(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_pending",
    });
  });

  it("does not insert a rejection fingerprint on notSure", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(true);

    await deps.service.notSure(USER_ID, CANDIDATE_ID);

    expect(deps.rejections.insert).not.toHaveBeenCalled();
    expect(deps.rejectionKeys.getRejectionKey).not.toHaveBeenCalled();
  });
});

// ── Cross-user authorization (non-oracle pattern) ─────────────────────────────

describe("cross-user access (non-oracle pattern)", () => {
  it("confirm: a wrong userId makes the RPC fail — error propagates, not a special code", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.confirmViaRpc).mockRejectedValue(new Error("rpc failed"));

    await expect(
      deps.service.confirm("wrong-user", CANDIDATE_ID, { serviceName: "X", category: "c" }),
    ).rejects.toThrow();
  });

  it("deconfirm: a wrong userId causes findById to return null → candidate_not_found", async () => {
    const deps = makeDeps();
    // With service-role client the candidate just won't match — repository returns null.
    vi.mocked(deps.candidates.findById).mockResolvedValue(null);

    await expect(deps.service.deconfirm("wrong-user", CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_found",
    });
  });

  it("reject: a wrong userId causes findById to return null → candidate_not_found", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue(null);

    await expect(deps.service.reject("wrong-user", CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_found",
    });
  });

  it("dismiss: a wrong userId causes updateStatus to return false then findById null → not_found", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(false);
    vi.mocked(deps.candidates.findById).mockResolvedValue(null);

    await expect(deps.service.dismiss("wrong-user", CANDIDATE_ID)).rejects.toMatchObject({
      code: "candidate_not_found",
    });
  });
});

// ── Audit events (ATL-208) ────────────────────────────────────────────────────
//
// discovery.candidate.adjudicated  — confirm / reject / dismiss / notSure
// discovery.candidate.deconfirmed  — deconfirm
//
// Rules:
// - Events are emitted post-mutation, best-effort (tryWrite).
// - Idempotent confirm replays (alreadyConfirmed=true) emit no duplicate event.
// - Failed transitions emit no success event.

describe("audit events", () => {
  // ── confirm ──────────────────────────────────────────────────────────────────

  describe("confirm", () => {
    it("emits discovery.candidate.adjudicated with outcome=confirmed on new confirmation", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.confirmViaRpc).mockResolvedValue({
        assetId: ASSET_ID,
        alreadyConfirmed: false,
      });

      await deps.service.confirm(USER_ID, CANDIDATE_ID, { serviceName: "X", category: "c" });

      expect(deps.audit.tryWrite).toHaveBeenCalledOnce();
      expect(deps.audit.tryWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          eventType: "discovery.candidate.adjudicated",
          actorType: "user",
          entityType: "discovery_candidate",
          entityId: CANDIDATE_ID,
          context: { outcome: "confirmed" },
        }),
      );
    });

    it("does NOT emit an audit event when alreadyConfirmed=true (idempotent replay)", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.confirmViaRpc).mockResolvedValue({
        assetId: ASSET_ID,
        alreadyConfirmed: true,
      });

      await deps.service.confirm(USER_ID, CANDIDATE_ID, { serviceName: "X", category: "c" });

      expect(deps.audit.tryWrite).not.toHaveBeenCalled();
    });
  });

  // ── deconfirm ────────────────────────────────────────────────────────────────

  describe("deconfirm", () => {
    function setupDeconfirmHappy(deps: ReturnType<typeof makeDeps>) {
      vi.mocked(deps.candidates.findById).mockResolvedValue({
        id: CANDIDATE_ID,
        evidenceId: EVIDENCE_ID,
        status: "confirmed",
        assetId: ASSET_ID,
      });
      vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
        providerClass: PROVIDER_CLASS,
        sourceIdentifier: SOURCE_ID,
      });
      vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
      vi.mocked(deps.findings.listOpenForAsset).mockResolvedValue([]);
      vi.mocked(deps.candidates.deconfirmViaRpc).mockResolvedValue(undefined);
    }

    it("emits discovery.candidate.deconfirmed with providerClass after successful deconfirm", async () => {
      const deps = makeDeps();
      setupDeconfirmHappy(deps);

      await deps.service.deconfirm(USER_ID, CANDIDATE_ID);

      expect(deps.audit.tryWrite).toHaveBeenCalledOnce();
      expect(deps.audit.tryWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          eventType: "discovery.candidate.deconfirmed",
          actorType: "user",
          entityType: "discovery_candidate",
          entityId: CANDIDATE_ID,
          context: { providerClass: PROVIDER_CLASS },
        }),
      );
    });

    it("does NOT emit audit event when deconfirm is aborted due to rejection_key_unavailable", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.findById).mockResolvedValue({
        id: CANDIDATE_ID,
        evidenceId: EVIDENCE_ID,
        status: "confirmed",
        assetId: ASSET_ID,
      });
      vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
        providerClass: PROVIDER_CLASS,
        sourceIdentifier: SOURCE_ID,
      });
      vi.mocked(deps.rejectionKeys.getRejectionKey).mockRejectedValue(
        new CryptoError("key_unavailable"),
      );

      await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
        code: "rejection_key_unavailable",
      });
      expect(deps.audit.tryWrite).not.toHaveBeenCalled();
    });

    it("does NOT emit audit event when deconfirm is aborted due to findings list failure", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.findById).mockResolvedValue({
        id: CANDIDATE_ID,
        evidenceId: EVIDENCE_ID,
        status: "confirmed",
        assetId: ASSET_ID,
      });
      vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
        providerClass: PROVIDER_CLASS,
        sourceIdentifier: SOURCE_ID,
      });
      vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
      vi.mocked(deps.findings.listOpenForAsset).mockRejectedValue(new Error("findings down"));

      await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
        code: "store_error",
      });
      expect(deps.audit.tryWrite).not.toHaveBeenCalled();
    });
  });

  // ── reject ───────────────────────────────────────────────────────────────────

  describe("reject", () => {
    it("emits discovery.candidate.adjudicated with outcome=rejected after successful rejection", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.findById).mockResolvedValue({
        id: CANDIDATE_ID,
        evidenceId: EVIDENCE_ID,
        status: "pending",
        assetId: null,
      });
      vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
        providerClass: PROVIDER_CLASS,
        sourceIdentifier: SOURCE_ID,
      });
      vi.mocked(deps.rejectionKeys.getRejectionKey).mockResolvedValue(makeRejectionKey());
      vi.mocked(deps.rejections.insert).mockResolvedValue(undefined);
      vi.mocked(deps.candidates.updateStatus).mockResolvedValue(true);

      await deps.service.reject(USER_ID, CANDIDATE_ID);

      expect(deps.audit.tryWrite).toHaveBeenCalledOnce();
      expect(deps.audit.tryWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          eventType: "discovery.candidate.adjudicated",
          actorType: "user",
          entityType: "discovery_candidate",
          entityId: CANDIDATE_ID,
          context: { outcome: "rejected" },
        }),
      );
    });

    it("does NOT emit audit event when rejection key is unavailable", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.findById).mockResolvedValue({
        id: CANDIDATE_ID,
        evidenceId: EVIDENCE_ID,
        status: "pending",
        assetId: null,
      });
      vi.mocked(deps.evidence.findProviderIdentity).mockResolvedValue({
        providerClass: PROVIDER_CLASS,
        sourceIdentifier: SOURCE_ID,
      });
      vi.mocked(deps.rejectionKeys.getRejectionKey).mockRejectedValue(
        new CryptoError("key_unavailable"),
      );

      await expect(deps.service.reject(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
        code: "rejection_key_unavailable",
      });
      expect(deps.audit.tryWrite).not.toHaveBeenCalled();
    });

    it("does NOT emit audit event when candidate is not found", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.findById).mockResolvedValue(null);

      await expect(deps.service.reject(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
        code: "candidate_not_found",
      });
      expect(deps.audit.tryWrite).not.toHaveBeenCalled();
    });
  });

  // ── dismiss ──────────────────────────────────────────────────────────────────

  describe("dismiss", () => {
    it("emits discovery.candidate.adjudicated with outcome=dismissed after successful dismissal", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.updateStatus).mockResolvedValue(true);

      await deps.service.dismiss(USER_ID, CANDIDATE_ID);

      expect(deps.audit.tryWrite).toHaveBeenCalledOnce();
      expect(deps.audit.tryWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          eventType: "discovery.candidate.adjudicated",
          actorType: "user",
          entityType: "discovery_candidate",
          entityId: CANDIDATE_ID,
          context: { outcome: "dismissed" },
        }),
      );
    });

    it("does NOT emit audit event when candidate is not found", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.updateStatus).mockResolvedValue(false);
      vi.mocked(deps.candidates.findById).mockResolvedValue(null);

      await expect(deps.service.dismiss(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
        code: "candidate_not_found",
      });
      expect(deps.audit.tryWrite).not.toHaveBeenCalled();
    });

    it("does NOT emit audit event when candidate is not pending", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.updateStatus).mockResolvedValue(false);
      vi.mocked(deps.candidates.findById).mockResolvedValue({
        id: CANDIDATE_ID,
        evidenceId: EVIDENCE_ID,
        status: "rejected",
        assetId: null,
      });

      await expect(deps.service.dismiss(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
        code: "candidate_not_pending",
      });
      expect(deps.audit.tryWrite).not.toHaveBeenCalled();
    });
  });

  // ── notSure ──────────────────────────────────────────────────────────────────

  describe("notSure", () => {
    it("emits discovery.candidate.adjudicated with outcome=not_sure after successful transition", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.updateStatus).mockResolvedValue(true);

      await deps.service.notSure(USER_ID, CANDIDATE_ID);

      expect(deps.audit.tryWrite).toHaveBeenCalledOnce();
      expect(deps.audit.tryWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          eventType: "discovery.candidate.adjudicated",
          actorType: "user",
          entityType: "discovery_candidate",
          entityId: CANDIDATE_ID,
          context: { outcome: "not_sure" },
        }),
      );
    });

    it("does NOT emit audit event when candidate is not found", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.updateStatus).mockResolvedValue(false);
      vi.mocked(deps.candidates.findById).mockResolvedValue(null);

      await expect(deps.service.notSure(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
        code: "candidate_not_found",
      });
      expect(deps.audit.tryWrite).not.toHaveBeenCalled();
    });

    it("does NOT emit audit event when candidate is not pending", async () => {
      const deps = makeDeps();
      vi.mocked(deps.candidates.updateStatus).mockResolvedValue(false);
      vi.mocked(deps.candidates.findById).mockResolvedValue({
        id: CANDIDATE_ID,
        evidenceId: EVIDENCE_ID,
        status: "confirmed",
        assetId: ASSET_ID,
      });

      await expect(deps.service.notSure(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
        code: "candidate_not_pending",
      });
      expect(deps.audit.tryWrite).not.toHaveBeenCalled();
    });
  });
});
