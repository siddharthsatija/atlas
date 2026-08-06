import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-027 — authorization for `digital_assets`, against a real database.
 *
 * This table is user-facing, so its policies carry predicates — and a predicate
 * can be wrong. That makes the cross-user assertions the interesting ones,
 * unlike the deny-all internal tables from ATL-084/103/104.
 *
 * The encryption round trip is covered without a database in
 * `src/server/repositories/digital-asset-repository.integration.test.ts`; what
 * can only be checked here is whether the policies and grants actually hold.
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

/** Passes when the operation was refused *or* silently matched nothing. */
function expectNoAccess(result: QueryResult, context: string): void {
  if (result.error) return;
  const rows = Array.isArray(result.data) ? result.data : result.data === null ? [] : [result.data];
  if (rows.length > 0) {
    throw new Error(`${context}: rows were reachable. ${rows.length} row(s).`);
  }
}

interface TestUser {
  id: string;
  client: TypedClient;
}

let admin: TypedClient;
let alice: TestUser;
let bob: TestUser;
let aliceAssetId: string;
let bobAssetId: string;

async function createUser(label: string): Promise<TestUser> {
  const email = `atl027-${label}-${Date.now()}@example.test`;
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

async function seedAsset(
  userId: string,
  overrides: Partial<Database["public"]["Tables"]["digital_assets"]["Insert"]> = {},
): Promise<string> {
  const row = expectOk(
    await admin
      .from("digital_assets")
      .insert({
        user_id: userId,
        service_name: "Fixture Service",
        category: "social",
        ...overrides,
      })
      .select("id")
      .single(),
    `seeding an asset for ${userId}`,
  );

  return row.id;
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-027 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("digital_assets").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.digital_assets as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");

  aliceAssetId = await seedAsset(alice.id, { service_name: "Alice Service" });
  bobAssetId = await seedAsset(bob.id, { service_name: "Bob Service" });
}, 60_000);

afterAll(async () => {
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("owners reach their own assets", () => {
  it("returns the owner's rows", async () => {
    const rows = expectOk(
      await alice.client.from("digital_assets").select("*"),
      "alice reading her own assets",
    ) as { user_id: string }[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.user_id === alice.id)).toBe(true);
  });

  it("lets the owner insert for themselves", async () => {
    const inserted = expectOk(
      await alice.client
        .from("digital_assets")
        .insert({ user_id: alice.id, service_name: "Self Added", category: "shopping" })
        .select("id"),
      "alice inserting her own asset",
    ) as { id: string }[];

    expect(inserted).toHaveLength(1);
  });

  it("lets the owner update their own row", async () => {
    const updated = expectOk(
      await alice.client
        .from("digital_assets")
        .update({ status: "inactive" })
        .eq("id", aliceAssetId)
        .select("id"),
      "alice updating her own asset",
    ) as { id: string }[];

    expect(updated).toHaveLength(1);
  });
});

describe("two-user isolation", () => {
  it("does not return another user's assets, even asked for by user id", async () => {
    // The policy predicate is the only thing between these two collections.
    expectNoAccess(
      await alice.client.from("digital_assets").select("*").eq("user_id", bob.id),
      "alice reading bob's assets",
    );
  });

  it("does not return another user's asset asked for by row id", async () => {
    expectNoAccess(
      await alice.client.from("digital_assets").select("*").eq("id", bobAssetId),
      "alice reading bob's asset by id",
    );
  });

  it("filters an unfiltered select to the owner", async () => {
    const rows = expectOk(
      await bob.client.from("digital_assets").select("user_id"),
      "bob selecting every asset row",
    ) as { user_id: string }[];

    expect(rows.every((row) => row.user_id === bob.id)).toBe(true);
  });

  it("refuses an insert attributed to another user", async () => {
    /**
     * The `with check` half of the insert policy. Without it, a client could
     * write rows into someone else's collection — architecture §10: a
     * client-supplied `user_id` is never authority.
     */
    expectNoAccess(
      await alice.client
        .from("digital_assets")
        .insert({ user_id: bob.id, service_name: "Planted", category: "social" })
        .select("id"),
      "alice inserting an asset for bob",
    );
  });

  it("cannot update another user's row", async () => {
    expectNoAccess(
      await alice.client
        .from("digital_assets")
        .update({ service_name: "Renamed by Alice" })
        .eq("id", bobAssetId)
        .select("id"),
      "alice updating bob's asset",
    );

    // And the row is genuinely untouched, not merely unreported.
    const row = expectOk(
      await admin.from("digital_assets").select("service_name").eq("id", bobAssetId).single(),
      "reading bob's asset as admin",
    );

    expect(row.service_name).toBe("Bob Service");
  });

  it("cannot move a row to another user", async () => {
    // The `with check` half of the update policy. Passing `using` alone would
    // let an owner hand their row to someone else.
    expectNoAccess(
      await alice.client
        .from("digital_assets")
        .update({ user_id: bob.id })
        .eq("id", aliceAssetId)
        .select("id"),
      "alice reassigning her asset to bob",
    );
  });
});

describe("clients cannot delete", () => {
  it("cannot delete their own asset", async () => {
    /**
     * Removal is a status transition (ATL-036), not a row deletion. A client
     * DELETE would also destroy the findings, permissions, and activity that
     * reference the asset — the history that explains the user's own score.
     */
    await alice.client.from("digital_assets").delete().eq("id", aliceAssetId);

    const survivor = expectOk(
      await admin.from("digital_assets").select("id").eq("id", aliceAssetId).single(),
      "alice's asset after her delete attempt",
    );

    expect(survivor.id).toBe(aliceAssetId);
  });

  it("cannot delete another user's asset", async () => {
    await alice.client.from("digital_assets").delete().eq("id", bobAssetId);

    const survivor = expectOk(
      await admin.from("digital_assets").select("id").eq("id", bobAssetId).single(),
      "bob's asset after alice's delete attempt",
    );

    expect(survivor.id).toBe(bobAssetId);
  });
});

describe("anonymous access", () => {
  it("reaches nothing", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(
      await anon.from("digital_assets").select("*"),
      "an unauthenticated client reading assets",
    );
  });
});

describe("column constraints hold in the database", () => {
  it.each([
    ["an unknown status", { status: "deleted" }],
    ["an unknown source type", { source_type: "scraped" }],
    ["an unknown confidence", { confidence: "certain" }],
    ["a service domain carrying a scheme", { service_domain: "https://example.com" }],
    ["an uppercase category", { category: "Social" }],
    ["a future verification date", { last_verified_at: "2999-01-01T00:00:00.000Z" }],
  ])("rejects %s", async (_label, overrides) => {
    /**
     * Asserted through the database rather than the application, because these
     * are the gate that holds when something writes without going through the
     * repository — a migration, a console, a future service.
     */
    const attempt = await admin
      .from("digital_assets")
      .insert({
        user_id: alice.id,
        service_name: "Constraint Probe",
        category: "social",
        ...overrides,
      })
      .select("id");

    expect(attempt.error, `expected ${_label} to be rejected`).not.toBeNull();
  });

  it("rejects metadata_json that is not an object", async () => {
    const attempt = await admin
      .from("digital_assets")
      .insert({
        user_id: alice.id,
        service_name: "Constraint Probe",
        category: "social",
        metadata_json: ["not", "an", "object"],
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("removes assets when the owning auth user is deleted", async () => {
    // The cascade is the deletion path, and ATL-081 depends on it.
    const doomed = await createUser("doomed");
    const assetId = await seedAsset(doomed.id);

    await admin.auth.admin.deleteUser(doomed.id);

    const remaining = expectOk(
      await admin.from("digital_assets").select("id").eq("id", assetId),
      "assets belonging to a deleted user",
    ) as { id: string }[];

    expect(remaining).toHaveLength(0);
  });
});
