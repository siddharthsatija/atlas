import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * Task #95 — authorization, append-only-except-feedback, and schema integrity
 * for `ai_interactions`, against a real database.
 *
 * Four things only Postgres can settle:
 *
 *  1. **Two-user RLS.** `authenticated` may read its own interactions and write
 *     nothing. A user who could insert could fabricate a record of an
 *     interaction that never happened; one who could update could rewrite what
 *     the assistant was told.
 *  2. **Append-only except feedback**, enforced by trigger rather than by
 *     convention. `service_role` holds UPDATE because feedback needs it, so the
 *     narrowing has to be provable — a repository that offers no method is not a
 *     guarantee.
 *  3. **The database clock.** `created_at` defaults to `now()` and the
 *     application never sends one (ATL-113).
 *  4. **The check constraints**, which encode §7.11's shapes and the vocabulary
 *     split — SQL checks structure, the application owns the values.
 *
 * Requires a running local Supabase (`pnpm db:start`). Fails rather than skips
 * when the database is absent — a skipped authorization test reads identically
 * to a passing one.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

type TypedClient = SupabaseClient<Database>;
type InteractionInsert = Database["public"]["Tables"]["ai_interactions"]["Insert"];

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
let aliceInteractionId: string;

const FINDING_ID = "11111111-1111-1111-1111-111111111111";

const base = (userId: string): InteractionInsert => ({
  user_id: userId,
  purpose: "explain_finding",
  model: "claude-sonnet-5",
  prompt_version: 1,
  policy_version: 1,
  records_referenced: [FINDING_ID],
  output_schema_version: 1,
  status: "validated",
  latency_ms: 1200,
});

async function createUser(label: string): Promise<TestUser> {
  const email = `task95-${label}-${Date.now()}@example.test`;
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
      "Task #95 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  alice = await createUser("alice");
  bob = await createUser("bob");

  const inserted = expectOk(
    await admin.from("ai_interactions").insert(base(alice.id)).select("id").single(),
    "seeding Alice's interaction",
  );
  aliceInteractionId = inserted.id;
});

afterAll(async () => {
  if (!admin) return;
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("two-user isolation", () => {
  it("lets a user read their own interactions", async () => {
    const result = await alice.client.from("ai_interactions").select("*").eq("user_id", alice.id);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("hides another user's interactions completely", async () => {
    // Not "returns an error" — RLS filters, so the honest assertion is that no
    // row is reachable.
    expectNoAccess(
      await bob.client.from("ai_interactions").select("*").eq("user_id", alice.id),
      "Bob reading Alice's interactions",
    );
  });

  it("hides them from an unfiltered select too", async () => {
    const result = await bob.client.from("ai_interactions").select("*");
    const rows = result.data ?? [];

    expect(rows.every((row) => row.user_id === bob.id)).toBe(true);
  });

  it("refuses a client insert, even for the caller's own id", async () => {
    /**
     * The disclosure surface has to be trustworthy: a user who could insert
     * could claim an interaction that never happened.
     */
    expectRejected(
      await alice.client.from("ai_interactions").insert(base(alice.id)),
      "Alice inserting her own interaction",
    );
  });

  it("refuses a client insert impersonating another user", async () => {
    expectRejected(
      await bob.client.from("ai_interactions").insert(base(alice.id)),
      "Bob inserting as Alice",
    );
  });

  it("refuses a client update of feedback", async () => {
    // Feedback is written server-side (decision B5); no client UPDATE exists.
    expectNoAccess(
      await alice.client
        .from("ai_interactions")
        .update({ helpful: true })
        .eq("id", aliceInteractionId)
        .select("*"),
      "Alice updating her own feedback directly",
    );
  });

  it("refuses a client delete", async () => {
    expectNoAccess(
      await alice.client.from("ai_interactions").delete().eq("id", aliceInteractionId).select("*"),
      "Alice deleting her own interaction",
    );
  });
});

describe("append-only except feedback", () => {
  it("permits a feedback update through service_role", async () => {
    const updated = expectOk(
      await admin
        .from("ai_interactions")
        .update({ helpful: false, feedback_category: "too_vague" })
        .eq("id", aliceInteractionId)
        .select("*")
        .single(),
      "recording feedback",
    ) as { helpful: boolean; feedback_category: string };

    expect(updated.helpful).toBe(false);
    expect(updated.feedback_category).toBe("too_vague");
  });

  it("refuses an update to the recorded status", async () => {
    /**
     * The trigger, not the grant, is what makes this safe: `service_role` holds
     * UPDATE because feedback needs it, so without the trigger a bug could
     * rewrite the record of what happened.
     */
    const error = expectRejected(
      await admin
        .from("ai_interactions")
        .update({ status: "fallback" })
        .eq("id", aliceInteractionId),
      "rewriting status",
    );

    expect(describeError(error)).toMatch(/append-only/i);
  });

  it("refuses an update to records_referenced", async () => {
    // The disclosure claim about what the assistant saw.
    expectRejected(
      await admin
        .from("ai_interactions")
        .update({ records_referenced: [] })
        .eq("id", aliceInteractionId),
      "rewriting records_referenced",
    );
  });

  it("refuses an update to the version columns", async () => {
    expectRejected(
      await admin
        .from("ai_interactions")
        .update({ output_schema_version: 99 })
        .eq("id", aliceInteractionId),
      "rewriting output_schema_version",
    );
  });

  it("refuses an update to created_at", async () => {
    expectRejected(
      await admin
        .from("ai_interactions")
        .update({ created_at: new Date(0).toISOString() })
        .eq("id", aliceInteractionId),
      "backdating created_at",
    );
  });

  it("refuses a status change smuggled alongside a feedback change", async () => {
    // The case a naive "did feedback change?" check would let through.
    expectRejected(
      await admin
        .from("ai_interactions")
        .update({ helpful: true, status: "fallback" })
        .eq("id", aliceInteractionId),
      "changing feedback and status together",
    );
  });
});

describe("a surfaced interaction id is not a capability (task #109)", () => {
  /**
   * #109 hands the row's UUID to a caller so ATL-053 can attach feedback. These
   * assert that holding the id grants nothing on its own: `recordFeedback`
   * scopes by owner as well as by id, so the surfaced value is a reference, not
   * a key.
   */

  it("records feedback through a surfaced id", async () => {
    const updated = expectOk(
      await admin
        .from("ai_interactions")
        .update({ helpful: true, feedback_category: "missing_context" })
        .eq("id", aliceInteractionId)
        .eq("user_id", alice.id)
        .select("helpful, feedback_category")
        .single(),
      "recording feedback through the surfaced id",
    ) as { helpful: boolean; feedback_category: string };

    expect(updated.helpful).toBe(true);
    expect(updated.feedback_category).toBe("missing_context");
  });

  it("cannot be used by another user to mutate feedback", async () => {
    /**
     * The predicate that makes surfacing safe. `service_role` bypasses RLS, so
     * an owner-scoped query is the only thing standing between Bob's id and
     * Alice's row — and it must match nothing rather than error, keeping "not
     * yours" indistinguishable from "does not exist" (ATL-034).
     */
    const result = await admin
      .from("ai_interactions")
      .update({ helpful: false })
      .eq("id", aliceInteractionId)
      .eq("user_id", bob.id)
      .select("*");

    expect(result.error).toBeNull();
    expect(result.data ?? []).toHaveLength(0);
  });

  it("leaves the row untouched after a mismatched attempt", async () => {
    // Proving the previous test was a no-op, not a silent success.
    const row = expectOk(
      await admin
        .from("ai_interactions")
        .select("helpful, feedback_category")
        .eq("id", aliceInteractionId)
        .single(),
      "re-reading Alice's interaction",
    ) as { helpful: boolean; feedback_category: string };

    expect(row.helpful).toBe(true);
    expect(row.feedback_category).toBe("missing_context");
  });

  it("still refuses non-feedback metadata through a surfaced id", async () => {
    // Surfacing the id does not widen what the id can change.
    expectRejected(
      await admin
        .from("ai_interactions")
        .update({ status: "fallback" })
        .eq("id", aliceInteractionId)
        .eq("user_id", alice.id),
      "rewriting status through the surfaced id",
    );
  });
});

describe("schema integrity", () => {
  it("stamps created_at from the database clock", async () => {
    const before = new Date();
    const row = expectOk(
      await admin.from("ai_interactions").insert(base(bob.id)).select("created_at").single(),
      "inserting without created_at",
    );

    const stamped = new Date(row.created_at);
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
    expect(stamped.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("rejects a future created_at", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();

    expectRejected(
      await admin.from("ai_interactions").insert({ ...base(bob.id), created_at: future }),
      "inserting a future created_at",
    );
  });

  it("rejects a negative latency", async () => {
    expectRejected(
      await admin.from("ai_interactions").insert({ ...base(bob.id), latency_ms: -1 }),
      "negative latency",
    );
  });

  it("rejects a non-positive version", async () => {
    expectRejected(
      await admin.from("ai_interactions").insert({ ...base(bob.id), prompt_version: 0 }),
      "zero prompt_version",
    );
  });

  it("rejects a structurally invalid status", async () => {
    // Shape-checked in SQL; the vocabulary itself lives in the application.
    expectRejected(
      await admin.from("ai_interactions").insert({ ...base(bob.id), status: "Validated!" }),
      "malformed status",
    );
  });

  it("accepts any structurally valid status, leaving the vocabulary to code", async () => {
    /**
     * The deliberate split. A SQL enum here would make adding a status a forward
     * migration racing a deployed constant.
     */
    expectOk(
      await admin
        .from("ai_interactions")
        .insert({ ...base(bob.id), status: "consent_denied" })
        .select("id")
        .single(),
      "inserting a vocabulary status",
    );
  });

  it("rejects a records_referenced value that is not an array", async () => {
    expectRejected(
      await admin
        .from("ai_interactions")
        .insert({ ...base(bob.id), records_referenced: { id: FINDING_ID } }),
      "object records_referenced",
    );
  });

  it("defaults records_referenced to an empty array", async () => {
    const row = expectOk(
      await admin
        .from("ai_interactions")
        .insert({
          user_id: bob.id,
          purpose: "product_question",
          model: "claude-sonnet-5",
          prompt_version: 1,
          policy_version: 1,
          output_schema_version: 1,
          status: "validated",
          latency_ms: 10,
        })
        .select("records_referenced")
        .single(),
      "inserting without records_referenced",
    ) as { records_referenced: unknown };

    expect(row.records_referenced).toEqual([]);
  });

  it("leaves input_classification null, since nothing defines its vocabulary", async () => {
    const row = expectOk(
      await admin
        .from("ai_interactions")
        .insert(base(bob.id))
        .select("input_classification")
        .single(),
      "inserting without input_classification",
    );

    expect(row.input_classification).toBeNull();
  });

  it("removes rows when the owning user is deleted", async () => {
    /**
     * Retention is "retain while the account exists" (§14, decision B6), so the
     * cascade is the entire deletion story — there is no purge job and no
     * DELETE grant.
     */
    const doomed = await createUser("doomed");
    expectOk(
      await admin.from("ai_interactions").insert(base(doomed.id)).select("id").single(),
      "seeding the doomed user's interaction",
    );

    await admin.auth.admin.deleteUser(doomed.id);

    const remaining = await admin.from("ai_interactions").select("id").eq("user_id", doomed.id);
    expect(remaining.data ?? []).toHaveLength(0);
  });
});

describe("the table cannot hold content", () => {
  it("has no column capable of storing a prompt or completion", async () => {
    /**
     * §7.11 "metadata only" and security §7 "not raw prompt and response text",
     * asserted structurally. Reading the column list back from the database is
     * the only way to prove the *table* — not just the repository — has nowhere
     * to put content.
     */
    const row = expectOk(
      await admin.from("ai_interactions").select("*").eq("id", aliceInteractionId).single(),
      "reading the full row",
    ) as Record<string, unknown>;

    expect(Object.keys(row).sort()).toEqual(
      [
        "created_at",
        "feedback_category",
        "helpful",
        "id",
        "input_classification",
        "latency_ms",
        "model",
        "output_schema_version",
        "policy_version",
        "prompt_version",
        "purpose",
        "records_referenced",
        "status",
        "user_id",
      ].sort(),
    );
  });
});
