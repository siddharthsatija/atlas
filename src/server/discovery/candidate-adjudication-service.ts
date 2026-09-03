import "server-only";

import { randomUUID } from "node:crypto";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { EncryptionService } from "@/server/crypto/encryption-service";
import { RejectionKeyService } from "@/server/crypto/rejection-key-service";
import { CryptoError, zeroize } from "@/server/crypto/envelope";
import { buildRejectionFingerprint } from "@/server/crypto/rejection-fingerprint";
import type { RejectionKey } from "@/server/crypto/rejection-key-service";
import {
  DiscoveryCandidateRepository,
  type ConfirmCandidateParams,
} from "@/server/repositories/discovery-candidate-repository";
import { DiscoveryEvidenceRepository } from "@/server/repositories/discovery-evidence-repository";
import { DiscoveryRejectionRepository } from "@/server/repositories/discovery-rejection-repository";
import { AAD_TABLE, AAD_COLUMN } from "@/server/repositories/digital-asset-repository";
import { PrivacyFindingRepository } from "@/server/repositories/privacy-finding-repository";
import { AuditWriter } from "@/server/audit/audit-writer";
import type { AssetConfidence } from "@/lib/assets/asset-fields";

// ── Error ─────────────────────────────────────────────────────────────────────

/**
 * Typed adjudication failures surfaced to callers (ATL-208).
 *
 * - `candidate_not_found`     — the candidate id does not exist or is not
 *                               owned by the given user (non-oracle pattern).
 * - `candidate_not_pending`   — the adjudication requires a pending candidate
 *                               but the candidate is in another state.
 * - `candidate_not_confirmed` — the adjudication requires a confirmed candidate
 *                               (deconfirm) but the candidate is in another state.
 * - `rejection_key_unavailable` — the user's rejection HMAC key was not found
 *                               (key_unavailable).  Reject / deconfirm cannot
 *                               produce a fingerprint; the candidate is not
 *                               transitioned.
 * - `store_error`             — a downstream persistence failure; details are
 *                               withheld (ADR-008 §8).
 */
export class AdjudicationError extends Error {
  constructor(
    public readonly code:
      | "candidate_not_found"
      | "candidate_not_pending"
      | "candidate_not_confirmed"
      | "rejection_key_unavailable"
      | "store_error",
  ) {
    super(`adjudication failed: ${code}`);
    this.name = "AdjudicationError";
  }
}

// ── Input / result types ──────────────────────────────────────────────────────

/**
 * Asset parameters supplied by the caller when confirming a candidate.
 *
 * `accountIdentifier` is **plaintext**; the service encrypts it before
 * forwarding to the RPC, consistent with ADR-003.
 */
export interface ConfirmInput {
  serviceName: string;
  category: string;
  serviceDomain?: string | null;
  /** Plaintext account identifier. Will be encrypted before storage. */
  accountIdentifier?: string | null;
  sourceLabel?: string | null;
  confidence?: AssetConfidence;
}

export interface ConfirmResult {
  assetId: string;
  /** True when the candidate was already confirmed; no writes were performed. */
  alreadyConfirmed: boolean;
}

// ── Dependencies ──────────────────────────────────────────────────────────────

interface AdjudicationDependencies {
  candidates: DiscoveryCandidateRepository;
  evidence: DiscoveryEvidenceRepository;
  rejections: DiscoveryRejectionRepository;
  findings: PrivacyFindingRepository;
  encryption: EncryptionService;
  rejectionKeys: RejectionKeyService;
  audit: AuditWriter;
}

/**
 * Business logic for adjudicating discovery candidates (ATL-208).
 *
 * ## Actions
 *
 * - `confirm`     — promotes a pending candidate to a digital asset (atomic RPC).
 * - `deconfirm`   — reverses a confirm: soft-deletes the asset, transitions the
 *                   candidate to rejected, inserts a rejection fingerprint to
 *                   suppress future re-surfacing.
 * - `reject`      — rejects a pending candidate without first confirming it;
 *                   inserts a fingerprint, then transitions the candidate.
 * - `dismiss`     — marks a pending candidate as dismissed (no fingerprint).
 * - `notSure`     — marks a pending candidate as "not sure" (no fingerprint).
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * No user id, candidate id, breach name, fingerprint value, or email address
 * is logged in this service.  Thrown errors carry no database detail.
 */
export class CandidateAdjudicationService {
  private readonly candidates: DiscoveryCandidateRepository;
  private readonly evidence: DiscoveryEvidenceRepository;
  private readonly rejections: DiscoveryRejectionRepository;
  private readonly findings: PrivacyFindingRepository;
  private readonly encryption: EncryptionService;
  private readonly rejectionKeys: RejectionKeyService;
  private readonly audit: AuditWriter;

  constructor(deps: AdjudicationDependencies) {
    this.candidates = deps.candidates;
    this.evidence = deps.evidence;
    this.rejections = deps.rejections;
    this.findings = deps.findings;
    this.encryption = deps.encryption;
    this.rejectionKeys = deps.rejectionKeys;
    this.audit = deps.audit;
  }

  static create(): CandidateAdjudicationService {
    const db = createServiceRoleClient();
    return new CandidateAdjudicationService({
      candidates: new DiscoveryCandidateRepository(db),
      evidence: new DiscoveryEvidenceRepository(db),
      rejections: new DiscoveryRejectionRepository(db),
      findings: new PrivacyFindingRepository(db),
      encryption: EncryptionService.create(),
      rejectionKeys: RejectionKeyService.create(),
      audit: new AuditWriter(db),
    });
  }

  // ── Public actions ──────────────────────────────────────────────────────────

  /**
   * Confirms a pending candidate, atomically creating a `discovery`-sourced
   * digital asset.
   *
   * The account identifier, if provided, is encrypted application-side before
   * the RPC so that plaintext never crosses the network boundary to Postgres
   * (ADR-003).  The asset UUID is pre-generated here to bind the encryption
   * AAD before the insert.
   *
   * Idempotent: if the candidate is already confirmed, the RPC returns the
   * existing `asset_id` and `alreadyConfirmed = true` without writing anything.
   */
  async confirm(userId: string, candidateId: string, input: ConfirmInput): Promise<ConfirmResult> {
    // Pre-generate the asset UUID so the encryption context AAD can be bound
    // to `digital_assets.account_identifier_encrypted:<uuid>` before the insert.
    const assetId = randomUUID();

    const identifier = input.accountIdentifier?.trim() ?? null;
    const accountIdentifierEncrypted = identifier
      ? await this.encryption.encrypt(userId, identifier, {
          table: AAD_TABLE,
          column: AAD_COLUMN,
          recordId: assetId,
        })
      : null;

    const params: ConfirmCandidateParams = {
      assetId,
      serviceName: input.serviceName,
      category: input.category,
      serviceDomain: input.serviceDomain ?? null,
      accountIdentifierEncrypted,
      sourceLabel: input.sourceLabel ?? null,
      confidence: input.confidence ?? "medium",
    };

    const result = await this.candidates.confirmViaRpc(userId, candidateId, params);

    // Emit audit event for new confirmations only (ATL-208).
    // Idempotent replays (alreadyConfirmed = true) do not emit a duplicate event.
    if (!result.alreadyConfirmed) {
      await this.audit.tryWrite({
        userId,
        eventType: "discovery.candidate.adjudicated",
        actorType: "user",
        entityType: "discovery_candidate",
        entityId: candidateId,
        context: { outcome: "confirmed" },
      });
    }

    return result;
  }

  /**
   * Deconfirms a confirmed candidate.
   *
   * Order of operations:
   * 1. Verify the candidate is confirmed (fail-fast before expensive work).
   * 2. Fetch evidence to obtain `provider_class` + `source_identifier`.
   * 3. Fetch the rejection key and build the fingerprint.
   * 4. Resolve all open privacy findings for the linked asset (system path,
   *    NOT FindingService — that would misattribute resolvedBy='user' and
   *    emit spurious per-finding audit events). This is BLOCKING: the deconfirm
   *    RPC must not run until all open findings have been successfully resolved.
   *    If listing or any close fails, the deconfirm is aborted — the candidate
   *    remains confirmed and the asset remains active (safe partial state).
   *    A retry is safe: listOpenForAsset returns only REMAINING open findings,
   *    so findings already resolved by a prior attempt are not re-closed.
   * 5. Atomic RPC: soft-delete asset, transition candidate to rejected,
   *    insert fingerprint (ON CONFLICT DO NOTHING).
   * 6. Emit `discovery.candidate.deconfirmed` audit event (best-effort).
   */
  async deconfirm(userId: string, candidateId: string): Promise<void> {
    // 1. Verify status before fetching key material.
    const candidate = await this.candidates.findById(userId, candidateId);
    if (!candidate) throw new AdjudicationError("candidate_not_found");
    if (candidate.status !== "confirmed") throw new AdjudicationError("candidate_not_confirmed");

    // 2. Evidence identity for the fingerprint.
    const identity = await this.evidence.findProviderIdentity(userId, candidate.evidenceId);
    if (!identity) throw new AdjudicationError("store_error");

    // 3. Rejection key + fingerprint — key is zeroized in the finally block.
    let rejectionKey: RejectionKey | null = null;
    try {
      rejectionKey = await this.rejectionKeys.getRejectionKey(userId);
    } catch (e) {
      if (e instanceof CryptoError && e.code === "key_unavailable") {
        throw new AdjudicationError("rejection_key_unavailable");
      }
      throw new AdjudicationError("store_error");
    }

    let fingerprint: string;
    try {
      fingerprint = buildRejectionFingerprint(
        rejectionKey,
        identity.providerClass,
        identity.sourceIdentifier,
      );
    } finally {
      // Narrow the heap-dump window regardless of whether fingerprint was built.
      zeroize(rejectionKey);
    }

    // 4. Blocking findings resolution.
    //
    // All open findings for the confirmed asset must be resolved with
    // resolved_by = 'system' before the deconfirm RPC runs.  A successful
    // deconfirm must NOT leave open findings attached to the soft-deleted asset.
    //
    // listOpenForAsset returns only remaining open findings on each call, so a
    // retry after a partial failure (e.g. close failed on finding N) will skip
    // findings already resolved by the prior attempt without re-closing them.
    if (candidate.assetId) {
      let openFindings: Awaited<ReturnType<typeof this.findings.listOpenForAsset>>;
      try {
        openFindings = await this.findings.listOpenForAsset(userId, candidate.assetId);
      } catch {
        throw new AdjudicationError("store_error");
      }
      for (const finding of openFindings) {
        try {
          await this.findings.close(userId, finding.id, "resolved", "system");
        } catch {
          throw new AdjudicationError("store_error");
        }
      }
    }

    // 5. Atomic RPC: soft-delete + candidate transition + fingerprint insert.
    await this.candidates.deconfirmViaRpc(userId, candidateId, fingerprint, identity.providerClass);

    // 6. Best-effort audit after committed state change (ATL-208).
    await this.audit.tryWrite({
      userId,
      eventType: "discovery.candidate.deconfirmed",
      actorType: "user",
      entityType: "discovery_candidate",
      entityId: candidateId,
      context: { providerClass: identity.providerClass },
    });
  }

  /**
   * Rejects a pending candidate without first confirming it.
   *
   * Inserts a rejection fingerprint BEFORE transitioning the candidate status
   * (idempotency guarantee: a partial failure on the status update leaves the
   * fingerprint in place, suppressing re-surfacing on the next ingestion cycle).
   *
   * Throws `AdjudicationError("rejection_key_unavailable")` when the rejection
   * key cannot be fetched.  The candidate is NOT transitioned — a retry when
   * the key becomes available will succeed.
   */
  async reject(userId: string, candidateId: string): Promise<void> {
    const candidate = await this.candidates.findById(userId, candidateId);
    if (!candidate) throw new AdjudicationError("candidate_not_found");
    if (candidate.status !== "pending") throw new AdjudicationError("candidate_not_pending");

    const identity = await this.evidence.findProviderIdentity(userId, candidate.evidenceId);
    if (!identity) throw new AdjudicationError("store_error");

    let rejectionKey: RejectionKey | null = null;
    try {
      rejectionKey = await this.rejectionKeys.getRejectionKey(userId);
    } catch (e) {
      if (e instanceof CryptoError && e.code === "key_unavailable") {
        throw new AdjudicationError("rejection_key_unavailable");
      }
      throw new AdjudicationError("store_error");
    }

    try {
      const fingerprint = buildRejectionFingerprint(
        rejectionKey,
        identity.providerClass,
        identity.sourceIdentifier,
      );
      // Fingerprint first — makes the operation idempotent under retry.
      await this.rejections.insert(userId, identity.providerClass, fingerprint);
    } finally {
      zeroize(rejectionKey);
    }

    // Status transition after fingerprint: a retry that re-inserts the fingerprint
    // (ignored via ON CONFLICT) and re-attempts the status update is safe.
    await this.candidates.updateStatus(userId, candidateId, "rejected", "pending");

    // Best-effort audit after committed state change (ATL-208).
    await this.audit.tryWrite({
      userId,
      eventType: "discovery.candidate.adjudicated",
      actorType: "user",
      entityType: "discovery_candidate",
      entityId: candidateId,
      context: { outcome: "rejected" },
    });
  }

  /**
   * Dismisses a pending candidate.
   *
   * No fingerprint is recorded — a dismissal is "not now", not "never". The
   * candidate may be re-presented when new evidence surfaces for the same source.
   */
  async dismiss(userId: string, candidateId: string): Promise<void> {
    const transitioned = await this.candidates.updateStatus(
      userId,
      candidateId,
      "dismissed",
      "pending",
    );
    if (!transitioned) {
      // Distinguish not-found from wrong-status for the caller.
      const candidate = await this.candidates.findById(userId, candidateId);
      if (!candidate) throw new AdjudicationError("candidate_not_found");
      throw new AdjudicationError("candidate_not_pending");
    }

    // Best-effort audit after committed state change (ATL-208).
    await this.audit.tryWrite({
      userId,
      eventType: "discovery.candidate.adjudicated",
      actorType: "user",
      entityType: "discovery_candidate",
      entityId: candidateId,
      context: { outcome: "dismissed" },
    });
  }

  /**
   * Marks a pending candidate as "not sure".
   *
   * No fingerprint — the candidate remains open for a later decision.
   */
  async notSure(userId: string, candidateId: string): Promise<void> {
    const transitioned = await this.candidates.updateStatus(
      userId,
      candidateId,
      "not_sure",
      "pending",
    );
    if (!transitioned) {
      const candidate = await this.candidates.findById(userId, candidateId);
      if (!candidate) throw new AdjudicationError("candidate_not_found");
      throw new AdjudicationError("candidate_not_pending");
    }

    // Best-effort audit after committed state change (ATL-208).
    await this.audit.tryWrite({
      userId,
      eventType: "discovery.candidate.adjudicated",
      actorType: "user",
      entityType: "discovery_candidate",
      entityId: candidateId,
      context: { outcome: "not_sure" },
    });
  }
}
