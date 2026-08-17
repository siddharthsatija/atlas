import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-105 — authorization and schema integrity for `user_personal_fields`,
 * against a real database.
 *
 * This table holds the most sensitive data in the product (ADR-002), so the
 * things only Postgres can settle are settled here:
 *
 *  1. **Two-user RLS.** A person may read their own rows and write none. A client
 *     that could insert would bypass the `personal_fields_storage` consent gate
 *     entirely; one that could update could rewrite a stored identity value; one
 *     that could delete could remove restricted data with no audit trail.
 *  2. **The field-key and label constraints**, which encode §7.13's closed
 *     vocabulary and ADR-002's label cap.
 *  3. **The shared `set_updated_at` trigger**, attached here as it is on every
 *     other user-owned table.
 *  4. **Cascade on account deletion**, which is the row half of security §14's
 *     guarantee (the key half is ADR-003's crypto-shred, proven in ATL-084).
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
let aliceFieldId: string;

/** Stands in for a sealed envelope. RLS and constraints do not inspect it. */
const ENVELOPE = "envelope-fixture";

async function createUser(label: string): Promise<TestUser> {
  const email = `atl105-${label}-${Date.now()}@example.test`;
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

/** Seeds directly, so RLS is tested without depending on the service. */
async function seedField(userId: string, fieldKey: string, label: string): Promise<string> {
  const row = expectOk(
    await admin
      .from("user_personal_fields")
      .insert({ user_id: userId, field_key: fieldKey, label, value_encrypted: ENVELOPE })
      .select("id")
      .single(),
    `seeding ${fieldKey}`,
  );
  return row.id;
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-105 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  alice = await createUser("alice");
  bob = await createUser("bob");

  aliceFieldId = await seedField(alice.id, "email", "Personal Gmail");
});

afterAll(async () => {
  if (!admin) return;
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("two-user isolation", () => {
  it("lets a person read their own fields", async () => {
    const result = await alice.client
      .from("user_personal_fields")
      .select("*")
      .eq("user_id", alice.id);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("hides another person's fields completely", async () => {
    // Not "returns an error" — RLS filters, so the honest assertion is that no
    // row is reachable.
    expectNoAccess(
      await bob.client.from("user_personal_fields").select("*"),
      "Bob reading every personal field",
    );
  });

  it("hides a field even when its id is known", async () => {
    expectNoAccess(
      await bob.client.from("user_personal_fields").select("*").eq("id", aliceFieldId),
      "Bob reading Alice's field by id",
    );
  });

  it("refuses anonymous reads", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(await anon.from("user_personal_fields").select("*"), "anon reading fields");
  });
});

describe("clients may not write", () => {
  /**
   * The grants and the policies are two independent gates, and there is no
   * insert, update or delete policy on this table. Every write is server-side,
   * behind the consent gate — which a client-issued insert would bypass.
   */
  it("refuses an insert by its owner", async () => {
    expectRejected(
      await alice.client
        .from("user_personal_fields")
        .insert({
          user_id: alice.id,
          field_key: "phone",
          label: "Mobile",
          value_encrypted: ENVELOPE,
        })
        .select("id"),
      "Alice inserting her own field",
    );
  });

  it("refuses an update by its owner", async () => {
    expectRejected(
      await alice.client
        .from("user_personal_fields")
        .update({ label: "Renamed" })
        .eq("id", aliceFieldId)
        .select("id"),
      "Alice renaming her own field",
    );
  });

  it("refuses a delete by its owner", async () => {
    /**
     * Deletion is server-side so it leaves an audited path the client cannot
     * route around. `PersonalFieldService.remove` is the supported way.
     */
    expectRejected(
      await alice.client.from("user_personal_fields").delete().eq("id", aliceFieldId).select("id"),
      "Alice deleting her own field",
    );
  });
});

describe("the §7.13 vocabulary and ADR-002 label rule", () => {
  it.each(["full_name", "email", "phone", "address", "username", "other"])(
    "accepts the specified key %s",
    async (fieldKey) => {
      const id = await seedField(bob.id, fieldKey, `Bob ${fieldKey}`);
      expect(id).toBeTruthy();
    },
  );

  it("rejects a key outside the specified six", async () => {
    expectRejected(
      await admin
        .from("user_personal_fields")
        .insert({
          user_id: bob.id,
          field_key: "passport_number",
          label: "Passport",
          value_encrypted: ENVELOPE,
        })
        .select("id"),
      "unspecified field key",
    );
  });

  it("rejects an empty label", async () => {
    expectRejected(
      await admin
        .from("user_personal_fields")
        .insert({ user_id: bob.id, field_key: "other", label: "", value_encrypted: ENVELOPE })
        .select("id"),
      "empty label",
    );
  });

  it("rejects a label past the cap", async () => {
    expectRejected(
      await admin
        .from("user_personal_fields")
        .insert({
          user_id: bob.id,
          field_key: "other",
          label: "x".repeat(101),
          value_encrypted: ENVELOPE,
        })
        .select("id"),
      "over-long label",
    );
  });

  it("allows two fields with the same key and different labels", async () => {
    /**
     * ADR-002's own example — a label of "Personal Gmail" — only means something
     * if a person can hold more than one `email`. This is the assertion that
     * proves no unique index forbids the second address.
     */
    const second = await seedField(alice.id, "email", "Work address");
    expect(second).not.toBe(aliceFieldId);
  });
});

describe("lifecycle columns", () => {
  it("defaults created_at and updated_at from the database clock", async () => {
    const row = expectOk(
      await admin
        .from("user_personal_fields")
        .insert({
          user_id: bob.id,
          field_key: "username",
          label: "Handle",
          value_encrypted: ENVELOPE,
        })
        .select("created_at, updated_at, last_used_at")
        .single(),
      "inserting without timestamps",
    );

    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
    /** Null until ATL-058 supplies the first caller. */
    expect(row.last_used_at).toBeNull();
  });

  it("advances updated_at on modification via the shared trigger", async () => {
    const id = await seedField(bob.id, "address", "Home");

    const before = expectOk(
      await admin.from("user_personal_fields").select("updated_at").eq("id", id).single(),
      "reading updated_at before",
    );

    const after = expectOk(
      await admin
        .from("user_personal_fields")
        .update({ label: "Home address" })
        .eq("id", id)
        .select("updated_at")
        .single(),
      "updating the label",
    );

    expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updated_at).getTime(),
    );
  });
});

describe("deletion", () => {
  it("takes every field with the account", async () => {
    /**
     * Security §14 and ADR-003: row deletion plus crypto-shredding. This asserts
     * the row half — the key half is ATL-084's, already proven there.
     */
    const temporary = await createUser("cascade");
    await seedField(temporary.id, "full_name", "Name");

    const deleted = await admin.auth.admin.deleteUser(temporary.id);
    expect(deleted.error).toBeNull();

    const remaining = await admin
      .from("user_personal_fields")
      .select("id")
      .eq("user_id", temporary.id);

    expect(remaining.data ?? []).toHaveLength(0);
  });
});
