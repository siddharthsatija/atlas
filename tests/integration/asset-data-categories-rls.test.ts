import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-028 — authorization and cross-user foreign key protection for
 * `asset_data_categories`, against a real database.
 *
 * Two halves, both named by the ticket:
 *
 *  1. **Two-user RLS**, including the DELETE this table grants and
 *     `digital_assets` does not.
 *  2. **The cross-user FK attempt.** A plain `references digital_assets (id)`
 *     would satisfy referential integrity and still allow a row claiming one
 *     owner while pointing at another's asset — hidden from both by RLS, and
 *     counted by the rules engine reading with service-role. Only a real
 *     database can prove the composite key forbids it.
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
let bobCategoryId: string;

async function createUser(label: string): Promise<TestUser> {
  const email = `atl028-${label}-${Date.now()}@example.test`;
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

async function seedAsset(userId: string, serviceName: string): Promise<string> {
  const row = expectOk(
    await admin
      .from("digital_assets")
      .insert({ user_id: userId, service_name: serviceName, category: "social" })
      .select("id")
      .single(),
    `seeding an asset for ${userId}`,
  );

  return row.id;
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-028 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("asset_data_categories").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.asset_data_categories as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");

  aliceAssetId = await seedAsset(alice.id, "Alice Service");
  bobAssetId = await seedAsset(bob.id, "Bob Service");

  expectOk(
    await admin
      .from("asset_data_categories")
      .insert({ user_id: alice.id, asset_id: aliceAssetId, category: "contact" })
      .select("id")
      .single(),
    "seeding alice's data category",
  );

  const bobRow = expectOk(
    await admin
      .from("asset_data_categories")
      .insert({ user_id: bob.id, asset_id: bobAssetId, category: "financial" })
      .select("id")
      .single(),
    "seeding bob's data category",
  );

  bobCategoryId = bobRow.id;
}, 60_000);

afterAll(async () => {
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("cross-user foreign keys are unrepresentable", () => {
  it("refuses a row whose user_id and asset_id belong to different people", async () => {
    /**
     * The acceptance criterion, attempted with **service-role** — which bypasses
     * RLS entirely. That is the point: RLS would merely hide such a row, while
     * the composite key means it cannot exist in the first place.
     */
    const attempt = await admin
      .from("asset_data_categories")
      .insert({ user_id: alice.id, asset_id: bobAssetId, category: "contact" })
      .select("id");

    expect(attempt.error, "a cross-user row was accepted").not.toBeNull();
  });

  it("refuses the mirror image too", async () => {
    const attempt = await admin
      .from("asset_data_categories")
      .insert({ user_id: bob.id, asset_id: aliceAssetId, category: "contact" })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("refuses an update that would move a row onto another user's asset", async () => {
    const attempt = await admin
      .from("asset_data_categories")
      .update({ asset_id: bobAssetId })
      .eq("id", bobCategoryId)
      .eq("user_id", bob.id)
      .select("id");

    // Bob's row pointing at Bob's asset is fine; the guard is that changing the
    // *owner* while keeping the asset, or vice versa, cannot succeed.
    const crossing = await admin
      .from("asset_data_categories")
      .update({ user_id: alice.id })
      .eq("id", bobCategoryId)
      .select("id");

    expect(attempt.error).toBeNull();
    expect(crossing.error, "a row was reassigned across users").not.toBeNull();
  });

  it("removes categories when the owning asset is deleted", async () => {
    const doomedAssetId = await seedAsset(alice.id, "Doomed Service");
    expectOk(
      await admin
        .from("asset_data_categories")
        .insert({ user_id: alice.id, asset_id: doomedAssetId, category: "device" })
        .select("id")
        .single(),
      "seeding a category on the doomed asset",
    );

    await admin.from("digital_assets").delete().eq("id", doomedAssetId);

    const remaining = expectOk(
      await admin.from("asset_data_categories").select("id").eq("asset_id", doomedAssetId),
      "categories after the asset was deleted",
    ) as { id: string }[];

    expect(remaining).toHaveLength(0);
  });
});

describe("sensitivity is generated by the database", () => {
  it.each([
    ["financial", "high"],
    ["health", "high"],
    ["biometric", "high"],
    ["location", "high"],
    ["contact", "standard"],
    ["identity", "standard"],
    ["other", "standard"],
  ])("rates %s as %s", async (category, expected) => {
    const assetId = await seedAsset(alice.id, `Sensitivity ${category}`);
    const row = expectOk(
      await admin
        .from("asset_data_categories")
        .insert({ user_id: alice.id, asset_id: assetId, category })
        .select("sensitivity")
        .single(),
      `inserting a ${category} category`,
    ) as { sensitivity: string };

    expect(row.sensitivity).toBe(expected);
  });

  it("cannot be supplied by a client", async () => {
    /**
     * ADR-004 fixes the high-sensitivity set and the score reads it. A writable
     * column would let a user downgrade a `financial` category to keep it out of
     * their own score, which makes the number meaningless for the person it is
     * meant to inform.
     */
    /**
     * Note what this does **not** rely on. Supabase's type generator includes
     * generated columns in the `Insert` type — `sensitivity?: string | null` —
     * so the call below compiles cleanly and TypeScript offers no protection
     * here at all. The database is the entire guarantee: Postgres rejects a
     * write to a generated column outright (`428C9`).
     *
     * That is why this assertion is made against a real database rather than
     * left to the type system, and why the repository never passes the field.
     */
    const attempt = await alice.client
      .from("asset_data_categories")
      .insert({
        user_id: alice.id,
        asset_id: aliceAssetId,
        category: "health",
        sensitivity: "standard",
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });
});

describe("two-user isolation", () => {
  it("returns only the owner's rows", async () => {
    const rows = expectOk(
      await alice.client.from("asset_data_categories").select("user_id"),
      "alice reading her own data categories",
    ) as { user_id: string }[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.user_id === alice.id)).toBe(true);
  });

  it("does not return another user's row asked for by id", async () => {
    expectNoAccess(
      await alice.client.from("asset_data_categories").select("*").eq("id", bobCategoryId),
      "alice reading bob's data category",
    );
  });

  it("refuses an insert attributed to another user", async () => {
    expectNoAccess(
      await alice.client
        .from("asset_data_categories")
        .insert({ user_id: bob.id, asset_id: bobAssetId, category: "content" })
        .select("id"),
      "alice inserting a category for bob",
    );
  });

  it("cannot update another user's row", async () => {
    expectNoAccess(
      await alice.client
        .from("asset_data_categories")
        .update({ description: "Edited by Alice" })
        .eq("id", bobCategoryId)
        .select("id"),
      "alice updating bob's data category",
    );
  });

  it("cannot delete another user's row", async () => {
    await alice.client.from("asset_data_categories").delete().eq("id", bobCategoryId);

    const survivor = expectOk(
      await admin.from("asset_data_categories").select("id").eq("id", bobCategoryId).single(),
      "bob's category after alice's delete attempt",
    );

    expect(survivor.id).toBe(bobCategoryId);
  });
});

describe("owners may remove their own categories", () => {
  it("deletes, unlike digital_assets", async () => {
    /**
     * Removing a category is ordinary editing (ATL-033), not the destruction of
     * a record with its own history. Someone who mistakenly recorded that a
     * service holds their health data must be able to take that back.
     */
    const assetId = await seedAsset(alice.id, "Removable Service");
    const row = expectOk(
      await admin
        .from("asset_data_categories")
        .insert({ user_id: alice.id, asset_id: assetId, category: "professional" })
        .select("id")
        .single(),
      "seeding a removable category",
    );

    const deleted = expectOk(
      await alice.client.from("asset_data_categories").delete().eq("id", row.id).select("id"),
      "alice deleting her own data category",
    ) as { id: string }[];

    expect(deleted).toHaveLength(1);
  });
});

describe("duplicate protection", () => {
  it("refuses the same category twice on one asset", async () => {
    // ADR-004 counts asset × category pairs; a duplicate would deduct twice for
    // one fact.
    const attempt = await admin
      .from("asset_data_categories")
      .insert({ user_id: alice.id, asset_id: aliceAssetId, category: "contact" })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("allows the same category on a different asset", async () => {
    const otherAssetId = await seedAsset(alice.id, "Another Service");

    const inserted = expectOk(
      await admin
        .from("asset_data_categories")
        .insert({ user_id: alice.id, asset_id: otherAssetId, category: "contact" })
        .select("id"),
      "the same category on a second asset",
    ) as { id: string }[];

    expect(inserted).toHaveLength(1);
  });
});

describe("anonymous access", () => {
  it("reaches nothing", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(
      await anon.from("asset_data_categories").select("*"),
      "an unauthenticated client reading data categories",
    );
  });
});
