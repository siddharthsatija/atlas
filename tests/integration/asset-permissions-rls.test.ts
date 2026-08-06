import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";
import { permissionExposureScore } from "@/lib/assets/permissions";

/**
 * ATL-029 — authorization and cross-user protection for `asset_permissions`,
 * against a real database.
 *
 * The ticket names two-user RLS tests. Alongside them this asserts the composite
 * foreign key — reused from ATL-028 — and the arithmetic ADR-004's permission
 * factor depends on, because "total recorded" versus "active only" is a
 * distinction that is easy to get wrong in SQL and changes every user's score.
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
let bobPermissionId: string;

async function createUser(label: string): Promise<TestUser> {
  const email = `atl029-${label}-${Date.now()}@example.test`;
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
      "ATL-029 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("asset_permissions").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.asset_permissions as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");

  aliceAssetId = await seedAsset(alice.id, "Alice Service");
  bobAssetId = await seedAsset(bob.id, "Bob Service");

  expectOk(
    await admin
      .from("asset_permissions")
      .insert({
        user_id: alice.id,
        asset_id: aliceAssetId,
        permission_type: "oauth_access",
        scope: "broad",
      })
      .select("id")
      .single(),
    "seeding alice's permission",
  );

  const bobRow = expectOk(
    await admin
      .from("asset_permissions")
      .insert({
        user_id: bob.id,
        asset_id: bobAssetId,
        permission_type: "oauth_access",
        scope: "limited",
      })
      .select("id")
      .single(),
    "seeding bob's permission",
  );

  bobPermissionId = bobRow.id;
}, 60_000);

afterAll(async () => {
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("cross-user foreign keys are unrepresentable", () => {
  it("refuses a row whose user_id and asset_id belong to different people", async () => {
    /**
     * Attempted with **service-role**, which bypasses RLS entirely. That is the
     * point: RLS would merely hide such a row, while the composite key means it
     * cannot exist.
     */
    const attempt = await admin
      .from("asset_permissions")
      .insert({
        user_id: alice.id,
        asset_id: bobAssetId,
        permission_type: "planted",
        scope: "broad",
      })
      .select("id");

    expect(attempt.error, "a cross-user row was accepted").not.toBeNull();
  });

  it("refuses the mirror image too", async () => {
    const attempt = await admin
      .from("asset_permissions")
      .insert({
        user_id: bob.id,
        asset_id: aliceAssetId,
        permission_type: "planted",
        scope: "broad",
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("refuses to reassign a row across users", async () => {
    const attempt = await admin
      .from("asset_permissions")
      .update({ user_id: alice.id })
      .eq("id", bobPermissionId)
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("removes permissions when the owning asset is deleted", async () => {
    const doomedAssetId = await seedAsset(alice.id, "Doomed Service");
    expectOk(
      await admin
        .from("asset_permissions")
        .insert({
          user_id: alice.id,
          asset_id: doomedAssetId,
          permission_type: "marketing",
          scope: "limited",
        })
        .select("id")
        .single(),
      "seeding a permission on the doomed asset",
    );

    await admin.from("digital_assets").delete().eq("id", doomedAssetId);

    const remaining = expectOk(
      await admin.from("asset_permissions").select("id").eq("asset_id", doomedAssetId),
      "permissions after the asset was deleted",
    );

    expect(remaining).toHaveLength(0);
  });
});

describe("vocabularies are enforced by the database", () => {
  it.each([
    ["an unknown scope", { scope: "partial" }],
    ["an unknown status", { status: "expired" }],
    ["an uppercase permission_type", { permission_type: "OAuth" }],
    ["a future verification date", { last_verified_at: "2999-01-01T00:00:00.000Z" }],
  ])("rejects %s", async (_label, overrides) => {
    const assetId = await seedAsset(alice.id, `Probe ${JSON.stringify(overrides)}`);
    const attempt = await admin
      .from("asset_permissions")
      .insert({
        user_id: alice.id,
        asset_id: assetId,
        permission_type: "probe",
        scope: "limited",
        ...overrides,
      })
      .select("id");

    expect(attempt.error, `expected ${_label} to be rejected`).not.toBeNull();
  });

  it("refuses the same permission type twice on one asset", async () => {
    // A duplicate would move ADR-004's denominator without the user's exposure
    // changing.
    const attempt = await admin
      .from("asset_permissions")
      .insert({
        user_id: alice.id,
        asset_id: aliceAssetId,
        permission_type: "oauth_access",
        scope: "limited",
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("defaults status to active", async () => {
    const assetId = await seedAsset(alice.id, "Default Status Service");
    const row = expectOk(
      await admin
        .from("asset_permissions")
        .insert({
          user_id: alice.id,
          asset_id: assetId,
          permission_type: "contacts",
          scope: "limited",
        })
        .select("status")
        .single(),
      "inserting without a status",
    );

    expect(row.status).toBe("active");
  });
});

describe("ADR-004's permission factor reads what the database stores", () => {
  it("counts revoked permissions in the denominator but not the numerator", async () => {
    /**
     * The distinction the score depends on. Revoking a broad permission must
     * raise the factor — if it did not, taking the action Atlas recommends would
     * leave the number unchanged.
     */
    const scorer = await createUser("scorer");
    const assetId = await seedAsset(scorer.id, "Scored Service");

    const permissions = [
      { permission_type: "broad_one", scope: "broad" as const },
      { permission_type: "broad_two", scope: "broad" as const },
      { permission_type: "limited_one", scope: "limited" as const },
      { permission_type: "limited_two", scope: "limited" as const },
    ];
    for (const permission of permissions) {
      expectOk(
        await admin
          .from("asset_permissions")
          .insert({ user_id: scorer.id, asset_id: assetId, ...permission })
          .select("id")
          .single(),
        `seeding ${permission.permission_type}`,
      );
    }

    const before = expectOk(
      await admin.from("asset_permissions").select("scope, status").eq("user_id", scorer.id),
      "reading the permission set",
    );
    expect(permissionExposureScore(before)).toBe(50);

    await admin
      .from("asset_permissions")
      .update({ status: "revoked" })
      .eq("user_id", scorer.id)
      .eq("permission_type", "broad_one");

    const after = expectOk(
      await admin.from("asset_permissions").select("scope, status").eq("user_id", scorer.id),
      "reading the permission set after revocation",
    );

    // Denominator unchanged at 4, numerator down to 1.
    expect(after).toHaveLength(4);
    expect(permissionExposureScore(after)).toBe(75);

    await admin.auth.admin.deleteUser(scorer.id);
  });
});

describe("two-user isolation", () => {
  it("returns only the owner's rows", async () => {
    const rows = expectOk(
      await alice.client.from("asset_permissions").select("user_id"),
      "alice reading her own permissions",
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.user_id === alice.id)).toBe(true);
  });

  it("does not return another user's row asked for by id", async () => {
    expectNoAccess(
      await alice.client.from("asset_permissions").select("*").eq("id", bobPermissionId),
      "alice reading bob's permission",
    );
  });

  it("refuses an insert attributed to another user", async () => {
    expectNoAccess(
      await alice.client
        .from("asset_permissions")
        .insert({
          user_id: bob.id,
          asset_id: bobAssetId,
          permission_type: "planted",
          scope: "broad",
        })
        .select("id"),
      "alice inserting a permission for bob",
    );
  });

  it("cannot revoke another user's permission", async () => {
    expectNoAccess(
      await alice.client
        .from("asset_permissions")
        .update({ status: "revoked" })
        .eq("id", bobPermissionId)
        .select("id"),
      "alice revoking bob's permission",
    );

    const row = expectOk(
      await admin.from("asset_permissions").select("status").eq("id", bobPermissionId).single(),
      "bob's permission after alice's attempt",
    );

    expect(row.status).toBe("active");
  });

  it("cannot delete another user's permission", async () => {
    await alice.client.from("asset_permissions").delete().eq("id", bobPermissionId);

    const survivor = expectOk(
      await admin.from("asset_permissions").select("id").eq("id", bobPermissionId).single(),
      "bob's permission after alice's delete attempt",
    );

    expect(survivor.id).toBe(bobPermissionId);
  });
});

describe("owners manage their own permissions", () => {
  it("revokes by updating status, keeping the row", async () => {
    const assetId = await seedAsset(alice.id, "Revocable Service");
    const row = expectOk(
      await admin
        .from("asset_permissions")
        .insert({
          user_id: alice.id,
          asset_id: assetId,
          permission_type: "revocable",
          scope: "broad",
        })
        .select("id")
        .single(),
      "seeding a revocable permission",
    );

    const updated = expectOk(
      await alice.client
        .from("asset_permissions")
        .update({ status: "revoked" })
        .eq("id", row.id)
        .select("id, status"),
      "alice revoking her own permission",
    );

    expect(updated).toHaveLength(1);
    expect(updated[0]?.status).toBe("revoked");
  });

  it("deletes one recorded by mistake", async () => {
    const assetId = await seedAsset(alice.id, "Mistaken Service");
    const row = expectOk(
      await admin
        .from("asset_permissions")
        .insert({
          user_id: alice.id,
          asset_id: assetId,
          permission_type: "mistaken",
          scope: "limited",
        })
        .select("id")
        .single(),
      "seeding a mistaken permission",
    );

    const deleted = expectOk(
      await alice.client.from("asset_permissions").delete().eq("id", row.id).select("id"),
      "alice deleting a mistaken permission",
    );

    expect(deleted).toHaveLength(1);
  });
});

describe("anonymous access", () => {
  it("reaches nothing", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(
      await anon.from("asset_permissions").select("*"),
      "an unauthenticated client reading permissions",
    );
  });
});
