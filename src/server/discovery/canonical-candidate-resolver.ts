import "server-only";

import type { DiscoveryCandidateRepository } from "@/server/repositories/discovery-candidate-repository";
import { DiscoveryCandidateStoreError } from "@/server/repositories/discovery-candidate-repository";
import type { DiscoveryCandidateEvidenceRepository } from "@/server/repositories/discovery-candidate-evidence-repository";
import { DiscoveryCandidateEvidenceStoreError } from "@/server/repositories/discovery-candidate-evidence-repository";

/**
 * ATL-215 — Provider-neutral canonical external-profile candidate resolver.
 *
 * Manages the lifecycle of `discovery_candidates` rows that represent a
 * canonical external profile (identified by a normalised URI).  Multiple
 * evidence records from different personal fields or different provider
 * classes that resolve to the same canonical URI converge on a single
 * candidate row through this resolver.
 *
 * ## Design contract
 *
 * ### Pre-check before evidence is written
 *
 * `preCheckCanonicalUri` must be called BEFORE writing the evidence to
 * `discovery_evidence`.  If it returns `"rejected"`, the caller must NOT
 * write evidence and must NOT attempt resolution.  This gate prevents
 * unnecessary retention of provider payloads for already-rejected profiles.
 *
 * The rejected candidate is safe even if state changes between pre-check
 * and resolution: `resolveCanonicalCandidate` re-validates the status after
 * evidence is written and fails closed on a rejected candidate regardless of
 * the pre-check outcome.
 *
 * ### Caller sequence
 *
 * ```
 * 1. Pre-generate evidenceId.
 * 2. Encrypt provider payload (AAD uses pre-generated id).
 * 3. Normalize rawUri → canonicalUri (null → no-canonical-uri path).
 * 4. preCheckCanonicalUri(userId, canonicalUri)
 *      → "rejected": abort; do NOT write evidence.
 *      → "proceed": continue.
 * 5. Write evidence to discovery_evidence.
 * 6. resolveCanonicalCandidate(userId, evidenceId, canonicalUri)
 * ```
 *
 * ### Status transition table
 *
 * | Existing candidate status | Evidence written? | Join row created? | Mutation            |
 * |---------------------------|-------------------|-------------------|---------------------|
 * | (none)                    | YES (by caller)   | YES — founding    | INSERT new candidate|
 * | pending                   | YES               | YES               | none                |
 * | confirmed                 | YES               | YES               | none                |
 * | not_sure                  | YES               | YES               | none                |
 * | dismissed                 | YES               | YES               | → pending           |
 * | rejected                  | NO (gate)         | NO                | none                |
 *
 * ## HIBP boundary
 *
 * This resolver has no knowledge of HIBP.  HIBP evidence-based candidates
 * continue to use `DiscoveryCandidateRepository.insert` directly.  ATL-217
 * (the first canonical external-identity provider adapter) will be the first
 * concrete consumer of this resolver.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * Thrown errors carry no database detail.
 */

/**
 * Outcome returned by `resolveCanonicalCandidate`.
 *
 * - `created`:           A new canonical candidate was created; the founding
 *                        evidence join row was atomically associated.
 * - `evidence_added`:    An existing non-rejected candidate accepted the new
 *                        evidence (join row inserted).
 * - `dismissed_reopened`: The candidate was `dismissed`; it has been
 *                        transitioned to `pending` and the evidence associated.
 * - `rejected`:          The candidate is `rejected`; evidence was NOT
 *                        associated.  The caller should treat this as a
 *                        suppression signal.  (Only reachable when the
 *                        candidate became `rejected` between pre-check and
 *                        resolution.)
 */
export type CanonicalResolutionOutcome =
  | { readonly outcome: "created"; readonly candidateId: string }
  | { readonly outcome: "evidence_added"; readonly candidateId: string }
  | { readonly outcome: "dismissed_reopened"; readonly candidateId: string }
  | { readonly outcome: "rejected" };

export class CanonicalCandidateResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalCandidateResolverError";
  }
}

/**
 * Provider-neutral canonical external-profile candidate resolver (ATL-215).
 *
 * Depends on `DiscoveryCandidateRepository` and
 * `DiscoveryCandidateEvidenceRepository`; has no knowledge of provider
 * classes, personal field types, or HIBP.
 */
export class CanonicalCandidateResolver {
  private readonly candidates: DiscoveryCandidateRepository;
  private readonly candidateEvidence: DiscoveryCandidateEvidenceRepository;

  constructor(
    candidates: DiscoveryCandidateRepository,
    candidateEvidence: DiscoveryCandidateEvidenceRepository,
  ) {
    this.candidates = candidates;
    this.candidateEvidence = candidateEvidence;
  }

  /**
   * Pre-check: determines whether evidence for the given canonical URI may be
   * written to the database.
   *
   * Returns `"rejected"` if an existing candidate for this URI is in
   * `rejected` status — the caller MUST NOT write evidence and MUST NOT call
   * `resolveCanonicalCandidate`.
   *
   * Returns `"proceed"` in all other cases (including when no candidate
   * exists for this URI).
   *
   * ### Fail-closed
   *
   * A database error is re-thrown as `CanonicalCandidateResolverError`.  The
   * caller must not write evidence when the pre-check could not be completed.
   *
   * @param userId       Authenticated user id.
   * @param canonicalUri Atlas-normalised canonical profile URI.
   */
  async preCheckCanonicalUri(
    userId: string,
    canonicalUri: string,
  ): Promise<"rejected" | "proceed"> {
    try {
      const existing = await this.candidates.findByCanonicalUri(userId, canonicalUri);
      if (existing?.status === "rejected") return "rejected";
      return "proceed";
    } catch (err) {
      if (err instanceof DiscoveryCandidateStoreError) {
        throw new CanonicalCandidateResolverError("canonical pre-check failed: database error");
      }
      throw err;
    }
  }

  /**
   * Resolves a canonical candidate for the given URI after evidence has been
   * written to `discovery_evidence`.
   *
   * This method is the authoritative write path for canonical candidates.
   * It re-validates the candidate status to handle the race where a candidate
   * becomes `rejected` between the pre-check and this call.
   *
   * ### Outcomes
   *
   * - No existing candidate → atomically creates candidate + founding join row.
   * - `pending | confirmed | not_sure` → attaches evidence to join table.
   * - `dismissed` → attaches evidence + transitions candidate to `pending`.
   * - `rejected` → returns `{ outcome: "rejected" }` without mutation.
   *
   * @param userId       Authenticated user id.
   * @param evidenceId   UUID of the already-written `discovery_evidence` row.
   * @param canonicalUri Atlas-normalised canonical profile URI.
   */
  async resolveCanonicalCandidate(
    userId: string,
    evidenceId: string,
    canonicalUri: string,
  ): Promise<CanonicalResolutionOutcome> {
    try {
      const existing = await this.candidates.findByCanonicalUri(userId, canonicalUri);

      // ── No existing candidate ──────────────────────────────────────────────
      if (existing === null) {
        const candidateId = await this.candidates.createCanonical(userId, evidenceId, canonicalUri);
        return { outcome: "created", candidateId };
      }

      // ── Rejected: fail closed ─────────────────────────────────────────────
      // Handles the race where the candidate became rejected after pre-check.
      if (existing.status === "rejected") {
        return { outcome: "rejected" };
      }

      // ── Dismissed: attach evidence and reopen ─────────────────────────────
      if (existing.status === "dismissed") {
        await this.candidateEvidence.insert(userId, existing.id, evidenceId);
        await this.candidates.transitionDismissedToPending(userId, existing.id);
        return { outcome: "dismissed_reopened", candidateId: existing.id };
      }

      // ── Pending / confirmed / not_sure: attach evidence only ──────────────
      await this.candidateEvidence.insert(userId, existing.id, evidenceId);
      return { outcome: "evidence_added", candidateId: existing.id };
    } catch (err) {
      if (
        err instanceof DiscoveryCandidateStoreError ||
        err instanceof DiscoveryCandidateEvidenceStoreError
      ) {
        throw new CanonicalCandidateResolverError(
          "canonical candidate resolution failed: database error",
        );
      }
      throw err;
    }
  }
}
