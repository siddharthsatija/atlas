import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-015 — two-user RLS authorization tests.
 *
 * Security §7 requires every policy to be tested with two distinct users, and
 * this is the suite that does it. Nothing is mocked: two real users are created
 * against a real Postgres with the real policies applied, because RLS is enforced
 * by the database and a test that stubs the database tests nothing.
 *
 * **Requires a running local Supabase** (`pnpm db:start`). When the database is
 * unreachable these tests FAIL rather than skip — a skipped authorization test is
 * indistinguishable from a passing one in a summary, and this is the single most
 * security-critical suite in the project (threat T1).
 *
 * ## Every query reports its error
 *
 * An earlier version of this file asserted on `data` while ignoring `error`. When
 * something upstream broke, seven assertions failed with "expected null to have
 * length 0" — which says nothing about *why*. PostgREST returns `data: null`
 * whenever `error` is set, so an unchecked error always surfaces as a confusing
 * null rather than as its own cause.
 *
 * Every call now goes through `expectOk` or `expectDenied`, which surface the
 * PostgREST `code`, `message`, `details`, and `hint`. A broken policy, a missing
 * grant, and an absent row now produce three different, named failures.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * Clients are typed with the generated `Database` schema.
 *
 * Not decoration: an untyped client returns `any` from every query, so a mistyped
 * column name would slip through and the assertions below would check nothing.
 */
type TypedClient = SupabaseClient<Database>;

/**
 * The shape every PostgREST call returns.
 *
 * Generic over the whole response rather than over `data`: supabase-js models a
 * response as a union of a success branch and an error branch, and inferring a
 * type parameter across that union collapses it to `never`. Inferring the
 * response and then projecting `["data"]` keeps the row type intact.
 */
interface QueryResult {
  data: unknown;
  error: PostgrestError | null;
}

/** Renders a PostgREST error with everything needed to diagnose it. */
function describeError(error: PostgrestError): string {
  const parts = [`code=${error.code ?? "?"}`, `message=${error.message}`];
  if (error.details) parts.push(`details=${error.details}`);
  if (error.hint) parts.push(`hint=${error.hint}`);
  return parts.join(" | ");
}

/**
 * Asserts the query succeeded and returns its data.
 *
 * Failing here names the PostgREST error rather than letting a null `data` reach
 * a length assertion three lines later.
 */
function expectOk<R extends QueryResult>(result: R, context: string): NonNullable<R["data"]> {
  if (result.error) {
    throw new Error(
      `${context}: expected success but PostgREST returned ${describeError(result.error)}`,
    );
  }
  if (result.data === null) {
    // `maybeSingle()` returns null data with no error when the row is absent.
    // Reporting it here names the missing row rather than letting `null` reach
    // an assertion that then complains about a property access.
    throw new Error(`${context}: query succeeded but no row was returned`);
  }
  // The null case is excluded above; the compiler cannot narrow through the
  // projected generic on its own.
  return result.data as NonNullable<R["data"]>;
}

/**
 * Asserts the query was refused by the database.
 *
 * Used where authorization must *error* rather than silently affect no rows —
 * an insert that violates `with check`, or an operation with no grant at all.
 */
function expectDenied(result: QueryResult, context: string): PostgrestError {
  if (!result.error) {
    throw new Error(
      `${context}: expected the database to refuse this operation, but it succeeded. ` +
        `This is an authorization failure, not a test failure.`,
    );
  }
  return result.error;
}

interface TestUser {
  id: string;
  email: string;
  client: TypedClient;
}

let admin: TypedClient;
let alice: TestUser;
let bob: TestUser;

/**
 * Creates a confirmed user, signs in as them, and verifies the profile trigger
 * fired.
 *
 * The trigger check lives here on purpose. If `handle_new_user` is missing or
 * failing, that is ONE fault — but without this check it surfaces as a scatter of
 * unrelated-looking assertion failures across every describe block below.
 */
async function createUser(label: string): Promise<TestUser> {
  const email = `atl015-${label}-${Date.now()}@example.test`;
  const password = `Fixture-${label}-${Date.now()}`;

  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    throw new Error(
      `Could not create ${label}: ${created.error?.message ?? "no user returned"}. ` +
        `If this says "Database error creating new user", the handle_new_user trigger is raising.`,
    );
  }
  const id = created.data.user.id;

  const profile = await admin.from("profiles").select("id").eq("id", id);
  const rows = expectOk(profile, `profile lookup for ${label} after user creation`);
  if (rows.length !== 1) {
    throw new Error(
      `The auth.users trigger did not create a profile for ${label} (found ${rows.length} rows). ` +
        `Check that on_auth_user_created exists and that handle_new_user is SECURITY DEFINER ` +
        `with an owner privileged on public.profiles.`,
    );
  }

  const client = createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`Could not sign in ${label}: ${signIn.error.message}`);

  // A signed-in client whose JWT is not reaching PostgREST would make auth.uid()
  // null, and every "own row" assertion would fail as if RLS were misconfigured.
  const session = await client.auth.getSession();
  if (!session.data.session?.access_token) {
    throw new Error(
      `${label} signed in but the client holds no access token; auth.uid() would be null.`,
    );
  }

  return { id, email, client };
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "Two-user RLS tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. " +
        "Run `pnpm db:start` and load .env.local. These tests fail rather than skip: an " +
        "authorization suite that quietly does nothing is worse than none.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("profiles").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.profiles as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");
}, 60_000);

afterAll(async () => {
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("profile creation on first sign-in", () => {
  it("creates exactly one profile per user", async () => {
    const rows = expectOk(
      await admin.from("profiles").select("id").in("id", [alice.id, bob.id]),
      "admin lookup of both profiles",
    );
    expect(rows).toHaveLength(2);
  });

  it("applies sensible defaults", async () => {
    // `maybeSingle` rather than `single`: absence is a meaningful outcome here,
    // and `single` reports it as PGRST116 — an error that reads like a query
    // fault rather than a missing row.
    const row = expectOk(
      await admin.from("profiles").select("*").eq("id", alice.id).maybeSingle(),
      "admin lookup of alice's profile",
    );

    expect(row).toMatchObject({
      timezone: "UTC",
      locale: "en",
      demo_data_enabled: false,
      onboarding_completed_at: null,
      onboarding_state_json: {},
      selected_categories: [],
    });
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });
});

describe("select", () => {
  it("lets a user read their own profile", async () => {
    const rows = expectOk(
      await alice.client.from("profiles").select("*").eq("id", alice.id),
      "alice reading her own profile",
    );
    expect(rows).toHaveLength(1);
  });

  it("hides another user's profile", async () => {
    // RLS filters rather than errors, so the tell is an empty result. Asserting
    // no error first distinguishes "filtered" from "the query broke".
    const rows = expectOk(
      await alice.client.from("profiles").select("*").eq("id", bob.id),
      "alice reading bob's profile",
    );
    expect(rows).toHaveLength(0);
  });

  it("returns only the caller's row on an unfiltered select", async () => {
    const rows = expectOk(
      await alice.client.from("profiles").select("id"),
      "alice selecting all profiles",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(alice.id);
  });
});

describe("update", () => {
  it("lets a user update their own profile", async () => {
    // `.select()` on the update returns the affected rows, so the test proves
    // the write landed instead of inferring it from a later read.
    const updated = expectOk(
      await alice.client
        .from("profiles")
        .update({ display_name: "Alice" })
        .eq("id", alice.id)
        .select("id, display_name"),
      "alice updating her own profile",
    );

    expect(updated).toHaveLength(1);
    expect(updated[0]?.display_name).toBe("Alice");
  });

  it("cannot update another user's profile", async () => {
    const updated = expectOk(
      await alice.client
        .from("profiles")
        .update({ display_name: "Owned by Alice" })
        .eq("id", bob.id)
        .select("id"),
      "alice updating bob's profile",
    );

    // Zero affected rows is the denial: `using` filtered bob's row out entirely.
    expect(updated).toHaveLength(0);

    const bobRow = expectOk(
      await admin.from("profiles").select("display_name").eq("id", bob.id).maybeSingle(),
      "admin verifying bob's profile was untouched",
    );
    expect(bobRow.display_name).not.toBe("Owned by Alice");
  });

  it("cannot reassign a profile to another user", async () => {
    // `with check` is what stops this: `using` alone would permit updating a row
    // out of the caller's ownership.
    const denied = expectDenied(
      await alice.client.from("profiles").update({ id: bob.id }).eq("id", alice.id).select("id"),
      "alice reassigning her profile to bob",
    );
    expect(denied.code).toBeTruthy();
  });

  it("maintains updated_at on write", async () => {
    const before = expectOk(
      await admin.from("profiles").select("updated_at").eq("id", alice.id).maybeSingle(),
      "reading updated_at before the write",
    );

    // The trigger uses now(), which is transaction time; a same-millisecond
    // update would otherwise compare equal.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const updated = expectOk(
      await alice.client
        .from("profiles")
        .update({ locale: "en-GB" })
        .eq("id", alice.id)
        .select("id"),
      "alice updating her locale",
    );
    expect(updated).toHaveLength(1);

    const after = expectOk(
      await admin.from("profiles").select("updated_at").eq("id", alice.id).maybeSingle(),
      "reading updated_at after the write",
    );

    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });
});

describe("insert", () => {
  it("cannot insert a profile owned by another user", async () => {
    const denied = expectDenied(
      await alice.client.from("profiles").insert({ id: bob.id }).select("id"),
      "alice inserting a profile owned by bob",
    );
    expect(denied.code).toBeTruthy();
  });

  it("cannot insert a profile for an arbitrary identity", async () => {
    const denied = expectDenied(
      await alice.client
        .from("profiles")
        .insert({ id: "00000000-0000-4000-8000-000000000000" })
        .select("id"),
      "alice inserting a profile for an unrelated identity",
    );
    expect(denied.code).toBeTruthy();
  });
});

describe("delete", () => {
  /**
   * There is no DELETE policy and no DELETE grant, so PostgREST may either refuse
   * outright or report success having matched zero rows. Both are acceptable
   * denials; a removed row is not. The assertion is therefore on the row's
   * survival, with the outcome reported either way.
   */
  it("cannot delete its own profile", async () => {
    const attempt = await alice.client.from("profiles").delete().eq("id", alice.id).select("id");
    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);

    const rows = expectOk(
      await admin.from("profiles").select("id").eq("id", alice.id),
      "admin verifying alice's profile survived her delete attempt",
    );
    expect(rows).toHaveLength(1);
  });

  it("cannot delete another user's profile", async () => {
    const attempt = await alice.client.from("profiles").delete().eq("id", bob.id).select("id");
    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);

    const rows = expectOk(
      await admin.from("profiles").select("id").eq("id", bob.id),
      "admin verifying bob's profile survived alice's delete attempt",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("anonymous access", () => {
  it("is denied entirely", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const attempt = await anon.from("profiles").select("id");

    // An error (no grant) or an empty set (no policy) both deny. A leaked row
    // does not, and that is what this asserts against.
    if (attempt.error) {
      expect(attempt.error.code).toBeTruthy();
    } else {
      expect(attempt.data ?? []).toHaveLength(0);
    }
  });
});

describe("account deletion", () => {
  it("removes the profile when the auth user is deleted", async () => {
    const temporary = await createUser("cascade");

    const deleted = await admin.auth.admin.deleteUser(temporary.id);
    if (deleted.error) {
      throw new Error(
        `Deleting the auth user failed: ${deleted.error.message}. ` +
          `If this mentions a foreign key, the profiles cascade is missing.`,
      );
    }

    const rows = expectOk(
      await admin.from("profiles").select("id").eq("id", temporary.id),
      "admin lookup of the deleted user's profile",
    );
    expect(rows).toHaveLength(0);
  });
});
