import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-202 — authorization for `discovery_evidence`, `discovery_candidates`, and
 * `discovery_rejections`, against a real database.
 *
 * All three ATL-202 tables are write-only from the service layer (no
 * authenticated write policies). What only Postgres can settle:
 *
 *  1. **Two-user RLS.** A user may read only their own rows; another user's
 *     rows are invisible even when their ids are known.
 *  2. **Write refusal.** Authenticated clients may not insert, update, or
 *     delete — all writes are server-side via service_role adapters.
 *  3. **Anonymous access.** Unauthenticated clients reach nothing.
 *
 * Seeding uses service_role directly to avoid depending on application
 * services that do not exist yet.
 *
 * Requires a running local Supabase (`pnpm db:start`) with `.env.local` loaded.
 * Fails rather than skips when the database is absent — a skipped authorization
 * test reads identically to a passing one.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

type TypedClient = SupabaseClient<Database>;

interface QueryResult {
  data: unknown;
  error: PostgrestError | null;
}

function describeError(error: PostgrestError): string {
  const parts = [`code=${error.code ?? "?"}`, `message=${error.message}`];
  if (error.details) parts.push(`details=${error.details}`);
  return parts.join(" | ");
}

function expectOk<R extends QueryResult>(result: R, context: string): NonNullable<R["data"]> {
  if (result.error) {
    throw new Error(`${context}: expected success but got ${describeError(result.error)}`);
  }
  if (result.data === null) throw new Error(`${context}: succeeded but returned no row`);
  return result.data as NonNullable<R["data"]>;
}

/** Passes when the operation was refused *or* silently matched nothing. */
function expectNoAccess(result: QueryResult, context: string): void {
  if (result.error) return;
  const rows = Array.isArray(result.data) ? result.data : result.data === null ? [] : [result.data];
  if (rows.length > 0) throw new Error(`${context}: rows were reachable. ${rows.length} row(s).`);
}

/** Passes only when the database refused. Used where a silent no-op would be wrong. */
function expectRejected(result: QueryResult, context: string): PostgrestError {
  if (!result.error) throw new Error(`${context}: expected the database to refuse, but it did not`);
  return result.error;
}

interface TestUser {
  id: string;
  client: TypedClient;
}

let admin: TypedClient;
let alice: TestUser;
let bob: TestUser;

/** Fixture ids seeded for alice. */
let aliceEvidenceId: string;
let aliceCandidateId: string;
let aliceRejectionId: string;

async function createUser(label: string): Promise<TestUser> {
  const email = `atl202-${label}-${Date.now()}@example.test`;
  const password = `Fixture-${label}-${Date.now()}`;

  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    throw new Error(`Could not create ${label}: ${created.error?.message ?? "no user returned"}`);
  }

  const client = createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`Could not sign in ${label}: ${signIn.error.message}`);

  return { id: created.data.user.id, client };
}

/**
 * Seeds the full discovery_runs → discovery_provider_invocations → discovery_evidence
 * → discovery_candidates chain for a given user, using service_role.
 *
 * Returns the seeded evidence id and candidate id.
 */
async function seedEvidenceChain(
  userId: string,
): Promise<{ evidenceId: string; candidateId: string }> {
  // 1. discovery_runs
  const run = expectOk(
    await admin
      .from("discovery_runs")
      .insert({ user_id: userId, triggered_by: "user" })
      .select("id")
      .single(),
    `seeding discovery_runs for ${userId}`,
  );

  // 2. discovery_provider_invocations
  const invocation = expectOk(
    await admin
      .from("discovery_provider_invocations")
      .insert({ user_id: userId, run_id: run.id, provider_class: "hibp" })
      .select("id")
      .single(),
    `seeding discovery_provider_invocations for ${userId}`,
  );

  // 3. discovery_evidence
  const evidence = expectOk(
    await admin
      .from("discovery_evidence")
      .insert({
        user_id: userId,
        invocation_id: invocation.id,
        provider_class: "hibp",
        field_id: "00000000-0000-0000-0000-000000000001",
        source_identifier: "fixture",
        evidence_type: "breach",
        evidence_summary: "ATL-202 fixture breach",
      })
      .select("id")
      .single(),
    `seeding discovery_evidence for ${userId}`,
  );

  // 4. discovery_candidates
  const candidate = expectOk(
    await admin
      .from("discovery_candidates")
      .insert({ user_id: userId, evidence_id: evidence.id })
      .select("id")
      .single(),
    `seeding discovery_candidates for ${userId}`,
  );

  return { evidenceId: evidence.id, candidateId: candidate.id };
}

/**
 * Seeds a discovery_rejections row for a given user, using service_role.
 * Returns the rejection id.
 */
async function seedRejection(userId: string): Promise<string> {
  const rejection = expectOk(
    await admin
      .from("discovery_rejections")
      .insert({
        user_id: userId,
        fingerprint: `{"v":1,"alg":"hmac-sha256","value":"atl202-fixture-${userId}"}`,
        provider_class: "hibp",
      })
      .select("id")
      .single(),
    `seeding discovery_rejections for ${userId}`,
  );

  return rejection.id;
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-202 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("discovery_evidence").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.discovery_evidence as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");

  const aliceChain = await seedEvidenceChain(alice.id);
  aliceEvidenceId = aliceChain.evidenceId;
  aliceCandidateId = aliceChain.candidateId;

  aliceRejectionId = await seedRejection(alice.id);
}, 60_000);

afterAll(async () => {
  if (!admin) return;
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

// ============================================================
// discovery_evidence — two-user isolation
// ============================================================

describe("discovery_evidence — two-user isolation", () => {
  it("lets alice read her own evidence rows", async () => {
    const result = await alice.client
      .from("discovery_evidence")
      .select("*")
      .eq("user_id", alice.id);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("hides alice's evidence from bob completely", async () => {
    expectNoAccess(
      await bob.client.from("discovery_evidence").select("*"),
      "bob reading all evidence rows",
    );
  });

  it("hides alice's evidence from bob even when the id is known", async () => {
    expectNoAccess(
      await bob.client.from("discovery_evidence").select("*").eq("id", aliceEvidenceId),
      "bob reading alice's evidence by id",
    );
  });

  it("refuses anonymous reads", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expectNoAccess(
      await anon.from("discovery_evidence").select("*"),
      "anon reading discovery_evidence",
    );
  });
});

describe("discovery_evidence — clients may not write", () => {
  it("refuses an insert by the owning authenticated client", async () => {
    expectRejected(
      await alice.client
        .from("discovery_evidence")
        .insert({
          user_id: alice.id,
          invocation_id: "00000000-0000-0000-0000-000000000000",
          provider_class: "hibp",
          field_id: "00000000-0000-0000-0000-000000000001",
          source_identifier: "fixture",
          evidence_type: "breach",
          evidence_summary: "client insert attempt",
        })
        .select("id"),
      "alice inserting her own evidence row",
    );
  });

  it("refuses an update by the owning authenticated client", async () => {
    expectRejected(
      await alice.client
        .from("discovery_evidence")
        .update({ evidence_summary: "client update attempt" })
        .eq("id", aliceEvidenceId)
        .select("id"),
      "alice updating her own evidence row",
    );
  });

  it("refuses a delete by the owning authenticated client", async () => {
    expectRejected(
      await alice.client.from("discovery_evidence").delete().eq("id", aliceEvidenceId).select("id"),
      "alice deleting her own evidence row",
    );
  });
});

// ============================================================
// discovery_candidates — two-user isolation
// ============================================================

describe("discovery_candidates — two-user isolation", () => {
  it("lets alice read her own candidate rows", async () => {
    const result = await alice.client
      .from("discovery_candidates")
      .select("*")
      .eq("user_id", alice.id);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("hides alice's candidates from bob completely", async () => {
    expectNoAccess(
      await bob.client.from("discovery_candidates").select("*"),
      "bob reading all candidate rows",
    );
  });

  it("hides alice's candidate from bob even when the id is known", async () => {
    expectNoAccess(
      await bob.client.from("discovery_candidates").select("*").eq("id", aliceCandidateId),
      "bob reading alice's candidate by id",
    );
  });

  it("refuses anonymous reads", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expectNoAccess(
      await anon.from("discovery_candidates").select("*"),
      "anon reading discovery_candidates",
    );
  });
});

describe("discovery_candidates — clients may not write", () => {
  it("refuses an insert by the owning authenticated client", async () => {
    expectRejected(
      await alice.client
        .from("discovery_candidates")
        .insert({
          user_id: alice.id,
          evidence_id: aliceEvidenceId,
        })
        .select("id"),
      "alice inserting her own candidate row",
    );
  });

  it("refuses an update by the owning authenticated client", async () => {
    expectRejected(
      await alice.client
        .from("discovery_candidates")
        .update({ status: "dismissed" })
        .eq("id", aliceCandidateId)
        .select("id"),
      "alice updating her own candidate row",
    );
  });

  it("refuses a delete by the owning authenticated client", async () => {
    expectRejected(
      await alice.client
        .from("discovery_candidates")
        .delete()
        .eq("id", aliceCandidateId)
        .select("id"),
      "alice deleting her own candidate row",
    );
  });
});

// ============================================================
// discovery_rejections — two-user isolation
// ============================================================

describe("discovery_rejections — two-user isolation", () => {
  it("lets alice read her own rejection rows", async () => {
    const result = await alice.client
      .from("discovery_rejections")
      .select("*")
      .eq("user_id", alice.id);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("hides alice's rejections from bob completely", async () => {
    expectNoAccess(
      await bob.client.from("discovery_rejections").select("*"),
      "bob reading all rejection rows",
    );
  });

  it("hides alice's rejection from bob even when the id is known", async () => {
    expectNoAccess(
      await bob.client.from("discovery_rejections").select("*").eq("id", aliceRejectionId),
      "bob reading alice's rejection by id",
    );
  });

  it("refuses anonymous reads", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expectNoAccess(
      await anon.from("discovery_rejections").select("*"),
      "anon reading discovery_rejections",
    );
  });
});

describe("discovery_rejections — clients may not write", () => {
  it("refuses an insert by the owning authenticated client", async () => {
    expectRejected(
      await alice.client
        .from("discovery_rejections")
        .insert({
          user_id: alice.id,
          fingerprint: '{"v":1,"alg":"hmac-sha256","value":"client-insert-attempt"}',
          provider_class: "hibp",
        })
        .select("id"),
      "alice inserting her own rejection row",
    );
  });

  it("refuses a delete by the owning authenticated client", async () => {
    expectRejected(
      await alice.client
        .from("discovery_rejections")
        .delete()
        .eq("id", aliceRejectionId)
        .select("id"),
      "alice deleting her own rejection row",
    );
  });
});
