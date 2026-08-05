import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-078 — authorization and immutability for `consents` against a real
 * database.
 *
 * Unlike the internal tables from ATL-084, ATL-103, and ATL-104, this one is
 * user-facing: the owner may read their own history because Settings renders it
 * (ATL-076). That makes the two-user assertion the interesting one — the policy
 * has a predicate, so it is possible to get the predicate wrong.
 *
 * Writes stay server-side. A client that could insert would be able to record
 * consent against a policy version it chose, with no audit event.
 *
 * Requires a running local Supabase (`pnpm db:start`). Fails rather than skips
 * when the database is absent — a skipped authorization test reads identically
 * to a passing one.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const POLICY = "2026-08-01";

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

/** Accepts either an error (no grant) or an empty result (no policy). */
function expectNoAccess(result: QueryResult, context: string): void {
  if (result.error) return;
  const rows = Array.isArray(result.data) ? result.data : result.data === null ? [] : [result.data];
  if (rows.length > 0) {
    throw new Error(`${context}: consent rows were reachable. ${rows.length} row(s).`);
  }
}

interface TestUser {
  id: string;
  client: TypedClient;
}

let admin: TypedClient;
let alice: TestUser;
let bob: TestUser;

async function createUser(label: string): Promise<TestUser> {
  const email = `atl078-${label}-${Date.now()}@example.test`;
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

/** Records a decision as the consent service would, using service-role. */
async function seedConsent(userId: string, consentType: string, granted: boolean) {
  return expectOk(
    await admin
      .from("consents")
      .insert({
        user_id: userId,
        consent_type: consentType,
        policy_version: POLICY,
        granted,
      })
      .select("id")
      .single(),
    `seeding ${consentType} for ${userId}`,
  );
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-078 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("consents").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.consents as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");

  await seedConsent(alice.id, "ai_processing", true);
  await seedConsent(bob.id, "ai_processing", true);
}, 60_000);

afterAll(async () => {
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("owners can read their own history", () => {
  it("returns the owner's rows", async () => {
    const rows = expectOk(
      await alice.client.from("consents").select("*"),
      "alice reading her own consent history",
    ) as { user_id: string }[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.user_id === alice.id)).toBe(true);
  });
});

describe("two-user isolation", () => {
  it("does not return another user's rows even when asked for them by id", async () => {
    // The policy predicate is the only thing standing between these two users.
    expectNoAccess(
      await alice.client.from("consents").select("*").eq("user_id", bob.id),
      "alice reading bob's consent history",
    );
  });

  it("filters an unfiltered select to the owner", async () => {
    const rows = expectOk(
      await bob.client.from("consents").select("user_id"),
      "bob selecting all consent rows",
    ) as { user_id: string }[];

    expect(rows.every((r) => r.user_id === bob.id)).toBe(true);
  });
});

describe("clients cannot write consent", () => {
  it("cannot record consent for themselves", async () => {
    // Recording must stamp the server's policy version and emit an audit event.
    const attempt = await alice.client
      .from("consents")
      .insert({
        user_id: alice.id,
        consent_type: "ai_processing",
        policy_version: "forged",
        granted: true,
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("cannot record consent on another user's behalf", async () => {
    const attempt = await alice.client
      .from("consents")
      .insert({
        user_id: bob.id,
        consent_type: "product_updates",
        policy_version: POLICY,
        granted: true,
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("cannot edit a recorded decision", async () => {
    const attempt = await alice.client
      .from("consents")
      .update({ granted: false })
      .eq("user_id", alice.id)
      .select("id");

    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);

    const rows = expectOk(
      await admin.from("consents").select("granted").eq("user_id", alice.id),
      "verifying alice's consent was untouched",
    ) as { granted: boolean }[];
    expect(rows.some((r) => r.granted)).toBe(true);
  });

  it("cannot delete a recorded decision", async () => {
    // Deleting would make "revoked" indistinguishable from "never happened".
    const attempt = await alice.client
      .from("consents")
      .delete()
      .eq("user_id", alice.id)
      .select("id");

    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);

    const rows = expectOk(
      await admin.from("consents").select("id").eq("user_id", alice.id),
      "verifying alice's consent survived",
    ) as { id: string }[];
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("anonymous access", () => {
  it("is denied entirely", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(await anon.from("consents").select("*"), "anonymous reading consent rows");
  });
});

describe("append-only enforcement", () => {
  it("refuses an update even from service_role", async () => {
    // The trigger binds owner and superuser connections too, which grants never
    // restrict.
    const seeded = await seedConsent(alice.id, "product_updates", true);

    const attempt = await admin
      .from("consents")
      .update({ granted: false })
      .eq("id", seeded.id)
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("records a revocation as a second row", async () => {
    const user = await createUser("revoke");
    await seedConsent(user.id, "ai_processing", true);
    await seedConsent(user.id, "ai_processing", false);

    const rows = expectOk(
      await admin.from("consents").select("granted").eq("user_id", user.id),
      "reading the grant/revoke pair",
    ) as { granted: boolean }[];

    expect(rows).toHaveLength(2);
    await admin.auth.admin.deleteUser(user.id);
  });
});

describe("constraints", () => {
  it("refuses an unrecognised consent type", async () => {
    // A gate that fails open is worse than one that fails loudly.
    const attempt = await admin
      .from("consents")
      .insert({
        user_id: alice.id,
        consent_type: "invented_type",
        policy_version: POLICY,
        granted: true,
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("refuses a malformed policy version", async () => {
    const attempt = await admin
      .from("consents")
      .insert({
        user_id: alice.id,
        consent_type: "ai_processing",
        policy_version: "not a version!",
        granted: true,
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("accepts all four documented consent types", async () => {
    const user = await createUser("types");

    for (const type of [
      "ai_processing",
      "personal_fields_storage",
      "ai_conversation_history",
      "product_updates",
    ]) {
      await seedConsent(user.id, type, true);
    }

    const rows = expectOk(
      await admin.from("consents").select("consent_type").eq("user_id", user.id),
      "reading all four consent types",
    ) as { consent_type: string }[];
    expect(rows).toHaveLength(4);

    await admin.auth.admin.deleteUser(user.id);
  });
});

describe("account deletion", () => {
  it("cascades consent history away with the auth user", async () => {
    /**
     * The reason `consents` has no DELETE-blocking trigger, unlike
     * `audit_events`. A cascade issues a real DELETE; a trigger that raised
     * would make account deletion impossible, turning an immutability guard into
     * a privacy defect.
     */
    const temporary = await createUser("cascade");
    await seedConsent(temporary.id, "ai_processing", true);

    const deleted = await admin.auth.admin.deleteUser(temporary.id);
    if (deleted.error) throw new Error(`Deleting the auth user failed: ${deleted.error.message}`);

    const rows = expectOk(
      await admin.from("consents").select("id").eq("user_id", temporary.id),
      "looking up the deleted user's consent rows",
    ) as { id: string }[];
    expect(rows).toHaveLength(0);
  });
});
