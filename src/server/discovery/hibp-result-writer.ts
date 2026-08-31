import "server-only";

import { createHmac } from "node:crypto";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { EncryptionService } from "@/server/crypto/encryption-service";
import { RejectionKeyService } from "@/server/crypto/rejection-key-service";
import { CryptoError, zeroize } from "@/server/crypto/envelope";
import {
  DiscoveryEvidenceRepository,
  generateEvidenceId,
} from "@/server/repositories/discovery-evidence-repository";
import { DiscoveryCandidateRepository } from "@/server/repositories/discovery-candidate-repository";
import { DiscoveryRejectionRepository } from "@/server/repositories/discovery-rejection-repository";
import { HIBP_PROVIDER_CLASS, type HibpBreachMatch, type HibpProviderData } from "./hibp-adapter";

// ── Constants ─────────────────────────────────────────────────────────────────

const EVIDENCE_TYPE = "hibp_breach" as const;
const EVIDENCE_TABLE = "discovery_evidence" as const;
const EVIDENCE_COLUMN = "provider_evidence_json" as const;

// ── Error ─────────────────────────────────────────────────────────────────────

export class HibpResultWriterError extends Error {
  constructor(public readonly reason: string) {
    super(`hibp result writer failed: ${reason}`);
    this.name = "HibpResultWriterError";
  }
}

// ── Dependencies ──────────────────────────────────────────────────────────────

interface HibpResultWriterDependencies {
  evidence: DiscoveryEvidenceRepository;
  candidates: DiscoveryCandidateRepository;
  rejections: DiscoveryRejectionRepository;
  encryption: EncryptionService;
  rejectionKeys: RejectionKeyService;
}

/**
 * Persists the result of one HIBP dispatch into Atlas (ATL-207, ADR-008 §5–§8).
 *
 * Called by `HibpDiscoveryService` immediately after a successful dispatch.
 * The engine has already committed the invocation's terminal `success` state;
 * this writer handles everything that follows: evidence encryption, idempotent
 * evidence writes, non-service-corpus routing, rejection lookup, and candidate
 * creation.
 *
 * ## Per-breach processing
 *
 * For each breach in the provider data:
 *
 * 1. `source_identifier = breach.Name.trim().toLowerCase()` — the normalised
 *    deduplication key, identical to the HMAC fingerprint input.
 * 2. Evidence JSON `{ breach_date, data_classes, is_verified, pwn_count }` is
 *    built (ADR-008 §6 store list), then encrypted under the user's DEK with
 *    AAD `discovery_evidence.provider_evidence_json:<uuid>` (ADR-008 §7).
 *    `isSpamList` is NOT stored in the evidence JSON (transient routing only).
 * 3. The evidence row is upserted with `ignoreDuplicates: true` against the
 *    `(user_id, invocation_id, provider_class, field_id, source_identifier)`
 *    unique constraint — idempotent under re-delivery.
 *    `is_aggregator_attributed` is always `false` for HIBP (ADR-007 §12).
 * 4. Non-service-corpus gate (ADR-007 §12): `isSpamList = true` → evidence only,
 *    no candidate, no rejection lookup.  `is_aggregator_attributed` remains
 *    `false` regardless — `isSpamList` is NOT mapped to `is_aggregator_attributed`.
 * 5. Rejection fingerprint: `HMAC-SHA256(rejectionKey, provider_class + NUL +
 *    source_identifier)` encoded as `{"v":1,"alg":"hmac-sha256","value":"<b64url>"}`.
 *    Checked against `discovery_rejections`.  Not rejected → candidate inserted.
 * 6. Rejection key unavailable (`key_unavailable`) means no rejections exist
 *    for this user; candidate proceeds.  Key destroyed or other error → fail
 *    closed, no candidate for this invocation.
 *
 * ## Catalogue failure isolation
 *
 * If any step for a single breach throws, that breach is skipped entirely and
 * processing continues with the next breach.  No partial evidence is left.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * Email addresses, breach names per-user, fingerprint values, and userId are
 * never logged.  No log calls in this file carry those values.
 */
export class HibpResultWriter {
  private readonly evidence: DiscoveryEvidenceRepository;
  private readonly candidates: DiscoveryCandidateRepository;
  private readonly rejections: DiscoveryRejectionRepository;
  private readonly encryption: EncryptionService;
  private readonly rejectionKeys: RejectionKeyService;

  constructor(deps: HibpResultWriterDependencies) {
    this.evidence = deps.evidence;
    this.candidates = deps.candidates;
    this.rejections = deps.rejections;
    this.encryption = deps.encryption;
    this.rejectionKeys = deps.rejectionKeys;
  }

  static create(): HibpResultWriter {
    const db = createServiceRoleClient();
    return new HibpResultWriter({
      evidence: new DiscoveryEvidenceRepository(db),
      candidates: new DiscoveryCandidateRepository(db),
      rejections: new DiscoveryRejectionRepository(db),
      encryption: EncryptionService.create(),
      rejectionKeys: RejectionKeyService.create(),
    });
  }

  /**
   * Persists all breach evidence and candidates from one dispatch result.
   *
   * `providerData` must be the value returned in `DispatchResult.providerData`
   * by the dispatch engine after a successful HIBP dispatch.  Throws
   * `HibpResultWriterError` if the shape does not match `HibpProviderData`.
   *
   * Per-breach failures are swallowed: a breach that cannot be persisted is
   * skipped and the writer continues with the remaining breaches.
   */
  async write(userId: string, invocationId: string, providerData: unknown): Promise<void> {
    if (!isHibpProviderData(providerData)) {
      throw new HibpResultWriterError("invalid_provider_data");
    }

    // Fetch the rejection key once.  It is per-user, not per-breach.
    let rejectionKey: Buffer | null = null;
    let skipCandidates = false;
    try {
      rejectionKey = await this.rejectionKeys.getRejectionKey(userId);
    } catch (e) {
      if (e instanceof CryptoError && e.code === "key_unavailable") {
        // No rejection key exists → no rejections on record → all non-spam-list
        // breaches proceed to candidate creation.
        rejectionKey = null;
      } else {
        // key_destroyed or infrastructure error — fail closed: do not surface
        // any candidate for this invocation (ADR-008 §8).
        skipCandidates = true;
      }
    }

    try {
      for (const breach of providerData.breaches) {
        try {
          await this.processBreach(
            userId,
            invocationId,
            providerData.fieldId,
            breach,
            rejectionKey,
            skipCandidates,
          );
        } catch {
          // Catalogue failure isolation: skip this breach and continue to the next.
          // Must not log breach name or any per-user data (ADR-008 §8).
        }
      }
    } finally {
      // Narrow the window in which a heap dump would yield the key material.
      if (rejectionKey !== null) {
        zeroize(rejectionKey);
      }
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async processBreach(
    userId: string,
    invocationId: string,
    fieldId: string,
    breach: HibpBreachMatch,
    rejectionKey: Buffer | null,
    skipCandidates: boolean,
  ): Promise<void> {
    const sourceIdentifier = breach.Name.trim().toLowerCase();

    // ADR-008 §6: store breach_date, data_classes, is_verified, pwn_count.
    // Discard: isSpamList (transient routing only), IsFabricated, IsRetired,
    //          IsSensitive, Description.
    const evidenceJson = JSON.stringify({
      breach_date: breach.BreachDate,
      data_classes: breach.DataClasses,
      is_verified: breach.IsVerified,
      pwn_count: breach.PwnCount,
    });

    // Pre-generate the row UUID so the AAD can be bound before the insert.
    const evidenceId = generateEvidenceId();

    // ADR-008 §7: AAD = `discovery_evidence.provider_evidence_json:<uuid>`.
    const encryptedEvidence = await this.encryption.encrypt(userId, evidenceJson, {
      table: EVIDENCE_TABLE,
      column: EVIDENCE_COLUMN,
      recordId: evidenceId,
    });

    // is_aggregator_attributed is always false for HIBP (ADR-007 §12).
    // isSpamList is NOT mapped to is_aggregator_attributed — different semantics.
    await this.evidence.insert(evidenceId, {
      userId,
      invocationId,
      providerClass: HIBP_PROVIDER_CLASS,
      fieldId,
      sourceIdentifier,
      isAggregatorAttributed: false,
      evidenceType: EVIDENCE_TYPE,
      evidenceSummary: breach.Title,
      providerEvidenceJson: encryptedEvidence,
    });

    // Non-service-corpus gate (ADR-007 §12): spam-list breaches produce
    // evidence only — no rejection fingerprint check, no candidate.
    if (breach.isSpamList) return;

    // Rejection key destroyed or otherwise unavailable — fail closed.
    if (skipCandidates) return;

    // No rejection key means no rejections exist for this user — proceed.
    if (rejectionKey === null) {
      await this.candidates.insert(userId, evidenceId);
      return;
    }

    // Check whether the user previously rejected this source.
    const fingerprint = buildRejectionFingerprint(rejectionKey, sourceIdentifier);
    const isRejected = await this.rejections.exists(userId, HIBP_PROVIDER_CLASS, fingerprint);
    if (!isRejected) {
      await this.candidates.insert(userId, evidenceId);
    }
  }
}

// ── Type guard ────────────────────────────────────────────────────────────────

function isHibpBreachMatch(item: unknown): item is HibpBreachMatch {
  if (typeof item !== "object" || item === null) return false;
  const b = item as Record<string, unknown>;
  return (
    typeof b.Name === "string" &&
    typeof b.Title === "string" &&
    typeof b.BreachDate === "string" &&
    Array.isArray(b.DataClasses) &&
    typeof b.IsVerified === "boolean" &&
    typeof b.PwnCount === "number" &&
    typeof b.isSpamList === "boolean"
  );
}

function isHibpProviderData(data: unknown): data is HibpProviderData {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.fieldId === "string" &&
    Array.isArray(d.breaches) &&
    d.breaches.every(isHibpBreachMatch)
  );
}

// ── Fingerprint ───────────────────────────────────────────────────────────────

/**
 * Builds a rejection fingerprint for one source identifier.
 *
 * HMAC input: `provider_class + NUL + source_identifier` (ADR-008 §5,
 * docs/05-feature-ticket-list.md ATL-207 §fingerprint).
 *
 * Stored as `{"v":1,"alg":"hmac-sha256","value":"<base64url>"}`.
 *
 * Must never be logged (ADR-008 §8).
 */
function buildRejectionFingerprint(key: Buffer, sourceIdentifier: string): string {
  const hmacInput = `${HIBP_PROVIDER_CLASS}\x00${sourceIdentifier}`;
  const value = createHmac("sha256", key).update(hmacInput).digest("base64url");
  return JSON.stringify({ v: 1, alg: "hmac-sha256", value });
}
