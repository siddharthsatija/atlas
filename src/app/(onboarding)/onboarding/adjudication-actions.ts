"use server";

/**
 * Candidate adjudication Server Actions for the onboarding flow (ATL-211).
 *
 * Four actions: confirm, reject, dismiss, notSure. Each is bound to a
 * candidateId via `.bind(null, candidateId)` in the Client Component tree
 * before being passed to `useActionState`.
 *
 * ## Security properties
 *
 * - `userId` comes from `requireVerifiedUser()` — never from the argument list
 *   or form data (architecture §10, "never trust client-provided user IDs").
 * - `serviceName` is derived server-side from `discovery_evidence.source_identifier`
 *   — the client cannot supply it. A tampered `candidateId` produces `not_found`.
 * - `category` is hardcoded to `"other"` — the client cannot supply a category.
 * - `accountIdentifier` is always null at confirmation — discovery-confirmed
 *   assets carry no account identifier at this stage (ATL-211 scope).
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * No user_id, candidate_id, fingerprint, or evidence value is logged.
 *
 * ## Revalidation
 *
 * Successful actions call `revalidatePath("/onboarding")` so the RSC page
 * re-fetches `listForReview`. Confirmed and rejected candidates disappear from
 * the list; dismissed and not_sure candidates remain, letting the user skip.
 *
 * ATL-212: all four actions also call `revalidatePath("/discover")` because
 * every adjudication outcome moves the candidate out of `pending` status,
 * which reduces the Discover nav badge count. The `/discover` path is
 * revalidated unconditionally — the user may not be on that route, but the
 * cache must be fresh for when they navigate there.
 */

import { revalidatePath } from "next/cache";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { CandidateAdjudicationService } from "@/server/discovery/candidate-adjudication-service";
import { DiscoveryCandidateRepository } from "@/server/repositories/discovery-candidate-repository";
import { DiscoveryEvidenceRepository } from "@/server/repositories/discovery-evidence-repository";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import type { AdjudicationActionState, AdjudicationOutcome } from "@/features/discovery";

// ── Shared helpers ────────────────────────────────────────────────────────────

function fail(
  prev: AdjudicationActionState,
  failure: AdjudicationActionState["failure"],
): AdjudicationActionState {
  return { failure, attempt: prev.attempt + 1, outcome: "idle", assetId: null };
}

function ok(
  prev: AdjudicationActionState,
  outcome: Exclude<AdjudicationOutcome, "idle">,
  assetId: string | null = null,
): AdjudicationActionState {
  return { failure: null, attempt: prev.attempt + 1, outcome, assetId };
}

/**
 * Loads the candidate and its founding evidence server-side.
 *
 * Returns `null` when the candidate does not exist or does not belong to the
 * user (non-oracle). The evidence lookup is scoped by user_id so a tampered
 * evidenceId cannot reach another user's evidence.
 */
async function loadCandidateEvidence(
  userId: string,
  candidateId: string,
): Promise<{ sourceIdentifier: string; providerClass: string } | null> {
  const db = createServiceRoleClient();
  const candidateRepo = new DiscoveryCandidateRepository(db);
  const evidenceRepo = new DiscoveryEvidenceRepository(db);

  const candidate = await candidateRepo.findById(userId, candidateId);
  if (!candidate) return null;
  if (candidate.status !== "pending") return null;

  const evidence = await evidenceRepo.findProviderIdentity(userId, candidate.evidenceId);
  if (!evidence) return null;

  return evidence;
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Confirms a pending candidate as belonging to the authenticated user.
 *
 * Derives `serviceName` from `discovery_evidence.source_identifier` — the
 * client does not supply a name. Sets `category = "other"` (the catch-all
 * category for discovery-confirmed assets; editable via ATL-033 after
 * confirmation). `accountIdentifier` is always null at this stage.
 */
export async function confirmCandidateAction(
  candidateId: string,
  prev: AdjudicationActionState,
  _formData: FormData,
): Promise<AdjudicationActionState> {
  let user;
  try {
    user = await requireVerifiedUser();
  } catch {
    return fail(prev, "unavailable");
  }

  let evidence;
  try {
    evidence = await loadCandidateEvidence(user.id, candidateId);
  } catch {
    return fail(prev, "unavailable");
  }

  if (!evidence) return fail(prev, "not_found");

  try {
    const service = CandidateAdjudicationService.create();
    const result = await service.confirm(user.id, candidateId, {
      serviceName: evidence.sourceIdentifier,
      category: "other",
      accountIdentifier: null,
    });
    revalidatePath("/assets");
    revalidatePath("/discover");
    return ok(prev, "confirmed", result.assetId);
  } catch {
    return fail(prev, "unavailable");
  }
}

/**
 * Rejects a pending candidate permanently.
 *
 * Inserts a rejection fingerprint computed from the evidence's source
 * identifier and provider class, suppressing future re-surfacing of the
 * same finding. The fingerprint is computed by the service — no cryptography
 * here.
 */
export async function rejectCandidateAction(
  candidateId: string,
  prev: AdjudicationActionState,
  _formData: FormData,
): Promise<AdjudicationActionState> {
  let user;
  try {
    user = await requireVerifiedUser();
  } catch {
    return fail(prev, "unavailable");
  }

  try {
    const service = CandidateAdjudicationService.create();
    await service.reject(user.id, candidateId);
    revalidatePath("/onboarding");
    revalidatePath("/discover");
    return ok(prev, "rejected");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "candidate_not_found") return fail(prev, "not_found");
    if (code === "candidate_not_pending") return fail(prev, "not_pending");
    return fail(prev, "unavailable");
  }
}

/**
 * Dismisses a pending candidate without creating a rejection fingerprint.
 *
 * The candidate moves to `dismissed` status and may be re-surfaced if new
 * credible evidence resolves to the same canonical URI (ATL-207).
 */
export async function dismissCandidateAction(
  candidateId: string,
  prev: AdjudicationActionState,
  _formData: FormData,
): Promise<AdjudicationActionState> {
  let user;
  try {
    user = await requireVerifiedUser();
  } catch {
    return fail(prev, "unavailable");
  }

  try {
    const service = CandidateAdjudicationService.create();
    await service.dismiss(user.id, candidateId);
    revalidatePath("/onboarding");
    revalidatePath("/discover");
    return ok(prev, "dismissed");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "candidate_not_found") return fail(prev, "not_found");
    if (code === "candidate_not_pending") return fail(prev, "not_pending");
    return fail(prev, "unavailable");
  }
}

/**
 * Marks a pending candidate as "not sure".
 *
 * The candidate moves to `not_sure` status and continues to appear in the
 * review list. The user can revisit it, or skip the step to defer the
 * decision to the Discover surface.
 */
export async function notSureCandidateAction(
  candidateId: string,
  prev: AdjudicationActionState,
  _formData: FormData,
): Promise<AdjudicationActionState> {
  let user;
  try {
    user = await requireVerifiedUser();
  } catch {
    return fail(prev, "unavailable");
  }

  try {
    const service = CandidateAdjudicationService.create();
    await service.notSure(user.id, candidateId);
    revalidatePath("/onboarding");
    revalidatePath("/discover");
    return ok(prev, "not_sure");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "candidate_not_found") return fail(prev, "not_found");
    if (code === "candidate_not_pending") return fail(prev, "not_pending");
    return fail(prev, "unavailable");
  }
}
