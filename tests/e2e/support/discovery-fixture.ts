/**
 * Service-role fixture helpers for discovery candidates (ATL-211).
 *
 * Provides DB-level seed/cleanup helpers for E2E tests that need to exercise
 * the candidate_review onboarding step, action transitions, and the deconfirm
 * panel on the asset detail page.
 *
 * ## Seed chain
 *
 * discovery_runs
 *   └─ discovery_provider_invocations  (FK: user_id + run_id)
 *        └─ discovery_evidence         (FK: user_id + invocation_id)
 *             └─ discovery_candidates  (FK: evidence_id)
 *
 * All four rows are created per seed call; cleanup deletes them in reverse
 * order so FK constraints are satisfied.
 *
 * ## Pattern
 *
 * Same service-role pattern as finding-fixture.ts: SUPABASE_SERVICE_ROLE_KEY
 * must be set. Cleanup runs unconditionally in afterEach so a failing test
 * never leaves orphan rows.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Database } from "@/types/database.generated";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function admin(): SupabaseClient<Database> {
  expect(
    SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY must be set for E2E fixture helpers",
  ).not.toBe("");
  return createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── Identity helpers ──────────────────────────────────────────────────────────

/**
 * Returns the Supabase user id for a given email address.
 *
 * Uses admin.listUsers — only works with the service-role key. Scans up to
 * 1 000 users per page (adequate for test environments).
 */
export async function getUserIdByEmail(email: string): Promise<string> {
  const db = admin();
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`getUserIdByEmail: listUsers failed: ${error.message}`);
  const user = data.users.find((u) => u.email === email);
  if (!user) throw new Error(`getUserIdByEmail: no user found for email ${email}`);
  return user.id;
}

// ── Seeded object interfaces ──────────────────────────────────────────────────

/**
 * Identifiers for every row written by `seedDiscoveryCandidate` or
 * `seedAggregatorEvidence`. Pass the whole object to the matching remove helper.
 */
export interface SeededCandidate {
  readonly runId: string;
  readonly invocationId: string;
  readonly evidenceId: string;
  /** Empty string for aggregator evidence (no candidate row created). */
  readonly candidateId: string;
}

export interface SeededDiscoveryAsset {
  readonly runId: string;
  readonly invocationId: string;
  readonly evidenceId: string;
  readonly candidateId: string;
  readonly assetId: string;
}

// ── Internal chain builder ────────────────────────────────────────────────────

/**
 * Creates the three-row prerequisite chain (run → invocation → evidence) and
 * returns their IDs. Used by both `seedDiscoveryCandidate` and
 * `seedAggregatorEvidence`.
 */
async function seedEvidenceChain(
  userId: string,
  opts: {
    sourceIdentifier?: string;
    evidenceType?: string;
    evidenceSummary?: string;
    providerClass?: string;
    isAggregatorAttributed?: boolean;
  } = {},
): Promise<{ runId: string; invocationId: string; evidenceId: string }> {
  const db = admin();
  const runId = randomUUID();
  const invocationId = randomUUID();
  const evidenceId = randomUUID();
  const providerClass = opts.providerClass ?? "hibp";

  // 1. discovery_runs — root anchor, no FKs.
  const { error: runErr } = await db.from("discovery_runs").insert({
    id: runId,
    user_id: userId,
    triggered_by: "user",
  });
  if (runErr) throw new Error(`seedEvidenceChain: run insert failed: ${runErr.message}`);

  // 2. discovery_provider_invocations — FK: (user_id, run_id).
  const { error: invErr } = await db.from("discovery_provider_invocations").insert({
    id: invocationId,
    user_id: userId,
    run_id: runId,
    provider_class: providerClass,
  });
  if (invErr) throw new Error(`seedEvidenceChain: invocation insert failed: ${invErr.message}`);

  // 3. discovery_evidence — FK: (user_id, invocation_id); field_id is uuid (no FK).
  const { error: evErr } = await db.from("discovery_evidence").insert({
    id: evidenceId,
    user_id: userId,
    invocation_id: invocationId,
    field_id: randomUUID(),
    source_identifier: opts.sourceIdentifier ?? `fixture-source-${evidenceId.slice(0, 8)}`,
    evidence_type: opts.evidenceType ?? "breach",
    evidence_summary: opts.evidenceSummary ?? "Fixture: your email appeared in a data breach.",
    provider_class: providerClass,
    is_aggregator_attributed: opts.isAggregatorAttributed ?? false,
  });
  if (evErr) throw new Error(`seedEvidenceChain: evidence insert failed: ${evErr.message}`);

  return { runId, invocationId, evidenceId };
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

/**
 * Seeds the full chain (run → invocation → evidence → candidate) with the
 * given status (default `pending`).
 */
export async function seedDiscoveryCandidate(
  userId: string,
  status: "pending" | "dismissed" | "not_sure" = "pending",
): Promise<SeededCandidate> {
  const chain = await seedEvidenceChain(userId);
  const db = admin();
  const candidateId = randomUUID();

  const { error } = await db.from("discovery_candidates").insert({
    id: candidateId,
    user_id: userId,
    evidence_id: chain.evidenceId,
    status,
  });
  if (error) throw new Error(`seedDiscoveryCandidate: candidate insert failed: ${error.message}`);

  return { ...chain, candidateId };
}

/**
 * Seeds the chain for an aggregator-attributed evidence row (no candidate row).
 *
 * These appear in the `aggregatorEvidence` section of the candidate_review step
 * but produce no adjudication buttons.
 */
export async function seedAggregatorEvidence(userId: string): Promise<SeededCandidate> {
  const chain = await seedEvidenceChain(userId, {
    sourceIdentifier: `agg-fixture-${randomUUID().slice(0, 8)}`,
    evidenceType: "public_record",
    evidenceSummary: "Fixture: aggregator signal — cannot be individually confirmed.",
    providerClass: "aggregator",
    isAggregatorAttributed: true,
  });

  // No candidate row for aggregator evidence.
  return { ...chain, candidateId: "" };
}

/**
 * Seeds the full chain and then calls `confirm_discovery_candidate` RPC to
 * atomically create the linked asset.
 *
 * Returns all IDs so the test can navigate to /assets/:assetId and the cleanup
 * helper can remove every row.
 */
export async function seedConfirmedDiscoveryAsset(userId: string): Promise<SeededDiscoveryAsset> {
  const chain = await seedEvidenceChain(userId);
  const db = admin();
  const candidateId = randomUUID();
  const assetId = randomUUID();

  // Insert the candidate row first (the RPC expects it to exist).
  const { error: candErr } = await db.from("discovery_candidates").insert({
    id: candidateId,
    user_id: userId,
    evidence_id: chain.evidenceId,
    status: "pending",
  });
  if (candErr) {
    throw new Error(`seedConfirmedDiscoveryAsset: candidate insert failed: ${candErr.message}`);
  }

  const { data, error: rpcErr } = await db.rpc("confirm_discovery_candidate", {
    p_user_id: userId,
    p_candidate_id: candidateId,
    p_asset_id: assetId,
    p_service_name: `fixture-service-${assetId.slice(0, 8)}`,
    p_category: "other",
    p_service_domain: null,
    p_account_identifier_encrypted: null,
    p_source_label: null,
    p_confidence: "high",
  });
  if (rpcErr) {
    throw new Error(`seedConfirmedDiscoveryAsset: RPC failed: ${rpcErr.message}`);
  }

  const row = Array.isArray(data) ? data[0] : null;
  const resolvedAssetId: string = row?.asset_id ?? assetId;

  return { ...chain, candidateId, assetId: resolvedAssetId };
}

// ── Status helpers ────────────────────────────────────────────────────────────

/**
 * Returns the persisted status of a discovery candidate by ID.
 *
 * Uses the service-role client — only works with SUPABASE_SERVICE_ROLE_KEY.
 * Returns null when the candidate does not exist.
 */
export async function getCandidateStatus(candidateId: string): Promise<string | null> {
  const db = admin();
  const { data, error } = await db
    .from("discovery_candidates")
    .select("status")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw new Error(`getCandidateStatus: query failed: ${error.message}`);
  return data?.status ?? null;
}

// ── Cleanup helpers ───────────────────────────────────────────────────────────

/**
 * Deletes all rows created by `seedDiscoveryCandidate` or
 * `seedAggregatorEvidence`, in FK-safe order.
 *
 * Safe to call when rows are already gone (e.g. the reject action cascaded).
 * Safe to call with `undefined` when setup failed before the seed completed.
 */
export async function removeSeededCandidate(seeded: SeededCandidate | undefined): Promise<void> {
  if (!seeded) return;
  const db = admin();

  if (seeded.candidateId) {
    await db.from("discovery_candidates").delete().eq("id", seeded.candidateId);
  }
  if (seeded.evidenceId) {
    await db.from("discovery_evidence").delete().eq("id", seeded.evidenceId);
  }
  if (seeded.invocationId) {
    await db.from("discovery_provider_invocations").delete().eq("id", seeded.invocationId);
  }
  if (seeded.runId) {
    await db.from("discovery_runs").delete().eq("id", seeded.runId);
  }
}

/**
 * Deletes all rows created by `seedConfirmedDiscoveryAsset`, in FK-safe order.
 *
 * Hard-deletes the asset row regardless of soft-delete state.
 * Safe to call with `undefined` when setup failed before the seed completed.
 */
export async function removeSeededDiscoveryAsset(
  seeded: SeededDiscoveryAsset | undefined,
): Promise<void> {
  if (!seeded) return;
  const db = admin();

  if (seeded.assetId) {
    await db.from("digital_assets").delete().eq("id", seeded.assetId);
  }
  await removeSeededCandidate(seeded);
}

// ── ATL-212 additions ─────────────────────────────────────────────────────────

/**
 * Seeds a single `discovery_runs` row with the given `run_status`.
 *
 * No invocations, evidence, or candidates are created.  Because no candidate
 * chain exists, `deriveCompletedStatus` short-circuits at hop 1 (empty
 * invocations) and returns `"completed_zero"` for a `"completed"` run seeded
 * this way — which is exactly what the run-scoping tests use as "Run B".
 *
 * For status tests that do NOT require a candidate chain (pending, running,
 * partial, blocked, failed, completed-with-no-candidates).
 *
 * Cleanup: call `removeSeededRun` with the returned `runId`.
 */
export async function seedRunWithStatus(
  userId: string,
  status: "pending" | "running" | "completed" | "partial" | "blocked" | "failed",
): Promise<{ runId: string }> {
  const db = admin();
  const runId = randomUUID();
  const { error } = await db.from("discovery_runs").insert({
    id: runId,
    user_id: userId,
    triggered_by: "user",
    run_status: status,
  } as never); // generated type does not narrow run_status to the union literal
  if (error) throw new Error(`seedRunWithStatus(${status}): insert failed: ${error.message}`);
  return { runId };
}

/**
 * Removes a single `discovery_runs` row seeded by `seedRunWithStatus` (which
 * creates no child rows, so no FK ordering is required).
 *
 * Safe to call with `undefined` when setup failed before the seed completed.
 */
export async function removeSeededRun(runId: string | undefined): Promise<void> {
  if (!runId) return;
  await admin().from("discovery_runs").delete().eq("id", runId);
}

/**
 * Seeds the full chain (run → invocation → evidence → candidate) and then
 * updates the run's `run_status` to `"completed"`.
 *
 * Used to verify that DB `"completed"` + candidates from THAT run → UI
 * `"completed_candidates"` (3-hop derivation).  The candidate status is
 * `"pending"` (awaiting review) — that status is irrelevant to the derivation,
 * which counts all candidates regardless of their review status.
 *
 * Cleanup: call `removeSeededCandidate` with the returned object (same shape
 * as `seedDiscoveryCandidate`).
 */
export async function seedCompletedRunWithCandidate(userId: string): Promise<SeededCandidate> {
  // Create the full chain via the existing helper (run_status defaults to "pending").
  const chain = await seedDiscoveryCandidate(userId, "pending");

  // Promote the run to "completed".
  const { error } = await admin()
    .from("discovery_runs")
    .update({ run_status: "completed" } as never)
    .eq("id", chain.runId);
  if (error)
    throw new Error(`seedCompletedRunWithCandidate: status update failed: ${error.message}`);

  return chain;
}
