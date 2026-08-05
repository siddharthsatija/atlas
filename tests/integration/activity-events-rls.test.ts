import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client as PgClient } from "pg";
import type { Database } from "@/types/database.generated";

/**
 * ATL-068 — authorization and index usage for `activity_events`.
 *
 * Two halves, both named by the ticket:
 *
 *  1. **Two-user RLS.** This table is user-facing, so the policy has a
 *     predicate — which means the predicate can be wrong. That makes the
 *     cross-user assertion the interesting one, unlike the deny-all internal
 *     tables from ATL-084/103/104.
 *  2. **Index usage on the timeline query.** An index that exists but is not
 *     used is indistinguishable from no index until the table is large, so the
 *     plan is asserted rather than assumed.
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

function expectNoAccess(result: QueryResult, context: string): void {
  if (result.error) return;
  const rows = Array.isArray(result.data) ? result.data : result.data === null ? [] : [result.data];
  if (rows.length > 0) {
    throw new Error(`${context}: activity rows were reachable. ${rows.length} row(s).`);
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
  const email = `atl068-${label}-${Date.now()}@example.test`;
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

async function seedEvent(
  userId: string,
  overrides: Partial<Database["public"]["Tables"]["activity_events"]["Insert"]> = {},
) {
  return expectOk(
    await admin
      .from("activity_events")
      .insert({
        user_id: userId,
        event_type: "asset.created",
        summary: "Added a service",
        metadata_redacted_json: { status: "active" },
        ...overrides,
      })
      .select("id, occurred_at")
      .single(),
    `seeding an activity event for ${userId}`,
  );
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-068 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("activity_events").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.activity_events as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");

  await seedEvent(alice.id);
  await seedEvent(bob.id);
}, 60_000);

afterAll(async () => {
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("owners read their own timeline", () => {
  it("returns the owner's events", async () => {
    const rows = expectOk(
      await alice.client.from("activity_events").select("*"),
      "alice reading her own timeline",
    ) as { user_id: string }[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.user_id === alice.id)).toBe(true);
  });
});

describe("two-user isolation", () => {
  it("does not return another user's events, even asked for by id", async () => {
    // The policy predicate is the only thing between these two timelines.
    expectNoAccess(
      await alice.client.from("activity_events").select("*").eq("user_id", bob.id),
      "alice reading bob's timeline",
    );
  });

  it("filters an unfiltered select to the owner", async () => {
    const rows = expectOk(
      await bob.client.from("activity_events").select("user_id"),
      "bob selecting all activity rows",
    ) as { user_id: string }[];

    expect(rows.every((r) => r.user_id === bob.id)).toBe(true);
  });
});

describe("clients cannot write the timeline", () => {
  it("cannot insert an event for themselves", async () => {
    // A client that could insert would be able to write a timeline entry
    // describing something that never happened.
    const attempt = await alice.client
      .from("activity_events")
      .insert({ user_id: alice.id, event_type: "asset.created", summary: "Forged" })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("cannot insert an event for another user", async () => {
    const attempt = await alice.client
      .from("activity_events")
      .insert({ user_id: bob.id, event_type: "asset.created", summary: "Forged" })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("cannot edit an event", async () => {
    const attempt = await alice.client
      .from("activity_events")
      .update({ summary: "Rewritten" })
      .eq("user_id", alice.id)
      .select("id");

    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);

    const rows = expectOk(
      await admin.from("activity_events").select("summary").eq("user_id", alice.id),
      "verifying alice's summary was untouched",
    ) as { summary: string }[];
    expect(rows.every((r) => r.summary !== "Rewritten")).toBe(true);
  });

  it("cannot delete an event", async () => {
    /**
     * The decision recorded in the migration: a selectively-erasable timeline is
     * a weaker record. Rows leave with the account, not one at a time.
     */
    const attempt = await alice.client
      .from("activity_events")
      .delete()
      .eq("user_id", alice.id)
      .select("id");

    if (!attempt.error) expect(attempt.data ?? []).toHaveLength(0);

    const rows = expectOk(
      await admin.from("activity_events").select("id").eq("user_id", alice.id),
      "verifying alice's events survived",
    ) as { id: string }[];
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("anonymous access", () => {
  it("is denied entirely", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(await anon.from("activity_events").select("*"), "anonymous reading activity");
  });
});

describe("constraints", () => {
  it("refuses a malformed event type", async () => {
    const attempt = await admin
      .from("activity_events")
      .insert({ user_id: alice.id, event_type: "Asset Created", summary: "x" })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("refuses an entity id with no entity type", async () => {
    // Half a reference cannot produce the entity link the timeline renders.
    const attempt = await admin
      .from("activity_events")
      .insert({
        user_id: alice.id,
        event_type: "asset.created",
        summary: "x",
        entity_id: "11111111-2222-3333-4444-555555555555",
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("refuses an entity type with no entity id", async () => {
    const attempt = await admin
      .from("activity_events")
      .insert({
        user_id: alice.id,
        event_type: "asset.created",
        summary: "x",
        entity_type: "asset",
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("accepts a complete entity reference", async () => {
    // `seedEvent` already asserts success, so reaching the next line is the
    // assertion; the returned id confirms a row was actually created.
    const seeded = await seedEvent(alice.id, {
      entity_type: "asset",
      entity_id: "11111111-2222-3333-4444-555555555555",
    });

    expect((seeded as { id: string }).id).toBeTruthy();
  });

  it("refuses an empty summary", async () => {
    const attempt = await admin
      .from("activity_events")
      .insert({ user_id: alice.id, event_type: "asset.created", summary: "" })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });

  it("refuses oversized metadata", async () => {
    const attempt = await admin
      .from("activity_events")
      .insert({
        user_id: alice.id,
        event_type: "asset.created",
        summary: "x",
        metadata_redacted_json: { padding: "x".repeat(4000) },
      })
      .select("id");

    expect(attempt.error).not.toBeNull();
  });
});

describe("index usage on the timeline query", () => {
  /**
   * The ticket asks for an "index usage check on the timeline query", and an
   * index that exists but is never chosen is indistinguishable from no index
   * until the table is large enough to hurt.
   *
   * Run over a direct Postgres connection rather than PostgREST, which cannot
   * execute `EXPLAIN`. The alternative — a `SECURITY DEFINER` function that runs
   * caller-supplied SQL — would put a permanent test-support function into the
   * production schema, and migrations are append-only.
   *
   * ## Why this seeds real volume, and why no planner setting is forced
   *
   * The first version of this block did the opposite: it asserted against the
   * handful of rows the RLS fixtures create, and set `enable_seqscan = off` to
   * stop Postgres preferring a sequential scan at that size.
   *
   * That was wrong, and it produced the failure it was meant to prevent.
   * `enable_seqscan = off` penalises sequential scans — **not bitmap scans**. So
   * the planner sidestepped into a Bitmap Index Scan, and a bitmap scan returns
   * rows in heap order rather than index order, which forces an explicit Sort.
   * The setting intended to prove the index was being used was the reason it was
   * not.
   *
   * Seeding representative volume and running `analyze` removes the need for any
   * planner override: with real statistics Postgres chooses the ordered index
   * scan on its own, which is the behaviour production will actually have. A
   * plan obtained under a forced setting proves nothing about production; this
   * one does.
   */
  let pg: PgClient | null = null;

  /**
   * Enough rows for the planner to make a realistic choice.
   *
   * Split across the two fixture users so `user_id` is genuinely selective —
   * a single-user table would make the predicate match everything and invite a
   * sequential scan for reasons that have nothing to do with the index.
   * Verified: the ordered index scan is chosen from 500 rows per user upward,
   * so this sits comfortably above the threshold rather than on it.
   */
  const SEED_PER_USER = 1000;

  beforeAll(async () => {
    const { Client } = await import("pg");
    pg = new Client({
      // The local Supabase Postgres (supabase/config.toml [db] port).
      connectionString:
        process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });
    await pg.connect();

    // Bulk-inserted over the direct connection: 2,000 rows through PostgREST
    // would dominate the suite's runtime for no added coverage.
    for (const userId of [alice.id, bob.id]) {
      await pg.query(
        `insert into public.activity_events
           (user_id, event_type, summary, occurred_at, entity_type, entity_id)
         select $1,
                (array['asset.created','asset.updated','finding.opened'])[1 + floor(random() * 3)],
                'Seeded timeline event',
                now() - (random() * interval '365 days'),
                'asset',
                gen_random_uuid()
         from generate_series(1, $2)`,
        [userId, SEED_PER_USER],
      );
    }

    // Without statistics the planner works from defaults, and its choice says
    // more about those defaults than about the schema.
    await pg.query("analyze public.activity_events");
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
  });

  async function planFor(query: string, params: unknown[]): Promise<string> {
    const result = await pg!.query(`explain ${query}`, params);
    return result.rows.map((row: Record<string, string>) => row["QUERY PLAN"]).join("\n");
  }

  it("uses the timeline index for the paginated query", async () => {
    // Exactly the ordering `ActivityEventRepository.timeline` issues.
    const plan = await planFor(
      `select * from public.activity_events
       where user_id = $1
       order by occurred_at desc, id desc
       limit 50`,
      [alice.id],
    );

    expect(plan).toContain("activity_events_timeline_idx");
  });

  it("uses the entity index for an entity lookup", async () => {
    const plan = await planFor(
      `select * from public.activity_events
       where user_id = $1 and entity_type = $2 and entity_id = $3`,
      [alice.id, "asset", "11111111-2222-3333-4444-555555555555"],
    );

    expect(plan).toContain("activity_events_entity_idx");
  });

  it("uses the type index when filtering by action", async () => {
    // Matches the repository's `eventType` option, tiebreak included.
    const plan = await planFor(
      `select * from public.activity_events
       where user_id = $1 and event_type = $2
       order by occurred_at desc, id desc
       limit 50`,
      [alice.id, "asset.created"],
    );

    expect(plan).toContain("activity_events_type_idx");
  });

  it("reads the next page through the timeline index", async () => {
    /**
     * The keyset path, which is the query ATL-070 will actually paginate with.
     * The predicate is the exact `or(...)` PostgREST emits for a cursor, so this
     * asserts the plan for what the repository sends rather than an idealised
     * version of it.
     */
    const anchor = await pg!.query(
      `select occurred_at, id from public.activity_events
       where user_id = $1 order by occurred_at desc, id desc offset 200 limit 1`,
      [alice.id],
    );
    const { occurred_at: occurredAt, id } = anchor.rows[0] as { occurred_at: Date; id: string };

    const plan = await planFor(
      `select * from public.activity_events
       where user_id = $1 and (occurred_at < $2 or (occurred_at = $2 and id < $3))
       order by occurred_at desc, id desc
       limit 50`,
      [alice.id, occurredAt, id],
    );

    expect(plan).toContain("activity_events_timeline_idx");
    expect(plan).not.toMatch(SORT_NODE);
  });

  /**
   * A plan containing an explicit `Sort` node means Postgres read rows and
   * ordered them itself. That is fine at ten rows and ruinous at a million, and
   * it is exactly what a mismatched index ordering — or a bitmap scan — causes.
   *
   * `Incremental Sort` counts: it is what appears when an index provides part of
   * the ordering but not the tiebreak, and it is how the missing `id` column on
   * the action-filter index showed up.
   */
  const SORT_NODE = /^\s*(->\s*)?(Incremental\s+)?Sort\b/m;

  it.each([
    ["the timeline query", `where user_id = $1`, [] as unknown[]],
    ["a filtered timeline", `where user_id = $1 and event_type = 'asset.created'`, []],
  ])("does not sort in memory for %s", async (_label, predicate) => {
    const plan = await planFor(
      `select * from public.activity_events
       ${predicate}
       order by occurred_at desc, id desc
       limit 50`,
      [alice.id],
    );

    expect(plan).not.toMatch(SORT_NODE);
  });
});

describe("account deletion", () => {
  it("cascades the timeline away with the auth user", async () => {
    // ADR-006: activity is the user's and is deleted with the account, unlike
    // audit events which survive as completion evidence.
    const temporary = await createUser("cascade");
    await seedEvent(temporary.id);

    const deleted = await admin.auth.admin.deleteUser(temporary.id);
    if (deleted.error) throw new Error(`Deleting the auth user failed: ${deleted.error.message}`);

    const rows = expectOk(
      await admin.from("activity_events").select("id").eq("user_id", temporary.id),
      "looking up the deleted user's activity",
    ) as { id: string }[];
    expect(rows).toHaveLength(0);
  });
});
