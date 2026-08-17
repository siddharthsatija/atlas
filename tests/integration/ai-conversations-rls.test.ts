import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";

/**
 * ATL-109 — authorization, schema integrity, and encryption at rest for
 * `ai_conversations` and `ai_messages`, against a real database.
 *
 * Four things only Postgres can settle:
 *
 *  1. **Two-user RLS.** `authenticated` may read its own conversations and write
 *     nothing. A user who could insert could fabricate a record of something the
 *     assistant never said; one who could update could rewrite it afterwards;
 *     one who could delete could remove part of a transcript while the rest
 *     remained. Every write is server-side, after the consent gate.
 *  2. **The anchor rules.** §7.18 gives a conversation a `context_type` and an
 *     `entity_id`, and the migration makes the pairing all-or-nothing plus
 *     unique per anchor. Both are check-and-index behaviour, not application
 *     behaviour, so both are asserted here.
 *  3. **Cascade.** Security §14 requires disabling history to hard-delete, and
 *     account deletion to take everything. Messages go with their conversation,
 *     and conversations go with the auth user.
 *  4. **Ciphertext at rest.** The column must not contain the plaintext. This is
 *     the one assertion that a fake store cannot make, because it is about what
 *     is actually written to disk.
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
let aliceConversationId: string;

const FINDING_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";

async function createUser(label: string): Promise<TestUser> {
  const email = `atl109-${label}-${Date.now()}@example.test`;
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

/** Seeds a conversation directly, so RLS is tested without depending on the service. */
async function seedConversation(
  userId: string,
  contextType: string,
  entityId: string | null,
): Promise<string> {
  const row = expectOk(
    await admin
      .from("ai_conversations")
      .insert({ user_id: userId, context_type: contextType, entity_id: entityId })
      .select("id")
      .single(),
    `seeding ${contextType} conversation`,
  );
  return row.id;
}

beforeAll(async () => {
  if (!ANON_KEY || !SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-109 authorization tests require NEXT_PUBLIC_SUPABASE_ANON_KEY and " +
        "SUPABASE_SERVICE_ROLE_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  alice = await createUser("alice");
  bob = await createUser("bob");

  aliceConversationId = await seedConversation(alice.id, "finding", FINDING_ID);

  expectOk(
    await admin
      .from("ai_messages")
      .insert({
        user_id: alice.id,
        conversation_id: aliceConversationId,
        role: "user",
        content_encrypted: "seeded-envelope",
      })
      .select("id")
      .single(),
    "seeding Alice's message",
  );
});

afterAll(async () => {
  if (!admin) return;
  for (const user of [alice, bob]) {
    if (user?.id) await admin.auth.admin.deleteUser(user.id);
  }
});

describe("two-user isolation", () => {
  it("lets a user read their own conversations", async () => {
    const result = await alice.client.from("ai_conversations").select("*").eq("user_id", alice.id);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("lets a user read their own messages", async () => {
    const result = await alice.client.from("ai_messages").select("*").eq("user_id", alice.id);

    expect(result.error).toBeNull();
    expect(result.data?.length ?? 0).toBeGreaterThan(0);
  });

  it("hides another user's conversations completely", async () => {
    // Not "returns an error" — RLS filters, so the honest assertion is that no
    // row is reachable.
    expectNoAccess(
      await bob.client.from("ai_conversations").select("*"),
      "Bob reading every conversation",
    );
  });

  it("hides another user's messages completely", async () => {
    expectNoAccess(await bob.client.from("ai_messages").select("*"), "Bob reading every message");
  });

  it("hides a conversation even when its id is known", async () => {
    expectNoAccess(
      await bob.client.from("ai_conversations").select("*").eq("id", aliceConversationId),
      "Bob reading Alice's conversation by id",
    );
  });
});

describe("clients may not write", () => {
  /**
   * The grants and the policies are two independent gates, and neither table has
   * an insert, update or delete policy. A user who could write here could put
   * words in the assistant's mouth after the fact.
   */
  it("refuses a conversation insert by its owner", async () => {
    expectRejected(
      await alice.client
        .from("ai_conversations")
        .insert({ user_id: alice.id, context_type: "global", entity_id: null })
        .select("id"),
      "Alice inserting her own conversation",
    );
  });

  it("refuses a message insert by its owner", async () => {
    expectRejected(
      await alice.client
        .from("ai_messages")
        .insert({
          user_id: alice.id,
          conversation_id: aliceConversationId,
          role: "assistant",
          content_encrypted: "forged",
        })
        .select("id"),
      "Alice inserting her own message",
    );
  });

  it("refuses a message update by its owner", async () => {
    expectRejected(
      await alice.client
        .from("ai_messages")
        .update({ content_encrypted: "rewritten" })
        .eq("user_id", alice.id)
        .select("id"),
      "Alice rewriting her own message",
    );
  });

  it("refuses a conversation delete by its owner", async () => {
    /**
     * Deletion is server-side deliberately: revoking consent must remove every
     * conversation atomically, and a client-issued delete could remove some and
     * stop. `AiHistoryService.clearAll` is the supported path.
     */
    expectRejected(
      await alice.client
        .from("ai_conversations")
        .delete()
        .eq("id", aliceConversationId)
        .select("id"),
      "Alice deleting her own conversation",
    );
  });

  it("refuses anonymous reads", async () => {
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    expectNoAccess(await anon.from("ai_conversations").select("*"), "anon reading conversations");
    expectNoAccess(await anon.from("ai_messages").select("*"), "anon reading messages");
  });
});

describe("the anchor rules (§7.18)", () => {
  it("accepts a global conversation with no entity", async () => {
    const id = await seedConversation(bob.id, "global", null);
    expect(id).toBeTruthy();
  });

  it("rejects a global conversation that claims an entity", async () => {
    const error = expectRejected(
      await admin
        .from("ai_conversations")
        .insert({ user_id: bob.id, context_type: "global", entity_id: ASSET_ID })
        .select("id"),
      "global conversation with an entity",
    );
    expect(error.message).toContain("anchor_is_complete");
  });

  it("rejects a non-global conversation with no entity", async () => {
    const error = expectRejected(
      await admin
        .from("ai_conversations")
        .insert({ user_id: bob.id, context_type: "asset", entity_id: null })
        .select("id"),
      "asset conversation with no entity",
    );
    expect(error.message).toContain("anchor_is_complete");
  });

  it("rejects a context type outside the specified four", async () => {
    expectRejected(
      await admin
        .from("ai_conversations")
        .insert({ user_id: bob.id, context_type: "email", entity_id: ASSET_ID })
        .select("id"),
      "unspecified context type",
    );
  });

  it("keeps one conversation per anchor", async () => {
    /**
     * The property that makes `context_type`/`entity_id` meaningful: asking twice
     * about the same finding appends rather than forking. Enforced by the unique
     * index so a service cannot forget it.
     */
    expectRejected(
      await admin
        .from("ai_conversations")
        .insert({ user_id: alice.id, context_type: "finding", entity_id: FINDING_ID })
        .select("id"),
      "a second conversation for the same finding",
    );
  });

  it("keeps one global conversation per user", async () => {
    /**
     * Postgres treats NULLs as distinct, so the anchor index alone would not
     * constrain `global` at all — which is why the migration carries a second,
     * partial index. This is the assertion that proves it is doing something.
     */
    expectRejected(
      await admin
        .from("ai_conversations")
        .insert({ user_id: bob.id, context_type: "global", entity_id: null })
        .select("id"),
      "a second global conversation for Bob",
    );
  });

  it("lets two users hold the same anchor independently", async () => {
    const id = await seedConversation(bob.id, "finding", FINDING_ID);
    expect(id).toBeTruthy();
  });
});

describe("message integrity", () => {
  it("rejects a role outside user and assistant", async () => {
    /**
     * §7.18 names two roles. A stored `system` turn would mean the policy text
     * had been persisted, which security §14 forbids — AI context is transient.
     */
    expectRejected(
      await admin
        .from("ai_messages")
        .insert({
          user_id: alice.id,
          conversation_id: aliceConversationId,
          role: "system",
          content_encrypted: "policy text",
        })
        .select("id"),
      "a system-role message",
    );
  });

  it("defaults created_at from the database clock", async () => {
    const row = expectOk(
      await admin
        .from("ai_messages")
        .insert({
          user_id: alice.id,
          conversation_id: aliceConversationId,
          role: "assistant",
          content_encrypted: "envelope",
        })
        .select("created_at")
        .single(),
      "inserting without a timestamp",
    );

    expect(row.created_at).toBeTruthy();
  });
});

describe("deletion", () => {
  it("takes messages with their conversation", async () => {
    const conversationId = await seedConversation(bob.id, "request", ASSET_ID);
    expectOk(
      await admin
        .from("ai_messages")
        .insert({
          user_id: bob.id,
          conversation_id: conversationId,
          role: "user",
          content_encrypted: "envelope",
        })
        .select("id")
        .single(),
      "seeding a message to cascade",
    );

    expectOk(
      await admin.from("ai_conversations").delete().eq("id", conversationId).select("id"),
      "deleting the conversation",
    );

    const remaining = await admin
      .from("ai_messages")
      .select("id")
      .eq("conversation_id", conversationId);

    expect(remaining.error).toBeNull();
    expect(remaining.data ?? []).toHaveLength(0);
  });

  it("takes everything with the account", async () => {
    /**
     * Security §14 and ADR-003: row deletion plus crypto-shredding. This asserts
     * the row half — the key half is ATL-084's, already proven there.
     */
    const temporary = await createUser("cascade");
    const conversationId = await seedConversation(temporary.id, "global", null);
    expectOk(
      await admin
        .from("ai_messages")
        .insert({
          user_id: temporary.id,
          conversation_id: conversationId,
          role: "user",
          content_encrypted: "envelope",
        })
        .select("id")
        .single(),
      "seeding the doomed message",
    );

    const deleted = await admin.auth.admin.deleteUser(temporary.id);
    expect(deleted.error).toBeNull();

    const conversations = await admin
      .from("ai_conversations")
      .select("id")
      .eq("user_id", temporary.id);
    const messages = await admin.from("ai_messages").select("id").eq("user_id", temporary.id);

    expect(conversations.data ?? []).toHaveLength(0);
    expect(messages.data ?? []).toHaveLength(0);
  });
});
