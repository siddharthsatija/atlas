import "server-only";

import { createServiceRoleClient } from "@/server/db/service-role-client";
import { EncryptionService } from "@/server/crypto/encryption-service";
import { RejectionKeyService, type RejectionKey } from "@/server/crypto/rejection-key-service";
import { CryptoError, zeroize } from "@/server/crypto/envelope";
import {
  DiscoveryEvidenceRepository,
  generateEvidenceId,
} from "@/server/repositories/discovery-evidence-repository";
import { DiscoveryRejectionRepository } from "@/server/repositories/discovery-rejection-repository";
import { DiscoveryCandidateRepository } from "@/server/repositories/discovery-candidate-repository";
import { DiscoveryCandidateEvidenceRepository } from "@/server/repositories/discovery-candidate-evidence-repository";
import { CanonicalCandidateResolver } from "./canonical-candidate-resolver";
import { buildRejectionFingerprint } from "@/server/crypto/rejection-fingerprint";
import { normalizeExternalProfileUri } from "./normalize-external-profile-uri";
import {
  GITHUB_PROVIDER_CLASS,
  type GithubProfile,
  type GithubProviderData,
} from "./github-adapter";

// ── Constants ─────────────────────────────────────────────────────────────────

const EVIDENCE_TYPE = "github_profile" as const;
const EVIDENCE_TABLE = "discovery_evidence" as const;
const EVIDENCE_COLUMN = "provider_evidence_json" as const;

// ── Error ─────────────────────────────────────────────────────────────────────

export class GithubResultWriterError extends Error {
  constructor(public readonly reason: string) {
    super(`github result writer failed: ${reason}`);
    this.name = "GithubResultWriterError";
  }
}

// ── Dependencies ──────────────────────────────────────────────────────────────

interface GithubResultWriterDependencies {
  evidence: DiscoveryEvidenceRepository;
  resolver: CanonicalCandidateResolver;
  rejections: DiscoveryRejectionRepository;
  encryption: EncryptionService;
  rejectionKeys: RejectionKeyService;
}

/**
 * Persists the result of one GitHub dispatch into Atlas (ATL-217, ADR-008 §5–§8).
 *
 * Called by the dispatch engine after a successful GitHub dispatch.
 * The engine has already committed the invocation's terminal `success` state;
 * this writer handles everything that follows: evidence encryption, idempotent
 * evidence writes, canonical URI normalisation, rejection lookup, and canonical
 * candidate creation via `CanonicalCandidateResolver`.
 *
 * ## Processing sequence (ADR-008 §7, ATL-215)
 *
 * When the provider data contains a non-null profile:
 *
 * 1. `sourceIdentifier = profile.login.trim().toLowerCase()` — the normalised
 *    deduplication key used in the five-part evidence unique constraint and
 *    the rejection fingerprint.
 * 2. Normalise `profile.htmlUrl` via `normalizeExternalProfileUri`.
 *    A `null` result means the URI could not be canonicalised; evidence is
 *    written for provenance but no candidate is created (step 6 returns early).
 * 3. Canonical URI pre-check: `CanonicalCandidateResolver.preCheckCanonicalUri`
 *    (only when `canonicalUri` is non-null).
 *    - `"rejected"`: abort immediately — **no evidence written**, no candidate.
 *    - `"proceed"`: continue.
 * 4. Pre-generate evidence UUID.  This UUID is bound into the encryption AAD
 *    before any DB round-trip (ADR-008 §7: AAD must reference the record id).
 * 5. Encrypt `provider_evidence_json` under the user's DEK with AAD
 *    `discovery_evidence.provider_evidence_json:<uuid>`.
 *    The stored JSON contains `{ github_id, login, public_repos, followers,
 *    created_at }` — never the user's stored field value (ADR-008 §6).
 * 6. Insert evidence row idempotently (ON CONFLICT DO NOTHING) against the
 *    `(user_id, invocation_id, provider_class, field_id, source_identifier)`
 *    unique constraint.
 * 7. When `canonicalUri` is non-null and candidates are not suppressed: check
 *    the rejection fingerprint, then call
 *    `CanonicalCandidateResolver.resolveCanonicalCandidate`.
 *
 * ## Rejection mechanisms — two distinct paths
 *
 * **A. Canonical URI pre-check rejection (step 3)**
 *    Triggered when the user has explicitly rejected the canonical URI.
 *    Happens **before** evidence persistence.
 *    Result: no evidence row written, no candidate created or reopened.
 *
 * **B. Rejection-fingerprint suppression (step 7)**
 *    Triggered when the HMAC fingerprint for `(provider_class, sourceIdentifier)`
 *    matches a stored rejection record.
 *    Happens **after** evidence persistence.
 *    Result: evidence row written for provenance; no candidate created or reopened.
 *
 * These two paths are mutually exclusive within a single invocation: pre-check
 * rejection (A) aborts before the evidence insert, so fingerprint suppression
 * (B) is only reached when pre-check returned `"proceed"`.
 *
 * ## 404 path
 *
 * When the provider data contains `profile: null` (handle has no GitHub
 * account), the writer exits immediately — no evidence, no candidate.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * Handle values, GitHub logins, canonical URIs, fingerprint values, and
 * user IDs are never logged.  No log calls in this file carry those values.
 */
export class GithubResultWriter {
  private readonly evidence: DiscoveryEvidenceRepository;
  private readonly resolver: CanonicalCandidateResolver;
  private readonly rejections: DiscoveryRejectionRepository;
  private readonly encryption: EncryptionService;
  private readonly rejectionKeys: RejectionKeyService;

  constructor(deps: GithubResultWriterDependencies) {
    this.evidence = deps.evidence;
    this.resolver = deps.resolver;
    this.rejections = deps.rejections;
    this.encryption = deps.encryption;
    this.rejectionKeys = deps.rejectionKeys;
  }

  static create(): GithubResultWriter {
    const db = createServiceRoleClient();
    const candidates = new DiscoveryCandidateRepository(db);
    const candidateEvidence = new DiscoveryCandidateEvidenceRepository(db);
    return new GithubResultWriter({
      evidence: new DiscoveryEvidenceRepository(db),
      resolver: new CanonicalCandidateResolver(candidates, candidateEvidence),
      rejections: new DiscoveryRejectionRepository(db),
      encryption: EncryptionService.create(),
      rejectionKeys: RejectionKeyService.create(),
    });
  }

  /**
   * Persists GitHub profile evidence and canonical candidate from one dispatch result.
   *
   * `providerData` must be the value returned in `DispatchResult.providerData`
   * by the dispatch engine after a successful GitHub dispatch.  Throws
   * `GithubResultWriterError` if the shape does not match `GithubProviderData`.
   *
   * When `providerData.profile` is null (handle has no GitHub account) the
   * method returns immediately — no evidence or candidate is written.
   */
  async write(userId: string, invocationId: string, providerData: unknown): Promise<void> {
    if (!isGithubProviderData(providerData)) {
      throw new GithubResultWriterError("invalid_provider_data");
    }

    // 404 path: no account for this handle — nothing to persist.
    if (providerData.profile === null) {
      return;
    }

    // Fetch the rejection key once per invocation.
    let rejectionKey: RejectionKey | null = null;
    let skipCandidates = false;
    try {
      rejectionKey = await this.rejectionKeys.getRejectionKey(userId);
    } catch (e) {
      if (e instanceof CryptoError && e.code === "key_unavailable") {
        // No rejection key exists → no rejections on record → proceed.
        rejectionKey = null;
      } else {
        // key_destroyed or infrastructure error — fail closed (ADR-008 §8).
        skipCandidates = true;
      }
    }

    try {
      await this.processProfile(
        userId,
        invocationId,
        providerData.profile,
        rejectionKey,
        skipCandidates,
      );
    } finally {
      if (rejectionKey !== null) {
        zeroize(rejectionKey);
      }
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async processProfile(
    userId: string,
    invocationId: string,
    profile: GithubProfile,
    rejectionKey: RejectionKey | null,
    skipCandidates: boolean,
  ): Promise<void> {
    // Normalised source key for the five-part unique constraint and fingerprint.
    // Must not be logged (ADR-008 §8).
    const sourceIdentifier = profile.login.trim().toLowerCase();

    // Derive canonical URI before the pre-check so we can gate evidence writes.
    // normalizeExternalProfileUri handles https://github.com/{login} → strips
    // query/fragment, lowercases path (ATL-215, KNOWN_PLATFORMS github.com entry).
    const canonicalUri = normalizeExternalProfileUri(profile.htmlUrl);

    // ATL-215: pre-check before evidence write.  If the canonical URI is
    // already rejected, suppress this finding entirely — no evidence stored.
    if (canonicalUri !== null) {
      const preCheck = await this.resolver.preCheckCanonicalUri(userId, canonicalUri);
      if (preCheck === "rejected") {
        return;
      }
    }

    // Pre-generate evidence UUID for AAD binding (ADR-008 §7).
    const evidenceId = generateEvidenceId();

    // ADR-008 §6 data-minimisation: store github_id, login, public_repos,
    // followers, created_at.  Do NOT store the user's stored field value
    // (the handle they typed into Atlas).
    const evidenceJson = JSON.stringify({
      github_id: profile.githubId,
      login: profile.login,
      public_repos: profile.publicRepos,
      followers: profile.followers,
      created_at: profile.createdAt,
    });

    // ADR-008 §7: AAD = `discovery_evidence.provider_evidence_json:<uuid>`.
    const encryptedEvidence = await this.encryption.encrypt(userId, evidenceJson, {
      table: EVIDENCE_TABLE,
      column: EVIDENCE_COLUMN,
      recordId: evidenceId,
    });

    // Insert evidence idempotently — ON CONFLICT DO NOTHING on the five-part key.
    await this.evidence.insert(evidenceId, {
      userId,
      invocationId,
      providerClass: GITHUB_PROVIDER_CLASS,
      fieldId: profile.fieldId,
      sourceIdentifier,
      isAggregatorAttributed: false,
      evidenceType: EVIDENCE_TYPE,
      // evidence_summary is a display label; no user field value included.
      evidenceSummary: "GitHub profile",
      providerEvidenceJson: encryptedEvidence,
    });

    // No canonical URI — evidence recorded for provenance, no candidate.
    if (canonicalUri === null) {
      return;
    }

    // Rejection key destroyed — fail closed; candidate suppressed.
    if (skipCandidates) {
      return;
    }

    // Rejection fingerprint check (ADR-008 §5).
    if (rejectionKey !== null) {
      const fingerprint = buildRejectionFingerprint(
        rejectionKey,
        GITHUB_PROVIDER_CLASS,
        sourceIdentifier,
      );
      const isRejected = await this.rejections.exists(userId, GITHUB_PROVIDER_CLASS, fingerprint);
      if (isRejected) {
        // Rejected — evidence written for provenance; no candidate (ATL-215).
        return;
      }
    }

    // ATL-215: resolve canonical candidate with full status-conditional logic.
    await this.resolver.resolveCanonicalCandidate(userId, evidenceId, canonicalUri);
  }
}

// ── Type guards ───────────────────────────────────────────────────────────────

function isGithubProfile(item: unknown): item is GithubProfile {
  if (typeof item !== "object" || item === null) return false;
  const p = item as Record<string, unknown>;
  return (
    typeof p.fieldId === "string" &&
    typeof p.login === "string" &&
    typeof p.htmlUrl === "string" &&
    typeof p.githubId === "number" &&
    typeof p.publicRepos === "number" &&
    typeof p.followers === "number" &&
    typeof p.createdAt === "string" &&
    (p.name === null || typeof p.name === "string")
  );
}

function isGithubProviderData(data: unknown): data is GithubProviderData {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.fieldId === "string" && (d.profile === null || isGithubProfile(d.profile));
}
