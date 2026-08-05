import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Database } from "@/types/database.generated";

/**
 * ATL-103 — authorization and immutability for `audit_events` against a real
 * database.
 *
 * Two assertions matter more here than for a policied table:
 *
 *  1. **Nobody but the server can reach it.** An audit log a user can read tells
 *     them what was noticed; one they can write is not evidence of anything.
 *  2. **Nobody can change it, including the service role.** Append-only is the
 *     property the hash chain assumes; if UPDATE or DELETE succeeded, chain
 *     verification would be checking a record that could be rewritten
 *     wholesale.
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

const GENESIS = "0".repeat(64);

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
    throw new Error(
      `${context}: audit rows were readable by a client role. ${rows.length} row(s).`,
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
let aliceSubject: string;
let bobSubject: string;

/** A subject ref shaped like the writer's output; the value itself is opaque. */
function fakeSubjectRef(seed: string): string {
  return createHash("sha256").update(`atl103-${seed}-${Date.now()}`).digest("hex");
}

async function createUser(label: string): Promise<TestUser> {
  const email = `atl103-${label}-${Date.now()}@example.test`;
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

/** Seeds one event as the writer would, using service-role. */
async function seedEvent(subjectRef: string, prevHash = GENESIS, eventHash?: string) {
  const hash = eventHash ?? createHash("sha256").update(`${subjectRef}${prevHash}`).digest("hex");
  return expectOk(
    await admin
      .from("audit_events")
      .insert({
        event_type: "auth.signed_in",
        subject_ref: subjectRef,
        actor_type: "user",
        prev_hash: prevHash,
        event_hash: hash,
        context_json: { requestId: "req-1" },
      })
      .select("id, event_hash")
      .single(),
    `seeding an audit event for ${subjectRef.slice(0, 8)}`,
  );
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-103 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("audit_events").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.audit_events as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");
  aliceSubject = fakeSubjectRef("alice");
  bobSubject = fakeSubjectRef("bob");

  await seedEvent(aliceSubject);
  await seedEvent(bobSubject);
}, 60_000);

afterAll(async () => {
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("authenticated users have no access at all", () => {
  it("cannot read audit rows", async () => {
    expectNoAccess(
      await alice.client.from("audit_events").select("*"),
      "alice selecting all audit rows",
    );
  });

  it("cannot read rows for their own subject reference", async () => {
    // Even knowing the reference must not help — there is no grant at all.
    expectNoAccess(
      await alice.client.from("audit_events").select("*").eq("subject_ref", aliceSubject),
      "alice reading her own audit rows",
    );
  });

  it("cannot read another subject's rows", async () => {
    expectNoAccess(
      await alice.client.from("audit_events").select("*").eq("subject_ref", bobSubject),
      "alice reading bob's audit rows",
    );
  });

  it("cannot forge an audit event", async () => {
    // Writing a false record is as damaging as erasing a true one.
    const attempt = await bob.client
      .from("audit_events")
      .insert({
        event_type: "auth.signed_in",
        subject_ref: bobSubject,
        actor_type: "user",
        prev_hash: GENESIS,
        event_hash: "a".repeat(64),
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("cannot alter an audit event", async () => {
    const attempt = await alice.client
      .from("audit_events")
      .update({ event_type: "auth.signed_out" })
      .eq("subject_ref", aliceSubject)
      .select("id");

    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);
  });

  it("cannot delete an audit event", async () => {
    const attempt = await alice.client
      .from("audit_events")
      .delete()
      .eq("subject_ref", aliceSubject)
      .select("id");

    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);

    const rows = expectOk(
      await admin.from("audit_events").select("id").eq("subject_ref", aliceSubject),
      "verifying alice's audit rows survived",
    ) as { id: string }[];
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("anonymous access", () => {
  it("is denied entirely", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(await anon.from("audit_events").select("*"), "anonymous reading audit rows");
  });
});

describe("service_role is append-only", () => {
  it("can read and insert", async () => {
    const subject = fakeSubjectRef("append");
    await seedEvent(subject);

    const rows = expectOk(
      await admin.from("audit_events").select("id").eq("subject_ref", subject),
      "service_role reading its own insert",
    ) as { id: string }[];
    expect(rows).toHaveLength(1);
  });

  it("cannot update, even though it wrote the row", async () => {
    // The grant withholds UPDATE and a trigger rejects it — so this holds even
    // for a connection that somehow acquired the privilege.
    const subject = fakeSubjectRef("immutable-update");
    await seedEvent(subject);

    const attempt = await admin
      .from("audit_events")
      .update({ event_type: "auth.signed_out" })
      .eq("subject_ref", subject)
      .select("id");

    expect(attempt.error).not.toBeNull();

    const rows = expectOk(
      await admin.from("audit_events").select("event_type").eq("subject_ref", subject),
      "verifying the event type was untouched",
    ) as { event_type: string }[];
    expect(rows[0]?.event_type).toBe("auth.signed_in");
  });

  it("cannot delete", async () => {
    const subject = fakeSubjectRef("immutable-delete");
    await seedEvent(subject);

    const attempt = await admin
      .from("audit_events")
      .delete()
      .eq("subject_ref", subject)
      .select("id");

    expect(attempt.error).not.toBeNull();

    const rows = expectOk(
      await admin.from("audit_events").select("id").eq("subject_ref", subject),
      "verifying the row survived",
    ) as { id: string }[];
    expect(rows).toHaveLength(1);
  });
});

describe("chain integrity constraints", () => {
  it("refuses two events claiming the same predecessor", async () => {
    // The unique index that keeps the chain linear under concurrency.
    const subject = fakeSubjectRef("fork");
    const first = await seedEvent(subject);

    await seedEvent(subject, first.event_hash);

    const fork = await admin
      .from("audit_events")
      .insert({
        event_type: "auth.signed_out",
        subject_ref: subject,
        actor_type: "user",
        prev_hash: first.event_hash,
        event_hash: "b".repeat(64),
      })
      .select("id");

    expect(fork.error).not.toBeNull();
  });

  it("refuses a duplicate event hash", async () => {
    const subject = fakeSubjectRef("dup-hash");
    const first = await seedEvent(subject);

    const duplicate = await admin
      .from("audit_events")
      .insert({
        event_type: "auth.signed_out",
        subject_ref: fakeSubjectRef("dup-hash-other"),
        actor_type: "user",
        prev_hash: GENESIS,
        event_hash: first.event_hash,
      })
      .select("id");

    expect(duplicate.error).not.toBeNull();
  });

  it("refuses a malformed hash", async () => {
    const attempt = await admin
      .from("audit_events")
      .insert({
        event_type: "auth.signed_in",
        subject_ref: fakeSubjectRef("bad-hash"),
        actor_type: "user",
        prev_hash: GENESIS,
        event_hash: "not-a-sha256",
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("refuses an unknown actor type", async () => {
    const attempt = await admin
      .from("audit_events")
      .insert({
        event_type: "auth.signed_in",
        subject_ref: fakeSubjectRef("bad-actor"),
        actor_type: "robot",
        prev_hash: GENESIS,
        event_hash: "c".repeat(64),
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });
});

describe("lifecycle independence", () => {
  it("survives deletion of the auth user", async () => {
    /**
     * The property that disqualified `activity_events` from this role.
     *
     * Deletion-completion evidence has to outlive the account it describes, so
     * `audit_events` deliberately has no `user_id` and no foreign key. If a
     * cascade were ever added, this test fails.
     */
    const temporary = await createUser("cascade");
    const subject = fakeSubjectRef("cascade");
    await seedEvent(subject);

    const deleted = await admin.auth.admin.deleteUser(temporary.id);
    if (deleted.error) throw new Error(`Deleting the auth user failed: ${deleted.error.message}`);

    const rows = expectOk(
      await admin.from("audit_events").select("id").eq("subject_ref", subject),
      "reading audit rows after the auth user was deleted",
    ) as { id: string }[];
    expect(rows).toHaveLength(1);
  });
});
