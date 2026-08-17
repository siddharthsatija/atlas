import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";
import { REQUEST_STATUSES } from "@/lib/requests/requests";

/**
 * ATL-056 — authorization and schema integrity for `data_requests` and
 * `request_events`, against a real database.
 *
 * The claims only Postgres can settle:
 *
 *  1. **Two-user RLS.** A person reads their own requests and writes none. A
 *     client that could insert could create a request whose recipient, subject
 *     and body were unencrypted — the client has no access to the user's DEK, so
 *     a client write path could only produce a row that leaks (D1).
 *  2. **Cross-user foreign keys.** A request cannot point at another person's
 *     service, and an event cannot point at another person's request. Enforced
 *     by composite keys, not only by RLS.
 *  3. **The §13 status vocabulary** and the §7.7 type and delivery vocabularies.
 *  4. **`included_fields_json` is an array**, so the included-fields summary
 *     cannot be handed a scalar it will fail to render.
 *  5. **`request_events` is append-only by privilege** — no update or delete for
 *     any role.
 *  6. **Cascades** on asset deletion and on account deletion.
 *
 * The encryption round trip is asserted separately, in
 * `tests/integration/data-request-repository.test.ts`, because it needs the real
 * crypto service rather than direct SQL.
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
  assetId: string;
}

let admin: TypedClient;
let alice: TestUser;
let bob: TestUser;
let aliceRequestId: string;

async function createUser(label: string): Promise<TestUser> {
  const email = `atl056-${label}-${Date.now()}@example.test`;
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

  const asset = expectOk(
    await admin
      .from("digital_assets")
      .insert({
        user_id: created.data.user.id,
        service_name: `${label} Service`,
        category: "social",
      })
      .select("id")
      .single(),
    `seeding ${label}'s asset`,
  );

  return { id: created.data.user.id, client, assetId: asset.id };
}

/** Seeds directly, so RLS is tested without depending on the repository. */
async function seedRequest(user: TestUser, requestType = "deletion"): Promise<string> {
  const row = expectOk(
    await admin
      .from("data_requests")
      .insert({ user_id: user.id, asset_id: user.assetId, request_type: requestType })
      .select("id")
      .single(),
    `seeding a ${requestType} request`,
  );
  return row.id;
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-056 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  alice = await createUser("alice");
  bob = await createUser("bob");

  aliceRequestId = await seedRequest(alice);
});

afterAll(async () => {
  if (!admin) return;
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("data_requests · two-user isolation", () => {
  it("lets a person read their own requests", async () => {
    const result = await alice.client.from("data_requests").select("*").eq("user_id", alice.id);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("hides another person's requests completely", async () => {
    // Not "returns an error" — RLS filters, so the honest assertion is that no
    // row is reachable.
    expectNoAccess(await bob.client.from("data_requests").select("*"), "Bob reading every request");
  });

  it("hides a request even when its id is known", async () => {
    expectNoAccess(
      await bob.client.from("data_requests").select("*").eq("id", aliceRequestId),
      "Bob reading Alice's request by id",
    );
  });

  it("refuses anonymous reads", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(await anon.from("data_requests").select("*"), "anon reading requests");
  });
});

describe("data_requests · clients may not write (D1)", () => {
  it("refuses an insert, even for oneself", async () => {
    /**
     * The reason this is stricter than it looks: a request is heavily
     * user-edited, so a client insert policy would be defensible on the face of
     * it. But the client has no access to the user's DEK, so a client-written row
     * could only carry an unencrypted or absent recipient, subject and body —
     * which is not a request, it is a leak.
     */
    expectRejected(
      await alice.client
        .from("data_requests")
        .insert({ user_id: alice.id, asset_id: alice.assetId, request_type: "deletion" })
        .select("id"),
      "Alice inserting her own request",
    );
  });

  it("refuses an update by its owner", async () => {
    expectRejected(
      await alice.client
        .from("data_requests")
        .update({ external_reference: "CASE-1" })
        .eq("id", aliceRequestId)
        .select("id"),
      "Alice editing her own request",
    );
  });

  it("refuses a status change by its owner", async () => {
    /**
     * §13 requires transitions to be validated server-side, protected by
     * idempotency keys and recorded in two logs. A client update would skip all
     * three.
     */
    expectRejected(
      await alice.client
        .from("data_requests")
        .update({ status: "completed" })
        .eq("id", aliceRequestId)
        .select("id"),
      "Alice completing her own request directly",
    );
  });

  it("refuses a delete by its owner", async () => {
    expectRejected(
      await alice.client.from("data_requests").delete().eq("id", aliceRequestId).select("id"),
      "Alice deleting her own request",
    );
  });
});

describe("data_requests · cross-user protection", () => {
  it("refuses a request pointing at another person's service", async () => {
    /**
     * The composite foreign key, not RLS. A plain `references digital_assets
     * (id)` would satisfy referential integrity while letting Alice's request
     * name Bob's service — the failure ATL-028 introduced this pattern to
     * prevent.
     */
    expectRejected(
      await admin
        .from("data_requests")
        .insert({ user_id: alice.id, asset_id: bob.assetId, request_type: "deletion" })
        .select("id"),
      "a request pointing at another person's asset",
    );
  });

  it("removes the requests about a service when that service is deleted", async () => {
    const doomed = expectOk(
      await admin
        .from("digital_assets")
        .insert({ user_id: bob.id, service_name: "Doomed Service", category: "social" })
        .select("id")
        .single(),
      "seeding a service to delete",
    );

    expectOk(
      await admin
        .from("data_requests")
        .insert({ user_id: bob.id, asset_id: doomed.id, request_type: "correction" })
        .select("id")
        .single(),
      "seeding a request about it",
    );

    await admin.from("digital_assets").delete().eq("id", doomed.id);

    const remaining = await admin.from("data_requests").select("id").eq("asset_id", doomed.id);
    expect(remaining.data ?? []).toHaveLength(0);
  });
});

describe("data_requests · the §13 and §7.7 vocabularies", () => {
  it.each(REQUEST_STATUSES)("accepts the status %s", async (status) => {
    /**
     * Driven from the TypeScript union, so the two halves of the §7.2 split are
     * compared against each other: a status in the application that the check
     * constraint refuses would fail here.
     */
    const id = await seedRequest(bob);

    // `completed` must carry `completed_at` — see the pairing constraint below.
    const patch =
      status === "completed" ? { status, completed_at: new Date().toISOString() } : { status };

    expectOk(
      await admin.from("data_requests").update(patch).eq("id", id).select("id").single(),
      `setting status ${status}`,
    );
  });

  it("rejects a status outside the eight", async () => {
    expectRejected(
      await admin
        .from("data_requests")
        .update({ status: "archived" })
        .eq("id", aliceRequestId)
        .select("id"),
      "an unspecified status",
    );
  });

  it.each(["deletion", "correction"])("accepts the request type %s", async (requestType) => {
    const id = await seedRequest(bob, requestType);
    expect(id).toBeTruthy();
  });

  it("rejects a request type outside the two", async () => {
    expectRejected(
      await admin
        .from("data_requests")
        .insert({ user_id: bob.id, asset_id: bob.assetId, request_type: "erasure" })
        .select("id"),
      "an unspecified request type",
    );
  });

  it.each(["copy", "mailto", "manual"])("accepts the delivery method %s", async (method) => {
    const id = await seedRequest(bob);
    expectOk(
      await admin
        .from("data_requests")
        .update({ delivery_method: method })
        .eq("id", id)
        .select("id")
        .single(),
      `setting delivery method ${method}`,
    );
  });

  it("rejects a delivery method that would imply Atlas sent it", async () => {
    /**
     * Security §11 and frontend §9: Atlas drafts and never sends. The absence of
     * such a value from the constraint is what makes the promise structural.
     */
    expectRejected(
      await admin
        .from("data_requests")
        .update({ delivery_method: "atlas" })
        .eq("id", aliceRequestId)
        .select("id"),
      "a delivery method implying Atlas sent it",
    );
  });
});

describe("data_requests · included_fields_json holds keys only", () => {
  it("accepts an array of keys", async () => {
    const id = await seedRequest(bob);

    expectOk(
      await admin
        .from("data_requests")
        .update({ included_fields_json: ["email", "full_name"] })
        .eq("id", id)
        .select("id")
        .single(),
      "an array of field keys",
    );
  });

  it("defaults to an empty array, not null", async () => {
    const id = await seedRequest(bob);

    const row = expectOk(
      await admin.from("data_requests").select("included_fields_json").eq("id", id).single(),
      "reading the default",
    );

    expect(row.included_fields_json).toEqual([]);
  });

  it.each([
    ["an object", { email: "alex@example.com" }],
    ["a scalar", 42],
    ["a string", "email"],
  ])("rejects %s", async (_label, value) => {
    /**
     * Constrained to an array so the included-fields summary cannot be handed
     * something it will fail to render. The object case is the one that matters:
     * it is the shape a caller would produce if they started storing values
     * alongside keys, which ADR-002 forbids.
     */
    expectRejected(
      await admin
        .from("data_requests")
        .update({ included_fields_json: value })
        .eq("id", aliceRequestId)
        .select("id"),
      "a non-array included_fields_json",
    );
  });
});

describe("data_requests · lifecycle constraints", () => {
  it("requires completed_at on a completed request", async () => {
    /**
     * ADR-004 credits "+20 per completed request in the trailing 180 days",
     * which a completion with no timestamp cannot enter — the same arithmetic
     * `privacy_findings` encodes for `resolved_at`.
     */
    const id = await seedRequest(bob);

    expectRejected(
      await admin.from("data_requests").update({ status: "completed" }).eq("id", id).select("id"),
      "completing without a timestamp",
    );
  });

  it("refuses completed_at on a request that is not completed", async () => {
    const id = await seedRequest(bob);

    expectRejected(
      await admin
        .from("data_requests")
        .update({ completed_at: new Date().toISOString() })
        .eq("id", id)
        .select("id"),
      "a completion timestamp without the status",
    );
  });

  it("refuses a sent_at in the future", async () => {
    const id = await seedRequest(bob);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    expectRejected(
      await admin.from("data_requests").update({ sent_at: tomorrow }).eq("id", id).select("id"),
      "a future sent_at",
    );
  });

  it("leaves follow_up_at null by default (D7)", async () => {
    // ATL-066 owns the follow-up interval; this ticket stores the value.
    const id = await seedRequest(bob);

    const row = expectOk(
      await admin.from("data_requests").select("follow_up_at").eq("id", id).single(),
      "reading the follow-up default",
    );

    expect(row.follow_up_at).toBeNull();
  });

  it("caps the external reference (D10)", async () => {
    expectRejected(
      await admin
        .from("data_requests")
        .update({ external_reference: "x".repeat(121) })
        .eq("id", aliceRequestId)
        .select("id"),
      "an over-long external reference",
    );
  });

  it("maintains updated_at through the shared trigger (D6)", async () => {
    const id = await seedRequest(bob);

    const before = expectOk(
      await admin.from("data_requests").select("updated_at").eq("id", id).single(),
      "reading the initial timestamp",
    );

    const after = expectOk(
      await admin
        .from("data_requests")
        .update({ external_reference: "CASE-42" })
        .eq("id", id)
        .select("updated_at")
        .single(),
      "updating the request",
    );

    /**
     * ATL-113: "a timestamp maintained by callers is a timestamp that is wrong
     * eventually." The update supplies no `updated_at`, so a change can only
     * have come from the trigger.
     */
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });
});

describe("request_events · access and integrity", () => {
  it("lets a person read their own events", async () => {
    expectOk(
      await admin
        .from("request_events")
        .insert({
          user_id: alice.id,
          request_id: aliceRequestId,
          event_type: "created",
          summary: "Request drafted",
          actor_type: "user",
        })
        .select("id")
        .single(),
      "seeding an event",
    );

    const result = await alice.client
      .from("request_events")
      .select("*")
      .eq("request_id", aliceRequestId);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("hides another person's events", async () => {
    expectNoAccess(await bob.client.from("request_events").select("*"), "Bob reading every event");
  });

  it("refuses a client insert", async () => {
    expectRejected(
      await alice.client
        .from("request_events")
        .insert({
          user_id: alice.id,
          request_id: aliceRequestId,
          event_type: "completed",
          summary: "Request completed",
          actor_type: "user",
        })
        .select("id"),
      "Alice inserting her own event",
    );
  });

  it("is append-only: even service_role cannot update or delete", async () => {
    /**
     * Enforced by privilege, not by a missing repository method. An event that
     * could be edited is not a record of what happened, and a selectively
     * erasable timeline is a weaker record — including for the person who later
     * wants to know when something actually happened (ATL-068).
     */
    expectRejected(
      await admin
        .from("request_events")
        .update({ summary: "Rewritten" })
        .eq("request_id", aliceRequestId)
        .select("id"),
      "service_role editing an event",
    );

    expectRejected(
      await admin.from("request_events").delete().eq("request_id", aliceRequestId).select("id"),
      "service_role deleting an event",
    );
  });

  it.each(["user", "system"])("accepts the actor type %s", async (actorType) => {
    // §13's system transitions must be attributable to the system, so the
    // timeline can say "Atlas did this" rather than implying the person did.
    const id = await seedRequest(bob);

    expectOk(
      await admin
        .from("request_events")
        .insert({
          user_id: bob.id,
          request_id: id,
          event_type: "status_changed",
          summary: "Status changed",
          actor_type: actorType,
          from_status: "sent",
          to_status: "awaiting_response",
        })
        .select("id")
        .single(),
      `an event with actor ${actorType}`,
    );
  });

  it("rejects an actor type outside the two §7.8 names", async () => {
    expectRejected(
      await admin
        .from("request_events")
        .insert({
          user_id: alice.id,
          request_id: aliceRequestId,
          event_type: "status_changed",
          summary: "Status changed",
          actor_type: "operator",
        })
        .select("id"),
      "an operator actor",
    );
  });

  it.each([
    ["a from without a to", { from_status: "sent" }],
    ["a to without a from", { to_status: "completed" }],
  ])("rejects half a transition: %s", async (_label, statuses) => {
    // "Changed to sent" from an unrecorded state cannot be placed in a timeline.
    expectRejected(
      await admin
        .from("request_events")
        .insert({
          user_id: alice.id,
          request_id: aliceRequestId,
          event_type: "status_changed",
          summary: "Status changed",
          actor_type: "system",
          ...statuses,
        })
        .select("id"),
      "half a transition",
    );
  });

  it("refuses an event pointing at another person's request", async () => {
    expectRejected(
      await admin
        .from("request_events")
        .insert({
          user_id: bob.id,
          request_id: aliceRequestId,
          event_type: "created",
          summary: "Request drafted",
          actor_type: "user",
        })
        .select("id"),
      "an event on another person's request",
    );
  });

  it("rejects an event type that is not an identifier", async () => {
    expectRejected(
      await admin
        .from("request_events")
        .insert({
          user_id: alice.id,
          request_id: aliceRequestId,
          event_type: "Marked Sent!",
          summary: "Marked sent",
          actor_type: "user",
        })
        .select("id"),
      "a malformed event type",
    );
  });
});

describe("both tables are removed with the account", () => {
  it("cascades requests and their events on user deletion", async () => {
    const doomed = await createUser("doomed");
    const requestId = await seedRequest(doomed);

    expectOk(
      await admin
        .from("request_events")
        .insert({
          user_id: doomed.id,
          request_id: requestId,
          event_type: "created",
          summary: "Request drafted",
          actor_type: "user",
        })
        .select("id")
        .single(),
      "seeding the doomed user's event",
    );

    await admin.auth.admin.deleteUser(doomed.id);

    const requests = await admin.from("data_requests").select("id").eq("user_id", doomed.id);
    const events = await admin.from("request_events").select("id").eq("user_id", doomed.id);

    expect(requests.data ?? []).toHaveLength(0);
    expect(events.data ?? []).toHaveLength(0);
  });
});
