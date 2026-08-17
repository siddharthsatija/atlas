import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-045 — authorization, append-only enforcement, and schema integrity for
 * `privacy_score_snapshots`, against a real database.
 *
 * Four things only Postgres can settle:
 *
 *  1. **Two-user RLS**, with the shape this table has: `authenticated` may read
 *     its own snapshots and write nothing at all. A user who could insert one
 *     could write their own score.
 *  2. **Append-only, enforced by privilege.** ADR-004 says snapshots are never
 *     recomputed. The migration withholds `update` from every role including
 *     `service_role`, and that is only provable here — the repository offers no
 *     update method, but a missing method is not a guarantee.
 *  3. **The database clock.** `recorded_at` defaults to `now()` and the
 *     application never sends one (ATL-113).
 *  4. **The check constraints**, which encode ADR-004's arithmetic and §7.6's
 *     shapes.
 *
 * Requires a running local Supabase (`pnpm db:start`). Fails rather than skips
 * when the database is absent — a skipped authorization test reads identically
 * to a passing one.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

type TypedClient = SupabaseClient<Database>;
type SnapshotInsert = Database["public"]["Tables"]["privacy_score_snapshots"]["Insert"];

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
let aliceSnapshotId: string;

const PAST = new Date(Date.now() - 3_600_000).toISOString();

const base = (userId: string): SnapshotInsert => ({
  user_id: userId,
  score: 56,
  score_version: "score-v1",
  reason: "asset.updated",
  factor_breakdown_json: { factors: [], coverage: 100 },
});

async function createUser(label: string): Promise<TestUser> {
  const email = `atl045-${label}-${Date.now()}@example.test`;
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

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-045 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const reachable = await admin.from("privacy_score_snapshots").select("id").limit(1);
  if (reachable.error) {
    throw new Error(
      `Cannot query public.privacy_score_snapshots as service_role at ${SUPABASE_URL}: ` +
        `${describeError(reachable.error)}. Run \`pnpm db:start\` and \`pnpm db:reset\`.`,
    );
  }

  alice = await createUser("alice");
  bob = await createUser("bob");

  const row = expectOk(
    await admin.from("privacy_score_snapshots").insert(base(alice.id)).select("id").single(),
    "seeding alice's snapshot",
  );
  aliceSnapshotId = row.id;
});

afterAll(async () => {
  // Deleting the user cascades their snapshots away.
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("two-user isolation", () => {
  it("lets a user read their own snapshots", async () => {
    const rows = expectOk(
      await alice.client.from("privacy_score_snapshots").select("id"),
      "alice reading her own snapshots",
    );

    expect(rows.map((row) => row.id)).toContain(aliceSnapshotId);
  });

  it("hides another user's snapshots", async () => {
    expectNoAccess(
      await bob.client.from("privacy_score_snapshots").select("id").eq("id", aliceSnapshotId),
      "bob reading alice's snapshot",
    );
  });

  it("hides them from an anonymous caller entirely", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(
      await anon.from("privacy_score_snapshots").select("id"),
      "anonymous reading snapshots",
    );
  });
});

describe("snapshots are not user-authored", () => {
  it("refuses a client insert, even of the user's own row", async () => {
    /**
     * The score is derived from the user's records by a versioned model. A
     * client-authored snapshot would be a number the user chose, which is
     * exactly what ADR-004's integrity rule forbids.
     */
    expectRejected(
      await alice.client.from("privacy_score_snapshots").insert(base(alice.id)).select("id"),
      "alice inserting her own snapshot",
    );
  });

  it("refuses a client update of their own snapshot", async () => {
    const result = await alice.client
      .from("privacy_score_snapshots")
      .update({ score: 100 })
      .eq("id", aliceSnapshotId)
      .select("id");

    expectNoAccess(result, "alice raising her own score");

    const after = expectOk(
      await admin
        .from("privacy_score_snapshots")
        .select("score")
        .eq("id", aliceSnapshotId)
        .single(),
      "re-reading alice's snapshot",
    );
    expect(after.score).toBe(56);
  });

  it("refuses a client delete", async () => {
    const result = await alice.client
      .from("privacy_score_snapshots")
      .delete()
      .eq("id", aliceSnapshotId)
      .select("id");

    expectNoAccess(result, "alice deleting her own snapshot");

    const survivors = expectOk(
      await admin.from("privacy_score_snapshots").select("id").eq("id", aliceSnapshotId),
      "confirming the snapshot survived",
    );
    expect(survivors).toHaveLength(1);
  });
});

describe("append-only, enforced by privilege", () => {
  it("refuses an update even from service_role", async () => {
    /**
     * ADR-004: "historical snapshots are never recomputed." The `update`
     * privilege is withheld from every role, so a bug in server code cannot
     * rewrite a snapshot. The repository offering no update method is the
     * second gate, not the first — and a missing method is not a guarantee.
     */
    const result = await admin
      .from("privacy_score_snapshots")
      .update({ score: 99 })
      .eq("id", aliceSnapshotId)
      .select("id");

    expectRejected(result, "service_role updating a snapshot");

    const after = expectOk(
      await admin
        .from("privacy_score_snapshots")
        .select("score")
        .eq("id", aliceSnapshotId)
        .single(),
      "re-reading after the refused update",
    );
    expect(after.score).toBe(56);
  });

  it("still allows service_role to insert and delete, which the jobs need", async () => {
    // Compaction (§14) and the demo purge (ATL-083) both delete.
    const row = expectOk(
      await admin
        .from("privacy_score_snapshots")
        .insert({ ...base(alice.id), reason: "finding.changed" })
        .select("id")
        .single(),
      "service_role inserting a snapshot",
    );

    expectOk(
      await admin.from("privacy_score_snapshots").delete().eq("id", row.id).select("id").single(),
      "service_role deleting a snapshot",
    );
  });
});

describe("the database clock", () => {
  it("stamps recorded_at without the application supplying one", async () => {
    // ATL-113: the value and the not-future constraint judging it come from one
    // `now()` in one transaction.
    const row = expectOk(
      await admin
        .from("privacy_score_snapshots")
        .insert(base(alice.id))
        .select("recorded_at")
        .single(),
      "inserting without a timestamp",
    );

    expect(Number.isNaN(Date.parse(row.recorded_at))).toBe(false);
    expect(Date.parse(row.recorded_at)).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("refuses a snapshot dated in the future", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();

    const result = await admin
      .from("privacy_score_snapshots")
      .insert({ ...base(alice.id), recorded_at: tomorrow })
      .select("id");

    expect(expectRejected(result, "a future snapshot").code).toBe("23514");
  });

  it("allows backdating, which compaction fixtures depend on", async () => {
    expectOk(
      await admin
        .from("privacy_score_snapshots")
        .insert({ ...base(alice.id), recorded_at: PAST })
        .select("id")
        .single(),
      "a backdated snapshot",
    );
  });
});

describe("the constraints", () => {
  it.each([-1, 101])("refuses a score of %i", async (score) => {
    const result = await admin
      .from("privacy_score_snapshots")
      .insert({ ...base(alice.id), score })
      .select("id");

    expect(expectRejected(result, `a score of ${score}`).code).toBe("23514");
  });

  it.each([0, 100])("accepts a score of %i", async (score) => {
    expectOk(
      await admin
        .from("privacy_score_snapshots")
        .insert({ ...base(alice.id), score })
        .select("id")
        .single(),
      `a score of ${score}`,
    );
  });

  it("refuses a malformed score_version", async () => {
    const result = await admin
      .from("privacy_score_snapshots")
      .insert({ ...base(alice.id), score_version: "score v1!" })
      .select("id");

    expect(expectRejected(result, "a malformed version").code).toBe("23514");
  });

  it("accepts the dotted reasons the recalculation vocabulary uses", async () => {
    // Shape-checked rather than an `IN` list, so a new trigger at M8 is an
    // application change rather than a migration.
    for (const reason of ["asset.created", "asset.updated", "finding.changed"]) {
      expectOk(
        await admin
          .from("privacy_score_snapshots")
          .insert({ ...base(alice.id), reason })
          .select("id")
          .single(),
        `the ${reason} reason`,
      );
    }
  });

  it("refuses a malformed reason", async () => {
    const result = await admin
      .from("privacy_score_snapshots")
      .insert({ ...base(alice.id), reason: "Asset Updated" })
      .select("id");

    expect(expectRejected(result, "a malformed reason").code).toBe("23514");
  });

  it("refuses a breakdown that is not an object", async () => {
    /**
     * An array or a scalar would be unreadable to ATL-046 and would only be
     * discovered at render time.
     */
    const result = await admin
      .from("privacy_score_snapshots")
      .insert({ ...base(alice.id), factor_breakdown_json: [] })
      .select("id");

    expect(expectRejected(result, "an array breakdown").code).toBe("23514");
  });

  it("defaults is_demo to false rather than leaving it unknown", async () => {
    const row = expectOk(
      await admin.from("privacy_score_snapshots").insert(base(alice.id)).select("is_demo").single(),
      "a snapshot with no demo flag",
    );

    expect(row.is_demo).toBe(false);
  });
});

describe("account deletion", () => {
  it("removes a user's snapshots with the account", async () => {
    // ADR-006's retention exceptions cover audit evidence, not derived scores:
    // a score history describes records that no longer exist.
    const doomed = await createUser("doomed");
    expectOk(
      await admin.from("privacy_score_snapshots").insert(base(doomed.id)).select("id").single(),
      "seeding the doomed user's snapshot",
    );

    await admin.auth.admin.deleteUser(doomed.id);

    const survivors = expectOk(
      await admin.from("privacy_score_snapshots").select("id").eq("user_id", doomed.id),
      "looking for snapshots afterwards",
    );
    expect(survivors).toHaveLength(0);
  });
});
