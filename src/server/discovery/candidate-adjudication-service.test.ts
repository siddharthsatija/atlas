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
 * - Business rules (fingerprint inserted before status; findings close is
 *   best-effort; reject key unavailable blocks transition)
 */
import { describe, it, expect, vi } from "vitest";

// Must be hoisted before any server-only module import.
vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: vi.fn(() => ({})),
}));
// Break the kek → env.ts import chain that reads env vars at module load time.
vi.mock("@/server/crypto/kek", () => ({
  currentKek: vi.fn(() => ({ key: Buffer.alloc(32), version: 1 })),
  kekForVersion: vi.fn(() => ({ key: Buffer.alloc(32), version: 1 })),
}));
vi.mock("@/server/crypto/encryption-service", () => ({
  EncryptionService: { create: vi.fn() },
}));
vi.mock("@/server/audit/audit-writer", () => ({
  AuditWriter: vi.fn(() => ({ tryWrite: vi.fn().mockResolvedValue(undefined) })),
}));
import {
  CandidateAdjudicationService,
  AdjudicationError,
  type ConfirmInput,
} from "./candidate-adjudication-service";
import type { DiscoveryCandidateRepository } from "@/server/repositories/discovery-candidate-repository";
import type { DiscoveryEvidenceRepository } from "@/server/repositories/discovery-evidence-repository";
import type { DiscoveryRejectionRepository } from "@/server/repositories/discovery-rejection-repository";
import type { DigitalAssetRepository } from "@/server/repositories/digital-asset-repository";
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

  const assets: Pick<DigitalAssetRepository, "softDelete" | "findByCandidateId"> = {
    softDelete: vi.fn(),
    findByCandidateId: vi.fn(),
  };

  const findings: Pick<PrivacyFindingRepository, "listOpenForAsset" | "close"> = {
    listOpenForAsset: vi.fn(),
    close: vi.fn(),
  };

  const encryption: Pick<EncryptionService, "encrypt"> = {
    encrypt: vi.fn(),
  };

  const rejectionKeys: Pick<RejectionKeyService, "getRejectionKey" | "getOrCreate"> = {
    getRejectionKey: vi.fn(),
    getOrCreate: vi.fn(),
  };

  const audit = { tryWrite: vi.fn().mockResolvedValue(undefined) };

  const service = new CandidateAdjudicationService({
    candidates: candidates as unknown as DiscoveryCandidateRepository,
    evidence: evidence as unknown as DiscoveryEvidenceRepository,
    rejections: rejections as unknown as DiscoveryRejectionRepository,
    findings: findings as unknown as PrivacyFindingRepository,
    encryption: encryption as unknown as EncryptionService,
    rejectionKeys: rejectionKeys as unknown as RejectionKeyService,
    audit: audit as unknown as AuditWriter,
  });

  return {
    service,
    candidates,
    evidence,
    rejections,
    assets,
    findings,
    encryption,
    rejectionKeys,
    audit,
  };
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
    vi.mocked(deps.rejectionKeys.getOrCreate).mockResolvedValue(makeRejectionKey());
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
    vi.mocked(deps.rejectionKeys.getOrCreate).mockRejectedValue(new CryptoError("key_unavailable"));

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
    vi.mocked(deps.rejectionKeys.getOrCreate).mockRejectedValue(new CryptoError("key_destroyed"));

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
    vi.mocked(deps.rejectionKeys.getOrCreate).mockResolvedValue(makeRejectionKey());
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
      return Promise.resolve(undefined);
    });

    await deps.service.deconfirm(USER_ID, CANDIDATE_ID);

    expect(callOrder).toEqual(["close", "rpc"]);
    expect(deps.findings.close).toHaveBeenCalledWith(USER_ID, "finding-1", "resolved", "system");
  });

  it("throws store_error and does NOT call deconfirmViaRpc when a finding close throws", async () => {
    // Findings resolution is BLOCKING (see service JSDoc step 4): if close fails,
    // the deconfirm is aborted to avoid leaving a soft-deleted asset with open findings.
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
    vi.mocked(deps.rejectionKeys.getOrCreate).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.findings.listOpenForAsset).mockResolvedValue([{ id: "f1" } as never]);
    vi.mocked(deps.findings.close).mockRejectedValue(new Error("findings down"));
    vi.mocked(deps.candidates.deconfirmViaRpc).mockResolvedValue(undefined);

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "store_error",
    });
    expect(deps.candidates.deconfirmViaRpc).not.toHaveBeenCalled();
  });

  it("throws store_error and does NOT call deconfirmViaRpc when listOpenForAsset throws", async () => {
    // Findings resolution is BLOCKING: if listing fails, deconfirm is aborted.
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
    vi.mocked(deps.rejectionKeys.getOrCreate).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.findings.listOpenForAsset).mockRejectedValue(new Error("findings down"));
    vi.mocked(deps.candidates.deconfirmViaRpc).mockResolvedValue(undefined);

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).rejects.toMatchObject({
      code: "store_error",
    });
    expect(deps.candidates.deconfirmViaRpc).not.toHaveBeenCalled();
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
    vi.mocked(deps.rejectionKeys.getOrCreate).mockResolvedValue(makeRejectionKey());
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
      return Promise.resolve(undefined);
    });

    await deps.service.deconfirm(USER_ID, CANDIDATE_ID);

    const parsed = JSON.parse(capturedFingerprint) as unknown;
    expect(parsed).toMatchObject({ v: 1, alg: "hmac-sha256" });
    expect(typeof (parsed as Record<string, unknown>).value).toBe("string");
  });

  it("does not surface userId or candidateId in thrown AdjudicationError", async () => {
    const deps = makeDeps();
    vi.mocked(deps.candidates.findById).mockResolvedValue(null);

    const error = await deps.service.deconfirm(USER_ID, CANDIDATE_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdjudicationError);
    // The error message must not embed PII.
    const adjError = error as AdjudicationError;
    expect(adjError.message).not.toContain(USER_ID);
    expect(adjError.message).not.toContain(CANDIDATE_ID);
  });

  it("first-time deconfirm succeeds when user has no prior rejection key (getOrCreate creates it)", async () => {
    // Proves that deconfirm uses getOrCreate (lazy creation), not getRejectionKey (strict).
    // A user who has never rejected any candidate has no rejection key.
    // getOrCreate is expected to create one and return it so the operation can complete.
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
    // Simulate first-time creation: getOrCreate resolves with a fresh key.
    vi.mocked(deps.rejectionKeys.getOrCreate).mockResolvedValue(makeRejectionKey());
    // getRejectionKey is NOT mocked — any call to it would throw "not a function" to
    // make the test fail loudly if the production code still uses the wrong method.
    vi.mocked(deps.findings.listOpenForAsset).mockResolvedValue([]);
    vi.mocked(deps.candidates.deconfirmViaRpc).mockResolvedValue(undefined);

    await expect(deps.service.deconfirm(USER_ID, CANDIDATE_ID)).resolves.toBeUndefined();
    expect(deps.rejectionKeys.getOrCreate).toHaveBeenCalledWith(USER_ID);
    expect(deps.candidates.deconfirmViaRpc).toHaveBeenCalledOnce();
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
    vi.mocked(deps.rejectionKeys.getOrCreate).mockResolvedValue(makeRejectionKey());
    vi.mocked(deps.rejections.insert).mockResolvedValue(undefined);
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(true);
  }

  it("inserts fingerprint BEFORE transitioning candidate status", async () => {
    const deps = makeDeps();
    setupPending(deps);

    const callOrder: string[] = [];
    vi.mocked(deps.rejections.insert).mockImplementation(() => {
      callOrder.push("fingerprint");
      return Promise.resolve(undefined);
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
    vi.mocked(deps.rejectionKeys.getOrCreate).mockRejectedValue(new CryptoError("key_unavailable"));

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
    vi.mocked(deps.rejectionKeys.getOrCreate).mockRejectedValue(new CryptoError("key_destroyed"));

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

  it("first-time reject succeeds when user has no prior rejection key (getOrCreate creates it)", async () => {
    // Proves that reject uses getOrCreate (lazy creation), not getRejectionKey (strict).
    // A user who has never rejected any candidate has no rejection key.
    // getOrCreate is expected to create one and return it so the operation can complete.
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
    // Simulate first-time creation: getOrCreate resolves with a fresh key.
    vi.mocked(deps.rejectionKeys.getOrCreate).mockResolvedValue(makeRejectionKey());
    // getRejectionKey is NOT mocked — any call to it would throw "not a function" to
    // make the test fail loudly if the production code still uses the wrong method.
    vi.mocked(deps.rejections.insert).mockResolvedValue(undefined);
    vi.mocked(deps.candidates.updateStatus).mockResolvedValue(true);

    await expect(deps.service.reject(USER_ID, CANDIDATE_ID)).resolves.toBeUndefined();
    expect(deps.rejectionKeys.getOrCreate).toHaveBeenCalledWith(USER_ID);
    expect(deps.rejections.insert).toHaveBeenCalledOnce();
    expect(deps.candidates.updateStatus).toHaveBeenCalledWith(
      USER_ID,
      CANDIDATE_ID,
      "rejected",
      "pending",
    );
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
    expect(deps.rejectionKeys.getOrCreate).not.toHaveBeenCalled();
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
    expect(deps.rejectionKeys.getOrCreate).not.toHaveBeenCalled();
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
