import { randomUUID } from "node:crypto";
import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-217 — GitHub discovery provider: T2 and T3 real-database integration.
 *
 * T2 — Two distinct eligible evidence/invocation paths that resolve to the
 *      same canonical GitHub profile URI through the actual canonical candidate
 *      persistence path (create_canonical_candidate RPC + discovery_candidate_evidence
 *      insert). Proves against the database:
 *        - exactly 1 discovery_candidates row for user + canonical_profile_uri
 *        - exactly 2 discovery_evidence rows for user + provider_class
 *        - exactly 2 discovery_candidate_evidence rows for the candidate
 *        - both association rows point to the same candidate id
 *
 * T3 — Five-part evidence idempotency through the actual database constraint
 *      (user_id, invocation_id, provider_class, field_id, source_identifier).
 *      Proves against the database:
 *        - both upsert attempts complete without error
 *        - exactly 1 matching discovery_evidence row persists
 *
 * Requires a running local Supabase (`pnpm db:start`) with `.env.local` loaded.
 * Fails rather than skips when the database is absent.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

type TypedClient = SupabaseClient<Database>;

interface QueryResult {
  data: unknown;
  error: PostgrestError | null;
}

function expectOk<R extends QueryResult>(result: R, context: string): NonNullable<R["data"]> {
  if (result.error) {
    throw new Error(
      `${context}: expected success but got code=${result.error.code ?? "?"} message=${result.error.message}`,
    );
  }
  if (result.data === null) throw new Error(`${context}: succeeded but returned no row`);
  return result.data as NonNullable<R["data"]>;
}

interface TestUser {
  id: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Must match the ATL-217 adapter constant exactly. */
const GITHUB_PROVIDER_CLASS = "discovery_github_profile";

/** Canonical GitHub profile URI as produced by normalizeExternalProfileUri. */
const CANONICAL_URI = "https://github.com/octocat";

/** login.trim().toLowerCase() — the sourceIdentifier the result writer derives. */
const SOURCE_IDENTIFIER = "octocat";

// Distinct field UUIDs simulate two different personal field entries (username
// fields from two separate field records).  No FK to personal_fields required.
const FIELD_ID_A = "00000000-aa17-0000-0000-000000000001";
const FIELD_ID_B = "00000000-aa17-0000-0000-000000000002";
const FIELD_ID_T3 = "00000000-bb17-0000-0000-000000000001";

// ── Globals ───────────────────────────────────────────────────────────────────

let admin: TypedClient;
let t2User: TestUser;
let t3User: TestUser;

// ── Setup / teardown ──────────────────────────────────────────────────────────

async function createUser(label: string): Promise<TestUser> {
  const email = `atl217-${label}-${Date.now()}@example.test`;
  const password = `Fixture-${label}-${Date.now()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error ?? !created.data.user) {
    throw new Error(`Could not create ${label}: ${created.error?.message ?? "no user returned"}`);
  }
  return { id: created.data.user.id };
}

beforeAll(async () => {
  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  [t2User, t3User] = await Promise.all([createUser("t2"), createUser("t3")]);
});

afterAll(async () => {
  const ids = [t2User?.id, t3User?.id].filter(Boolean);
  await Promise.all(ids.map((id) => admin.auth.admin.deleteUser(id)));
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedRun(userId: string): Promise<string> {
  const result = expectOk(
    await admin
      .from("discovery_runs")
      .insert({ user_id: userId, triggered_by: "user" })
      .select("id")
      .single(),
    `seedRun(${userId})`,
  );
  return result.id;
}

async function seedInvocation(userId: string, runId: string): Promise<string> {
  const result = expectOk(
    await admin
      .from("discovery_provider_invocations")
      .insert({ user_id: userId, run_id: runId, provider_class: GITHUB_PROVIDER_CLASS })
      .select("id")
      .single(),
    `seedInvocation(${userId})`,
  );
  return result.id;
}

async function seedEvidence(
  userId: string,
  invocationId: string,
  fieldId: string,
  sourceIdentifier: string,
): Promise<string> {
  const result = expectOk(
    await admin
      .from("discovery_evidence")
      .insert({
        user_id: userId,
        invocation_id: invocationId,
        provider_class: GITHUB_PROVIDER_CLASS,
        field_id: fieldId,
        source_identifier: sourceIdentifier,
        evidence_type: "github_profile",
        evidence_summary: "ATL-217 integration fixture",
      })
      .select("id")
      .single(),
    `seedEvidence(${userId})`,
  );
  return result.id;
}

// ── T2 ────────────────────────────────────────────────────────────────────────

describe("ATL-217 T2 — two eligible evidence paths converge on one canonical candidate", () => {
  it("produces exactly 1 candidate row, 2 evidence rows, and 2 association rows for the same canonical URI", async () => {
    const userId = t2User.id;

    // Two separate runs → two separate invocations (distinct invocation_ids).
    const runA = await seedRun(userId);
    const runB = await seedRun(userId);
    const invocationA = await seedInvocation(userId, runA);
    const invocationB = await seedInvocation(userId, runB);

    // Two evidence rows with different (invocation_id, field_id) tuples but
    // the same source_identifier and canonical profile URI.
    const evidenceIdA = await seedEvidence(userId, invocationA, FIELD_ID_A, SOURCE_IDENTIFIER);
    const evidenceIdB = await seedEvidence(userId, invocationB, FIELD_ID_B, SOURCE_IDENTIFIER);

    // First resolution: create_canonical_candidate RPC atomically creates the
    // candidate row and its founding discovery_candidate_evidence association.
    const { data: candidateId, error: rpcError } = await admin.rpc("create_canonical_candidate", {
      p_user_id: userId,
      p_candidate_id: randomUUID(),
      p_evidence_id: evidenceIdA,
      p_canonical_profile_uri: CANONICAL_URI,
    });
    expect(rpcError, `create_canonical_candidate: ${rpcError?.message ?? ""}`).toBeNull();
    expect(typeof candidateId).toBe("string");
    const resolvedCandidateId = candidateId as string;

    // Second resolution: evidence B arrives — add its association to the
    // already-existing candidate via the discovery_candidate_evidence join table.
    const { error: assocError } = await admin.from("discovery_candidate_evidence").upsert(
      {
        user_id: userId,
        candidate_id: resolvedCandidateId,
        evidence_id: evidenceIdB,
      },
      { ignoreDuplicates: true },
    );
    expect(assocError, `upsert assoc B: ${assocError?.message ?? ""}`).toBeNull();

    // Assert: exactly 1 discovery_candidates row for this user + canonical URI.
    const { data: candidates, error: candError } = await admin
      .from("discovery_candidates")
      .select("id")
      .eq("user_id", userId)
      .eq("canonical_profile_uri", CANONICAL_URI);
    expect(candError).toBeNull();
    expect(candidates).toHaveLength(1);
    expect((candidates as Array<{ id: string }>)[0]!.id).toBe(resolvedCandidateId);

    // Assert: exactly 2 discovery_evidence rows for this user + provider_class.
    const { data: evidenceRows, error: evidError } = await admin
      .from("discovery_evidence")
      .select("id")
      .eq("user_id", userId)
      .eq("provider_class", GITHUB_PROVIDER_CLASS);
    expect(evidError).toBeNull();
    expect(evidenceRows).toHaveLength(2);

    // Assert: exactly 2 discovery_candidate_evidence rows for this candidate.
    const { data: assocRows, error: assocFetchError } = await admin
      .from("discovery_candidate_evidence")
      .select("evidence_id, candidate_id")
      .eq("candidate_id", resolvedCandidateId);
    expect(assocFetchError).toBeNull();
    expect(assocRows).toHaveLength(2);

    // Both rows reference the same candidate.
    const typedAssoc = assocRows as Array<{ evidence_id: string; candidate_id: string }>;
    expect(typedAssoc.every((r) => r.candidate_id === resolvedCandidateId)).toBe(true);

    // Each row references a distinct evidence record.
    const evidIds = typedAssoc.map((r) => r.evidence_id);
    expect(evidIds).toContain(evidenceIdA);
    expect(evidIds).toContain(evidenceIdB);
  });
});

// ── T3 ────────────────────────────────────────────────────────────────────────

describe("ATL-217 T3 — five-part evidence key enforces ON CONFLICT DO NOTHING at the database", () => {
  it("silently ignores a duplicate insert and persists exactly one evidence row", async () => {
    const userId = t3User.id;
    const runId = await seedRun(userId);
    const invocationId = await seedInvocation(userId, runId);

    // The five-part key: (user_id, invocation_id, provider_class, field_id,
    // source_identifier) — defined in migration atl_207 as
    // discovery_evidence_field_source_key.
    const evidencePayload = {
      user_id: userId,
      invocation_id: invocationId,
      provider_class: GITHUB_PROVIDER_CLASS,
      field_id: FIELD_ID_T3,
      source_identifier: SOURCE_IDENTIFIER,
      evidence_type: "github_profile",
      evidence_summary: "ATL-217 T3 idempotency fixture",
    };

    // First insert — row does not exist, succeeds and is persisted.
    const { error: firstError } = await admin.from("discovery_evidence").upsert(evidencePayload, {
      ignoreDuplicates: true,
      onConflict: "user_id,invocation_id,provider_class,field_id,source_identifier",
    });
    expect(firstError, `first insert: ${firstError?.message ?? ""}`).toBeNull();

    // Second insert — same five-part key, ON CONFLICT DO NOTHING.
    // Must specify onConflict matching the five-part key columns so PostgREST
    // generates ON CONFLICT (col, ...) DO NOTHING against
    // discovery_evidence_field_source_key rather than defaulting to the PK.
    const { error: secondError } = await admin.from("discovery_evidence").upsert(evidencePayload, {
      ignoreDuplicates: true,
      onConflict: "user_id,invocation_id,provider_class,field_id,source_identifier",
    });
    expect(secondError, `second insert (duplicate): ${secondError?.message ?? ""}`).toBeNull();

    // Exactly one row persists — the duplicate was silently dropped.
    const { data: rows, error: countError } = await admin
      .from("discovery_evidence")
      .select("id")
      .eq("user_id", userId)
      .eq("invocation_id", invocationId)
      .eq("provider_class", GITHUB_PROVIDER_CLASS)
      .eq("field_id", FIELD_ID_T3)
      .eq("source_identifier", SOURCE_IDENTIFIER);
    expect(countError).toBeNull();
    expect(rows).toHaveLength(1);
  });
});
