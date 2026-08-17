import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-107 — authorization and schema integrity for `notifications` and
 * `notification_preferences`, against a real database.
 *
 * The claims only Postgres can settle:
 *
 *  1. **Two-user RLS.** A person reads their own notifications and writes none.
 *     A client that could insert could forge a `security` notification — the one
 *     type nobody can switch off — or bypass the preference check and the
 *     redaction scan that make a notification safe to render (ADR-005: creation
 *     is server-side only).
 *  2. **The closed type vocabulary**, which mirrors the TypeScript union in
 *     `src/lib/notifications/notification-types.ts`.
 *  3. **A `security` preference row is unrepresentable.** This is the privacy
 *     guarantee behind "security notifications cannot be disabled" (FR-14,
 *     ADR-005). The service refuses first; this proves the database refuses too,
 *     so the guarantee does not depend on the service being the only writer.
 *  4. **One preference per (user, type)**, which is what makes "absence means the
 *     declared default" a well-defined rule (D1).
 *  5. **The paired entity constraint**, so a panel row cannot claim a link it
 *     cannot complete.
 *  6. **Cascade on account deletion** — ADR-005: "all are deleted with the
 *     account."
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
let aliceNotificationId: string;

async function createUser(label: string): Promise<TestUser> {
  const email = `atl107-${label}-${Date.now()}@example.test`;
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
async function seedNotification(userId: string, type: string): Promise<string> {
  const row = expectOk(
    await admin
      .from("notifications")
      .insert({ user_id: userId, type, title: "Seeded title", body: "Seeded body" })
      .select("id")
      .single(),
    `seeding ${type}`,
  );
  return row.id;
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-107 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  alice = await createUser("alice");
  bob = await createUser("bob");

  aliceNotificationId = await seedNotification(alice.id, "follow_up_due");
});

afterAll(async () => {
  if (!admin) return;
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("notifications · two-user isolation", () => {
  it("lets a person read their own notifications", async () => {
    const result = await alice.client.from("notifications").select("*").eq("user_id", alice.id);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("hides another person's notifications completely", async () => {
    // Not "returns an error" — RLS filters, so the honest assertion is that no
    // row is reachable.
    expectNoAccess(
      await bob.client.from("notifications").select("*"),
      "Bob reading every notification",
    );
  });

  it("hides a notification even when its id is known", async () => {
    expectNoAccess(
      await bob.client.from("notifications").select("*").eq("id", aliceNotificationId),
      "Bob reading Alice's notification by id",
    );
  });

  it("refuses anonymous reads", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(await anon.from("notifications").select("*"), "anon reading notifications");
  });
});

describe("notifications · clients may not write", () => {
  it("refuses an insert, even for oneself", async () => {
    /**
     * ADR-005 requires creation to be server-side only. This is the assertion
     * behind that sentence: a person who could insert could forge a `security`
     * notification, or write a body that never passed the redaction scan.
     */
    expectRejected(
      await alice.client
        .from("notifications")
        .insert({ user_id: alice.id, type: "security", title: "Forged", body: "Forged" })
        .select("id"),
      "Alice inserting her own notification",
    );
  });

  it("refuses to mark one read directly", async () => {
    /**
     * Marking your own notification read is harmless in itself, and a column-level
     * grant could have allowed it. It is refused because ATL-108's read-state
     * actions run server-side regardless, and a second write path with no caller
     * is a path nobody tests.
     */
    expectRejected(
      await alice.client
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", aliceNotificationId)
        .select("id"),
      "Alice marking her own notification read",
    );
  });

  it("refuses a delete", async () => {
    // Retention is the 90-day purge and the account cascade. Per-notification
    // deletion is not a behaviour any document describes.
    expectRejected(
      await alice.client.from("notifications").delete().eq("id", aliceNotificationId).select("id"),
      "Alice deleting her own notification",
    );
  });
});

describe("notifications · the ADR-005 vocabulary", () => {
  it.each(["follow_up_due", "request_status", "security", "finding_new", "system"])(
    "accepts the specified type %s",
    async (type) => {
      const id = await seedNotification(bob.id, type);
      expect(id).toBeTruthy();
    },
  );

  it("rejects a type outside the specified five", async () => {
    /**
     * The check constraint and the TypeScript union both exist: the constraint
     * stops an unrecognised value reaching storage, the union stops one being
     * written in the first place. An unknown type would render as a blank panel
     * row and would escape every preference check.
     */
    expectRejected(
      await admin
        .from("notifications")
        .insert({ user_id: bob.id, type: "marketing_blast", title: "Buy", body: "Now" })
        .select("id"),
      "unspecified notification type",
    );
  });

  it.each([
    ["an empty title", { title: "", body: "Body" }],
    ["an empty body", { title: "Title", body: "" }],
    ["an over-long title", { title: "x".repeat(121), body: "Body" }],
    ["an over-long body", { title: "Title", body: "x".repeat(401) }],
  ])("rejects %s", async (_label, content) => {
    // Backstops, exactly as on `activity_events.summary`. The templates are the
    // primary guarantee; these stop a future one producing something unrenderable.
    expectRejected(
      await admin
        .from("notifications")
        .insert({ user_id: bob.id, type: "system", ...content })
        .select("id"),
      "content outside the caps",
    );
  });
});

describe("notifications · the entity link is paired", () => {
  it("accepts both halves together", async () => {
    const row = expectOk(
      await admin
        .from("notifications")
        .insert({
          user_id: bob.id,
          type: "request_status",
          title: "Title",
          body: "Body",
          entity_type: "data_request",
          entity_id: aliceNotificationId,
        })
        .select("id")
        .single(),
      "a complete entity link",
    );
    expect(row.id).toBeTruthy();
  });

  it("accepts neither half", async () => {
    const id = await seedNotification(bob.id, "system");
    expect(id).toBeTruthy();
  });

  /**
   * Built lazily, and that is load-bearing.
   *
   * An `it.each` table is evaluated when the file is collected, **before**
   * `beforeAll` runs, so a case written as `{ entity_id: aliceNotificationId }`
   * captures `undefined`. supabase-js sends the insert as JSON and
   * `JSON.stringify` drops undefined-valued properties, so PostgREST would receive
   * a row with *neither* entity column — the legitimate "neither half" case. The
   * test would then report that the database accepted half a link when nothing of
   * the kind was ever sent.
   *
   * A thunk defers the read to run time, which is what the passing sibling test
   * above gets for free by building its payload inside the test function.
   */
  it.each([
    ["a type without an id", () => ({ entity_type: "data_request" })],
    ["an id without a type", () => ({ entity_id: aliceNotificationId })],
  ])("rejects %s", async (_label, link) => {
    const payload = link();

    /**
     * Asserts the fixture before asserting the database. Exactly one entity column
     * must be present and non-null; without this, a future edit that reintroduces
     * the collection-time capture makes this test pass while proving nothing.
     */
    const entityKeys = Object.entries(payload).filter(([, value]) => value !== undefined);
    expect(entityKeys).toHaveLength(1);

    // Half a link renders as a dead control in the panel.
    expectRejected(
      await admin
        .from("notifications")
        .insert({ user_id: bob.id, type: "system", title: "Title", body: "Body", ...payload })
        .select("id"),
      "half an entity link",
    );
  });

  it("rejects an entity type that is not an identifier", async () => {
    expectRejected(
      await admin
        .from("notifications")
        .insert({
          user_id: bob.id,
          type: "system",
          title: "Title",
          body: "Body",
          entity_type: "Data Request!",
          entity_id: aliceNotificationId,
        })
        .select("id"),
      "a malformed entity type",
    );
  });
});

describe("notification_preferences · two-user isolation", () => {
  it("lets a person read their own overrides", async () => {
    expectOk(
      await admin
        .from("notification_preferences")
        .insert({ user_id: alice.id, notification_type: "finding_new", enabled: false })
        .select("id")
        .single(),
      "seeding Alice's override",
    );

    const result = await alice.client
      .from("notification_preferences")
      .select("*")
      .eq("user_id", alice.id);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("hides another person's overrides completely", async () => {
    expectNoAccess(
      await bob.client.from("notification_preferences").select("*"),
      "Bob reading every preference",
    );
  });

  it("refuses a client insert", async () => {
    /**
     * Writes go through the service because it is the layer that knows `security`
     * is not configurable and can explain the refusal. One write path is easier to
     * reason about than two.
     */
    expectRejected(
      await alice.client
        .from("notification_preferences")
        .insert({ user_id: alice.id, notification_type: "system", enabled: false })
        .select("id"),
      "Alice inserting her own preference",
    );
  });

  it("refuses a client update", async () => {
    expectRejected(
      await alice.client
        .from("notification_preferences")
        .update({ enabled: true })
        .eq("user_id", alice.id)
        .select("id"),
      "Alice changing her own preference directly",
    );
  });
});

describe("notification_preferences · security cannot be configured", () => {
  it("refuses a security preference row outright", async () => {
    /**
     * The privacy guarantee, enforced by the schema rather than only by the
     * service. FR-14 and ADR-005: "security notifications cannot be disabled."
     * With configurability declared in code and this constraint in the database, a
     * row that would disable them cannot be written by any path — service bug,
     * migration, psql session, or a future ticket that forgot.
     */
    const error = expectRejected(
      await admin
        .from("notification_preferences")
        .insert({ user_id: bob.id, notification_type: "security", enabled: false })
        .select("id"),
      "a security preference",
    );

    /** Named, so the failure identifies which rule refused rather than "some 23514". */
    expect(error.message).toContain("notification_preferences_security_not_configurable");
  });

  it("refuses one that says security is enabled, too", async () => {
    /**
     * Even the harmless-looking direction is refused. A row saying `true` would
     * imply a control exists and merely happens to be on, and ATL-077 would then
     * have to decide whether to render it.
     */
    expectRejected(
      await admin
        .from("notification_preferences")
        .insert({ user_id: bob.id, notification_type: "security", enabled: true })
        .select("id"),
      "an enabled security preference",
    );
  });

  it("rejects a type outside the vocabulary as well", async () => {
    expectRejected(
      await admin
        .from("notification_preferences")
        .insert({ user_id: bob.id, notification_type: "marketing_blast", enabled: true })
        .select("id"),
      "an unknown preference type",
    );
  });
});

describe("notification_preferences · one row per (user, type)", () => {
  it("refuses a second row for the same pair", async () => {
    /**
     * What makes "absence of a row means the declared default" well defined. Two
     * rows would make the answer depend on which one a query read first.
     */
    expectOk(
      await admin
        .from("notification_preferences")
        .insert({ user_id: bob.id, notification_type: "system", enabled: false })
        .select("id")
        .single(),
      "the first override",
    );

    expectRejected(
      await admin
        .from("notification_preferences")
        .insert({ user_id: bob.id, notification_type: "system", enabled: true })
        .select("id"),
      "a duplicate override",
    );
  });

  it("lets two people hold an override for the same type", async () => {
    // The uniqueness is per pair, not per type.
    const row = expectOk(
      await admin
        .from("notification_preferences")
        .insert({ user_id: alice.id, notification_type: "system", enabled: false })
        .select("id")
        .single(),
      "Alice's own system override",
    );
    expect(row.id).toBeTruthy();
  });

  it("maintains updated_at through the shared trigger", async () => {
    const seeded = expectOk(
      await admin
        .from("notification_preferences")
        .insert({ user_id: bob.id, notification_type: "request_status", enabled: false })
        .select("id, created_at, updated_at")
        .single(),
      "seeding for the trigger",
    );

    const updated = expectOk(
      await admin
        .from("notification_preferences")
        .update({ enabled: true })
        .eq("id", seeded.id)
        .select("updated_at")
        .single(),
      "updating the override",
    );

    /**
     * ATL-113: "a timestamp maintained by callers is a timestamp that is wrong
     * eventually." The update above supplies no `updated_at`, so a change here can
     * only have come from the trigger.
     */
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(
      new Date(seeded.updated_at).getTime(),
    );
  });
});

describe("both tables are removed with the account", () => {
  it("cascades notifications and preferences on user deletion", async () => {
    /**
     * ADR-005: "all are deleted with the account." Asserted through a throwaway
     * user so the fixtures above stay intact.
     */
    const doomed = await createUser("doomed");
    await seedNotification(doomed.id, "system");
    expectOk(
      await admin
        .from("notification_preferences")
        .insert({ user_id: doomed.id, notification_type: "system", enabled: false })
        .select("id")
        .single(),
      "seeding the doomed user's override",
    );

    await admin.auth.admin.deleteUser(doomed.id);

    const notifications = await admin.from("notifications").select("id").eq("user_id", doomed.id);
    const preferences = await admin
      .from("notification_preferences")
      .select("id")
      .eq("user_id", doomed.id);

    expect(notifications.data ?? []).toHaveLength(0);
    expect(preferences.data ?? []).toHaveLength(0);
  });
});
