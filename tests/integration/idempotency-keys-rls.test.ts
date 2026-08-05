import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-104 — authorization and constraints for `idempotency_keys` against a real
 * database.
 *
 * The table has no client policies, so the two-user assertion required by
 * security §7 is stronger than for a policied table: neither user may reach it
 * for any operation, including rows they own. A client that could read these
 * rows would learn which operations another session had run; a client that could
 * write them could suppress somebody else's transition by pre-claiming its key.
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
    throw new Error(`${context}: idempotency rows were readable by a client role.`);
  }
}

interface TestUser {
  id: string;
  client: TypedClient;
}

let admin: TypedClient;
let alice: TestUser;
let bob: TestUser;

const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

async function createUser(label: string): Promise<TestUser> {
  const email = `atl104-${label}-${Date.now()}@example.test`;
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

async function seedClaim(userId: string, key: string, scope = "request_transition") {
  return expectOk(
    await admin
      .from("idempotency_keys")
      .insert({ user_id: userId, scope, idempotency_key: key, expires_at: future() })
      .select("id")
      .single(),
    `seeding a claim for ${key}`,
  );
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-104 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("idempotency_keys").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.idempotency_keys as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");

  await seedClaim(alice.id, "alice-key-1");
  await seedClaim(bob.id, "bob-key-1");
}, 60_000);

afterAll(async () => {
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("authenticated users have no access at all", () => {
  it("cannot read their own claims", async () => {
    expectNoAccess(
      await alice.client.from("idempotency_keys").select("*").eq("user_id", alice.id),
      "alice reading her own claims",
    );
  });

  it("cannot read another user's claims", async () => {
    expectNoAccess(
      await alice.client.from("idempotency_keys").select("*").eq("user_id", bob.id),
      "alice reading bob's claims",
    );
  });

  it("cannot read the table unfiltered", async () => {
    expectNoAccess(
      await alice.client.from("idempotency_keys").select("*"),
      "alice selecting all claims",
    );
  });

  it("cannot pre-claim a key", async () => {
    // Forging a claim would let one user suppress another's transition.
    const attempt = await alice.client
      .from("idempotency_keys")
      .insert({
        user_id: bob.id,
        scope: "request_transition",
        idempotency_key: "forged",
        expires_at: future(),
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("cannot overwrite a recorded result", async () => {
    const attempt = await alice.client
      .from("idempotency_keys")
      .update({ result_hash: "f".repeat(64) })
      .eq("user_id", alice.id)
      .select("id");

    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);
  });

  it("cannot delete a claim", async () => {
    // Deleting a live claim would re-open a window for duplicate execution.
    const attempt = await alice.client
      .from("idempotency_keys")
      .delete()
      .eq("user_id", alice.id)
      .select("id");

    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);

    const rows = expectOk(
      await admin.from("idempotency_keys").select("id").eq("user_id", alice.id),
      "verifying alice's claim survived",
    ) as { id: string }[];
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("anonymous access", () => {
  it("is denied entirely", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(
      await anon.from("idempotency_keys").select("*"),
      "anonymous reading idempotency rows",
    );
  });
});

describe("service_role lifecycle", () => {
  it("can claim, complete, and purge", async () => {
    const claim = await seedClaim(alice.id, `lifecycle-${Date.now()}`);

    expectOk(
      await admin
        .from("idempotency_keys")
        .update({
          result_encrypted: "atlas.v1.abc.def",
          result_hash: "a".repeat(64),
          completed_at: new Date().toISOString(),
        })
        .eq("id", claim.id)
        .select("id"),
      "completing the claim",
    );

    expectOk(
      await admin.from("idempotency_keys").delete().eq("id", claim.id).select("id"),
      "purging the claim",
    );
  });
});

describe("constraints", () => {
  it("refuses a duplicate key within the same user and scope", async () => {
    // The index that makes the claim atomic — and therefore the race safe.
    const key = `dup-${Date.now()}`;
    await seedClaim(alice.id, key);

    const duplicate = await admin
      .from("idempotency_keys")
      .insert({
        user_id: alice.id,
        scope: "request_transition",
        idempotency_key: key,
        expires_at: future(),
      })
      .select("id");

    expect(duplicate.error).not.toBeNull();
  });

  it("permits the same key under a different scope", async () => {
    const key = `scoped-${Date.now()}`;
    await seedClaim(alice.id, key, "request_transition");

    expectOk(
      await admin
        .from("idempotency_keys")
        .insert({
          user_id: alice.id,
          scope: "export_job",
          idempotency_key: key,
          expires_at: future(),
        })
        .select("id")
        .single(),
      "same key under a different scope",
    );
  });

  it("permits the same key for a different user", async () => {
    const key = `per-user-${Date.now()}`;
    await seedClaim(alice.id, key);

    expectOk(
      await admin
        .from("idempotency_keys")
        .insert({
          user_id: bob.id,
          scope: "request_transition",
          idempotency_key: key,
          expires_at: future(),
        })
        .select("id")
        .single(),
      "same key for a different user",
    );
  });

  it("refuses a half-completed row", async () => {
    // Ciphertext with no hash to check it against is a state the replay path
    // could not act on.
    const claim = await seedClaim(alice.id, `half-${Date.now()}`);

    const attempt = await admin
      .from("idempotency_keys")
      .update({ result_encrypted: "atlas.v1.abc.def" })
      .eq("id", claim.id)
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("refuses a malformed result hash", async () => {
    const claim = await seedClaim(alice.id, `badhash-${Date.now()}`);

    const attempt = await admin
      .from("idempotency_keys")
      .update({
        result_encrypted: "atlas.v1.abc.def",
        result_hash: "not-a-sha256",
        completed_at: new Date().toISOString(),
      })
      .eq("id", claim.id)
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("refuses a malformed scope", async () => {
    const attempt = await admin
      .from("idempotency_keys")
      .insert({
        user_id: alice.id,
        scope: "Request Transition",
        idempotency_key: `scope-${Date.now()}`,
        expires_at: future(),
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });
});

describe("account deletion", () => {
  it("cascades claims away with the auth user", async () => {
    // Unlike audit_events, these rows are a 24-hour lock rather than evidence,
    // so they follow the account.
    const temporary = await createUser("cascade");
    await seedClaim(temporary.id, `cascade-${Date.now()}`);

    const deleted = await admin.auth.admin.deleteUser(temporary.id);
    if (deleted.error) throw new Error(`Deleting the auth user failed: ${deleted.error.message}`);

    const rows = expectOk(
      await admin.from("idempotency_keys").select("id").eq("user_id", temporary.id),
      "looking up the deleted user's claims",
    ) as { id: string }[];
    expect(rows).toHaveLength(0);
  });
});
