import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-084 — authorization for `user_encryption_keys` against a real database.
 *
 * This table holds wrapped key material and has **no client policies at all**.
 * Security §7 still requires two-user coverage, and the assertion here is
 * stronger than for a policied table: neither user may reach the table for any
 * operation, including their own row.
 *
 * Requires a running local Supabase (`pnpm db:start`). Fails rather than skips
 * when the database is absent — a skipped authorization test reads identically
 * to a passing one.
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
  if (error.hint) parts.push(`hint=${error.hint}`);
  return parts.join(" | ");
}

function expectOk<R extends QueryResult>(result: R, context: string): NonNullable<R["data"]> {
  if (result.error) {
    throw new Error(
      `${context}: expected success but PostgREST returned ${describeError(result.error)}`,
    );
  }
  if (result.data === null) throw new Error(`${context}: query succeeded but returned no row`);
  return result.data as NonNullable<R["data"]>;
}

/**
 * Asserts a client cannot reach the table.
 *
 * Accepts either an error (no grant) or an empty result (no policy). A returned
 * row is the failure this exists to catch.
 */
function expectNoAccess(result: QueryResult, context: string): void {
  if (result.error) return;
  const rows = Array.isArray(result.data) ? result.data : result.data === null ? [] : [result.data];
  if (rows.length > 0) {
    throw new Error(
      `${context}: key material was readable by a client role. ${rows.length} row(s).`,
    );
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
  const email = `atl084-${label}-${Date.now()}@example.test`;
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

/** Seeds a key row as the service would, using service-role. */
async function seedKey(userId: string, kekVersion = 1): Promise<string> {
  const inserted = expectOk(
    await admin
      .from("user_encryption_keys")
      .insert({ user_id: userId, wrapped_dek: `atlas.v1.seed.${userId}`, kek_version: kekVersion })
      .select("id")
      .single(),
    `seeding a key row for ${userId}`,
  );
  return inserted.id;
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-084 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("user_encryption_keys").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.user_encryption_keys as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");

  await seedKey(alice.id);
  await seedKey(bob.id);
}, 60_000);

afterAll(async () => {
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("authenticated users have no access at all", () => {
  it("cannot read their own key row", async () => {
    // Deliberate: a user has no operation that needs their wrapped DEK, so
    // exposing it would only widen the blast radius of any future RLS mistake.
    expectNoAccess(
      await alice.client.from("user_encryption_keys").select("*").eq("user_id", alice.id),
      "alice reading her own key row",
    );
  });

  it("cannot read another user's key row", async () => {
    expectNoAccess(
      await alice.client.from("user_encryption_keys").select("*").eq("user_id", bob.id),
      "alice reading bob's key row",
    );
  });

  it("cannot read the table unfiltered", async () => {
    expectNoAccess(
      await alice.client.from("user_encryption_keys").select("*"),
      "alice selecting all key rows",
    );
  });

  it("cannot insert a key row", async () => {
    const attempt = await alice.client
      .from("user_encryption_keys")
      .insert({ user_id: alice.id, wrapped_dek: "forged", kek_version: 1 })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("cannot overwrite key material", async () => {
    // Substituting a known wrapping would let an attacker read future writes.
    const attempt = await alice.client
      .from("user_encryption_keys")
      .update({ wrapped_dek: "forged" })
      .eq("user_id", alice.id)
      .select("id");

    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);

    const rows = expectOk(
      await admin.from("user_encryption_keys").select("wrapped_dek").eq("user_id", alice.id),
      "verifying alice's key material was untouched",
    ) as { wrapped_dek: string | null }[];
    expect(rows[0]?.wrapped_dek).not.toBe("forged");
  });

  it("cannot destroy a key row", async () => {
    // Deleting a key would be a denial-of-service on the owner's own data.
    const attempt = await alice.client
      .from("user_encryption_keys")
      .delete()
      .eq("user_id", alice.id)
      .select("id");

    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);

    const rows = expectOk(
      await admin.from("user_encryption_keys").select("id").eq("user_id", alice.id),
      "verifying alice's key row survived",
    ) as { id: string }[];
    expect(rows).toHaveLength(1);
  });
});

describe("anonymous access", () => {
  it("is denied entirely", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(
      await anon.from("user_encryption_keys").select("*"),
      "anonymous reading key rows",
    );
  });
});

describe("service_role", () => {
  it("can read key rows", async () => {
    const rows = expectOk(
      await admin.from("user_encryption_keys").select("id").eq("user_id", alice.id),
      "service_role reading alice's key",
    ) as { id: string }[];
    expect(rows).toHaveLength(1);
  });

  it("cannot create a second active key for one user", async () => {
    // The unique partial index. Two active DEKs would split the user's data and
    // half would survive a crypto-shred.
    const attempt = await admin
      .from("user_encryption_keys")
      .insert({ user_id: alice.id, wrapped_dek: "second", kek_version: 1 })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("can retire a key and then add a new active one", async () => {
    const retiring = await createUser("rotate");
    await seedKey(retiring.id);

    expectOk(
      await admin
        .from("user_encryption_keys")
        .update({ status: "retired" })
        .eq("user_id", retiring.id)
        .select("id"),
      "retiring the key",
    );

    expectOk(
      await admin
        .from("user_encryption_keys")
        .insert({ user_id: retiring.id, wrapped_dek: "next", kek_version: 2 })
        .select("id"),
      "adding the replacement key",
    );

    await admin.auth.admin.deleteUser(retiring.id);
  });
});

describe("destruction integrity", () => {
  it("rejects a half-destroyed row", async () => {
    // Status destroyed while material remains would be indistinguishable from a
    // healthy key. The check constraint refuses it.
    const attempt = await admin
      .from("user_encryption_keys")
      .update({ status: "destroyed" })
      .eq("user_id", bob.id)
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("rejects clearing material while the key still reads as active", async () => {
    const attempt = await admin
      .from("user_encryption_keys")
      .update({ wrapped_dek: null })
      .eq("user_id", bob.id)
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("accepts a complete crypto-shred and keeps the row as evidence", async () => {
    const shredded = await createUser("shred");
    await seedKey(shredded.id);

    expectOk(
      await admin
        .from("user_encryption_keys")
        .update({
          wrapped_dek: null,
          status: "destroyed",
          destroyed_at: new Date().toISOString(),
        })
        .eq("user_id", shredded.id)
        .select("id"),
      "crypto-shredding the key",
    );

    const rows = expectOk(
      await admin
        .from("user_encryption_keys")
        .select("wrapped_dek, status, destroyed_at")
        .eq("user_id", shredded.id),
      "reading the shredded key row",
    ) as { wrapped_dek: string | null; status: string; destroyed_at: string | null }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.wrapped_dek).toBeNull();
    expect(rows[0]?.status).toBe("destroyed");
    expect(rows[0]?.destroyed_at).toBeTruthy();

    await admin.auth.admin.deleteUser(shredded.id);
  });
});

describe("account deletion", () => {
  it("cascades key rows away with the auth user", async () => {
    const temporary = await createUser("cascade");
    await seedKey(temporary.id);

    const deleted = await admin.auth.admin.deleteUser(temporary.id);
    if (deleted.error) throw new Error(`Deleting the auth user failed: ${deleted.error.message}`);

    const rows = expectOk(
      await admin.from("user_encryption_keys").select("id").eq("user_id", temporary.id),
      "looking up the deleted user's key rows",
    ) as { id: string }[];
    expect(rows).toHaveLength(0);
  });
});
