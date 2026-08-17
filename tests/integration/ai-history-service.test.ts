import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database.generated";
import { AiHistoryService } from "@/server/ai/history/ai-history-service";
import { ConsentService } from "@/server/consent/consent-service";
import { EncryptionService } from "@/server/crypto/encryption-service";
import { AAD_COLUMN, AAD_TABLE } from "@/server/repositories/ai-conversation-repository";

/**
 * ATL-109 — the consent gate, the encryption round trip, and disable-deletes,
 * end to end against a real database.
 *
 * Deliberately not a doubles suite. Three of the four acceptance criteria are
 * claims about what is *actually stored*: that nothing is stored without
 * consent, that what is stored is ciphertext, and that disabling removes it. A
 * fake store can be made to satisfy all three while the real one does not.
 *
 * The cryptography is real throughout — nothing here stubs `seal` or `open` — so
 * a broken envelope fails these tests too.
 *
 * Requires a running local Supabase (`pnpm db:start`) with `.env.local` loaded,
 * because the encryption service needs `ATLAS_KEK` and the consent writes need
 * `AUDIT_HMAC_KEY`.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

type TypedClient = SupabaseClient<Database>;

let admin: TypedClient;
let history: AiHistoryService;
let consent: ConsentService;
let crypto: EncryptionService;
let userId: string;

const FINDING_ID = "aaaa1111-1111-4111-8111-111111111111";
const OTHER_FINDING_ID = "bbbb2222-2222-4222-8222-222222222222";

const QUESTION = "Why does this permission matter for my account?";
const ANSWER = "Based on the information saved in Atlas, this service can read your contacts.";

const anchor = { contextType: "finding", entityId: FINDING_ID } as const;

const exchange = [
  { role: "user", content: QUESTION },
  { role: "assistant", content: ANSWER },
] as const;

async function createUser(label: string): Promise<string> {
  const email = `atl109-${label}-${Date.now()}@example.test`;
  const created = await admin.auth.admin.createUser({
    email,
    password: `Fixture-${label}-${Date.now()}`,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(`Could not create ${label}: ${created.error?.message ?? "no user returned"}`);
  }
  return created.data.user.id;
}

beforeAll(async () => {
  if (!SERVICE_ROLE_KEY) {
    throw new Error(
      "ATL-109 history tests require SUPABASE_SERVICE_ROLE_KEY, ATLAS_KEK and " +
        "AUDIT_HMAC_KEY. Run `pnpm db:start` and load .env.local.",
    );
  }

  admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  history = AiHistoryService.create(admin);
  consent = new ConsentService(admin);
  crypto = new EncryptionService(admin);

  userId = await createUser("history");
});

afterAll(async () => {
  if (admin && userId) await admin.auth.admin.deleteUser(userId);
});

describe("off by default", () => {
  it("reports history as disabled before any decision", async () => {
    expect(await history.isEnabled(userId)).toBe(false);
  });

  it("stores nothing when consent was never granted", async () => {
    const result = await history.append(userId, anchor, exchange);
    expect(result).toEqual({ stored: false, conversationId: null });
  });

  it("wrote no row at all", async () => {
    /**
     * The assertion that matters: "returned stored: false" and "wrote nothing"
     * are different claims, and only the second one is the acceptance criterion.
     */
    const conversations = await admin.from("ai_conversations").select("id").eq("user_id", userId);
    const messages = await admin.from("ai_messages").select("id").eq("user_id", userId);

    expect(conversations.data ?? []).toHaveLength(0);
    expect(messages.data ?? []).toHaveLength(0);
  });
});

describe("once consent is granted", () => {
  let conversationId: string;

  beforeAll(async () => {
    await consent.grant(userId, "ai_conversation_history");
    const result = await history.append(userId, anchor, exchange);
    if (!result.conversationId) throw new Error("append did not create a conversation");
    conversationId = result.conversationId;
  });

  it("reports history as enabled", async () => {
    expect(await history.isEnabled(userId)).toBe(true);
  });

  it("stores the exchange", async () => {
    const messages = await history.listMessages(userId, conversationId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("round-trips the content unchanged", async () => {
    const messages = await history.listMessages(userId, conversationId);
    expect(messages.map((message) => message.content)).toEqual([QUESTION, ANSWER]);
  });

  it("stores ciphertext, not the words", async () => {
    /**
     * The claim ADR-003 actually makes. Asserted against the column rather than
     * against the service, because the service is what would be wrong.
     */
    const stored = await admin
      .from("ai_messages")
      .select("content_encrypted")
      .eq("conversation_id", conversationId);

    expect(stored.error).toBeNull();
    expect(stored.data ?? []).toHaveLength(2);
    for (const row of stored.data ?? []) {
      expect(row.content_encrypted).not.toContain(QUESTION);
      expect(row.content_encrypted).not.toContain(ANSWER);
      expect(row.content_encrypted).not.toContain("contacts");
    }
  });

  it("binds each ciphertext to its own row", async () => {
    /**
     * ADR-003's AAD is `table.column:record_id`, and this is what that buys:
     * ciphertext lifted from one message cannot be decrypted as another, so a
     * database operator cannot swap turns between rows undetected.
     */
    const stored = await admin
      .from("ai_messages")
      .select("id, content_encrypted")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    const [first, second] = stored.data ?? [];
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    await expect(
      crypto.decrypt(userId, first!.content_encrypted, {
        table: AAD_TABLE,
        column: AAD_COLUMN,
        recordId: second!.id,
      }),
    ).rejects.toThrow();
  });

  it("appends to the same conversation for the same anchor", async () => {
    const again = await history.append(userId, anchor, [
      { role: "user", content: "And what should I do about it?" },
    ]);

    expect(again.conversationId).toBe(conversationId);

    const messages = await history.listMessages(userId, conversationId);
    expect(messages).toHaveLength(3);
  });

  it("opens a separate conversation for a different anchor", async () => {
    const other = await history.append(
      userId,
      { contextType: "finding", entityId: OTHER_FINDING_ID },
      [{ role: "user", content: "What about this one?" }],
    );

    expect(other.stored).toBe(true);
    expect(other.conversationId).not.toBe(conversationId);

    const conversations = await history.listConversations(userId);
    expect(conversations).toHaveLength(2);
  });
});

describe("disabling hard-deletes", () => {
  it("removes every conversation and message", async () => {
    const before = await history.listConversations(userId);
    expect(before.length).toBeGreaterThan(0);

    const result = await history.disable(userId);
    expect(result.deleted).toBe(before.length);

    const conversations = await admin.from("ai_conversations").select("id").eq("user_id", userId);
    const messages = await admin.from("ai_messages").select("id").eq("user_id", userId);

    expect(conversations.data ?? []).toHaveLength(0);
    expect(messages.data ?? []).toHaveLength(0);
  });

  it("revokes the consent as part of the same operation", async () => {
    expect(await history.isEnabled(userId)).toBe(false);
  });

  it("refuses to store again afterwards", async () => {
    const result = await history.append(userId, anchor, exchange);
    expect(result.stored).toBe(false);

    const messages = await admin.from("ai_messages").select("id").eq("user_id", userId);
    expect(messages.data ?? []).toHaveLength(0);
  });

  it("is idempotent", async () => {
    const result = await history.disable(userId);
    expect(result.deleted).toBe(0);
  });
});

describe("the destruction is audited", () => {
  it("records ai.history_cleared without any message content", async () => {
    /**
     * ADR-006 amendment: consent is a decision, deletion is an act, and only the
     * second one evidences that the obligation was discharged. The context
     * carries a count — a message id would point at destroyed content, and text
     * would defeat the deletion.
     */
    const events = await admin
      .from("audit_events")
      .select("event_type, context_json")
      .eq("event_type", "ai.history_cleared")
      .order("occurred_at", { ascending: false })
      .limit(5);

    expect(events.error).toBeNull();
    expect((events.data ?? []).length).toBeGreaterThan(0);

    const serialised = JSON.stringify(events.data);
    expect(serialised).not.toContain(QUESTION);
    expect(serialised).not.toContain(ANSWER);
    expect(serialised).not.toContain("contacts");
  });
});
