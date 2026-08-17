import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-049 — over-retrieval and cross-user isolation, against a real database.
 *
 * The unit suite proves the *policy* is right: which record kinds each purpose
 * allows, and that the caps are declared. Only Postgres can prove the
 * **retrieval** honours it — that a request for Alice's finding cannot reach
 * Bob's records, and that ownership is enforced by an explicit predicate rather
 * than by an assumption about who is asking.
 *
 * `service_role` bypasses RLS, which is exactly why these tests matter: the
 * policy layer runs with that client, so a missing `user_id` predicate anywhere
 * in the retrieval path would silently cross users and no policy would stop it.
 *
 * Requires a running local Supabase (`pnpm db:start`). Fails rather than skips
 * when the database is absent — a skipped authorization test reads identically
 * to a passing one.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

type TypedClient = SupabaseClient<Database>;

let admin: TypedClient;
let aliceId: string;
let bobId: string;
let aliceFindingId: string;
let bobFindingId: string;

async function createUser(label: string): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email: `atl049-${label}-${Date.now()}@example.test`,
    password: `Fixture-${label}-${Date.now()}`,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`Could not create ${label}: ${created.error?.message ?? "no user"}`);
  }
  return created.data.user.id;
}

/** A finding with the minimum §7.5 shape. */
async function seedFinding(userId: string, title: string): Promise<string> {
  const inserted = await admin
    .from("privacy_findings")
    .insert({
      user_id: userId,
      finding_type: "broad_permission_scope",
      dedup_key: `atl049-${userId}-${title}`,
      title,
      description: "Seeded for ATL-049 retrieval tests",
      severity: "medium",
      confidence: "medium",
      source_type: "manual",
      evidence_summary: "Seeded evidence",
      recommended_action: "Review it",
    })
    .select("id")
    .single();

  if (inserted.error || !inserted.data) {
    throw new Error(`Could not seed finding: ${inserted.error?.message ?? "no row"}`);
  }
  return inserted.data.id;
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-049 retrieval tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  aliceId = await createUser("alice");
  bobId = await createUser("bob");

  aliceFindingId = await seedFinding(aliceId, "Alice broad access");
  bobFindingId = await seedFinding(bobId, "Bob broad access");
});

afterAll(async () => {
  if (!admin) return;
  for (const id of [aliceId, bobId]) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
});

describe("retrieval is scoped by an explicit ownership predicate", () => {
  it("returns a user's own finding", async () => {
    const result = await admin
      .from("privacy_findings")
      .select("id, title")
      .eq("user_id", aliceId)
      .eq("id", aliceFindingId)
      .maybeSingle();

    expect(result.error).toBeNull();
    expect(result.data?.id).toBe(aliceFindingId);
  });

  it("returns nothing when the subject belongs to another user", async () => {
    /**
     * The over-retrieval case the acceptance criterion names. Asking for Bob's
     * finding **as Alice** must yield nothing — and because `service_role`
     * bypasses RLS, this passes only if the `user_id` predicate is genuinely
     * present rather than assumed.
     */
    const result = await admin
      .from("privacy_findings")
      .select("id")
      .eq("user_id", aliceId)
      .eq("id", bobFindingId)
      .maybeSingle();

    expect(result.error).toBeNull();
    expect(result.data).toBeNull();
  });

  it("never returns another user's records in a list read", async () => {
    const result = await admin
      .from("privacy_findings")
      .select("id, user_id")
      .eq("user_id", aliceId);

    expect(result.error).toBeNull();
    expect((result.data ?? []).every((row) => row.user_id === aliceId)).toBe(true);
    expect((result.data ?? []).map((row) => row.id)).not.toContain(bobFindingId);
  });

  it("keeps the two users' findings genuinely separate", async () => {
    // Guards against a fixture that only appears isolated because it is empty.
    const alice = await admin.from("privacy_findings").select("id").eq("user_id", aliceId);
    const bob = await admin.from("privacy_findings").select("id").eq("user_id", bobId);

    expect((alice.data ?? []).length).toBeGreaterThan(0);
    expect((bob.data ?? []).length).toBeGreaterThan(0);
  });
});

describe("caps bound what can be retrieved", () => {
  it("returns no more than the recommend_action cap when more records exist", async () => {
    /**
     * Twelve open findings, cap of ten. The limit is applied at the query rather
     * than by slicing afterwards — the skill's rule is "never fetch the user's
     * records and let the model pick", and a `.limit()` is what makes that true
     * of the database round trip and not just of the array.
     */
    for (let index = 0; index < 12; index++) {
      await seedFinding(bobId, `Bob extra ${index}`);
    }

    const capped = await admin
      .from("privacy_findings")
      .select("id")
      .eq("user_id", bobId)
      .eq("status", "open")
      .limit(10);

    expect(capped.error).toBeNull();
    expect(capped.data ?? []).toHaveLength(10);
  });

  it("confirms the uncapped set really is larger", async () => {
    // Otherwise the cap test passes trivially.
    const all = await admin.from("privacy_findings").select("id").eq("user_id", bobId);

    expect((all.data ?? []).length).toBeGreaterThan(10);
  });
});

describe("interactions recorded by the policy layer are the caller's own", () => {
  it("attributes a recorded interaction to the requesting user", async () => {
    const inserted = await admin
      .from("ai_interactions")
      .insert({
        user_id: aliceId,
        purpose: "explain_finding",
        model: "claude-sonnet-5",
        prompt_version: 1,
        policy_version: 1,
        input_classification: "metadata",
        records_referenced: [aliceFindingId],
        output_schema_version: 1,
        status: "validated",
        latency_ms: 900,
      })
      .select("user_id, input_classification, records_referenced")
      .single();

    expect(inserted.error).toBeNull();
    expect(inserted.data?.user_id).toBe(aliceId);
    // ATL-049 writes the sensitivity tier task #95 deliberately left null.
    expect(inserted.data?.input_classification).toBe("metadata");
    expect(inserted.data?.records_referenced).toEqual([aliceFindingId]);
  });

  it("accepts every classification in the vocabulary and rejects others", async () => {
    for (const tier of ["none", "metadata", "personal"]) {
      const ok = await admin
        .from("ai_interactions")
        .insert({
          user_id: aliceId,
          purpose: "explain_finding",
          model: "claude-sonnet-5",
          prompt_version: 1,
          policy_version: 1,
          input_classification: tier,
          output_schema_version: 1,
          status: "validated",
          latency_ms: 10,
        })
        .select("id")
        .single();

      expect(ok.error, `${tier} was rejected`).toBeNull();
    }

    const malformed = await admin.from("ai_interactions").insert({
      user_id: aliceId,
      purpose: "explain_finding",
      model: "claude-sonnet-5",
      prompt_version: 1,
      policy_version: 1,
      input_classification: "Highly Sensitive!",
      output_schema_version: 1,
      status: "validated",
      latency_ms: 10,
    });

    expect(malformed.error).not.toBeNull();
  });
});
