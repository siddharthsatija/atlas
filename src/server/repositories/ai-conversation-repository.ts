import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { EncryptionService } from "@/server/crypto/encryption-service";

/**
 * Data access for `ai_conversations` and `ai_messages` (ATL-109, architecture §7.18).
 *
 * Owns exactly one thing beyond storage: the encryption round trip for
 * `ai_messages.content_encrypted`. The consent gate is **not** here — it belongs
 * to `AiHistoryService`, because a repository that decided whether it was allowed
 * to store something would put the permission check and the write in the same
 * place, and the check would be as easy to bypass as calling the other method.
 *
 * Used with the **service-role** client, which bypasses RLS, so ownership is
 * filtered explicitly in every query. The policies are the second gate, not this
 * layer's excuse to omit the first.
 */

export const AAD_TABLE = "ai_messages";
export const AAD_COLUMN = "content_encrypted";

/** §7.18's vocabulary. Mirrored by the migration's check constraint. */
export type ConversationContextType = "global" | "asset" | "finding" | "request";

/** §7.18: `role` is user or assistant. No system turn is ever stored. */
export type ConversationRole = "user" | "assistant";

/**
 * Where a conversation is anchored.
 *
 * `entityId` is null exactly when `contextType` is `global`, which the database
 * enforces via `ai_conversations_anchor_is_complete`.
 */
export interface ConversationAnchor {
  contextType: ConversationContextType;
  entityId: string | null;
}

export interface ConversationRecord {
  id: string;
  contextType: ConversationContextType;
  entityId: string | null;
  createdAt: string;
}

/** A stored turn, decrypted. */
export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
}

/** A turn on its way in. */
export interface ConversationTurn {
  role: ConversationRole;
  content: string;
}

export class AiConversationStoreError extends Error {
  constructor(operation: string) {
    super(`ai conversation store failed: ${operation}`);
    this.name = "AiConversationStoreError";
  }
}

export class AiConversationRepository {
  private readonly db: SupabaseClient<Database>;
  private readonly crypto: EncryptionService;

  constructor(db: SupabaseClient<Database>, crypto?: EncryptionService) {
    this.db = db;
    this.crypto = crypto ?? new EncryptionService(db);
  }

  /**
   * The conversation for this anchor, creating it if this is the first turn.
   *
   * The unique indexes make "one conversation per anchor" a database guarantee,
   * so two concurrent asks about the same finding cannot produce two
   * conversations. The loser of that race gets a unique violation, which is
   * handled by re-reading rather than by failing: the row it wanted now exists,
   * which is the outcome it asked for.
   */
  async findOrCreateConversation(userId: string, anchor: ConversationAnchor): Promise<string> {
    const existing = await this.findConversation(userId, anchor);
    if (existing) return existing.id;

    const id = randomUUID();
    const { error } = await this.db.from("ai_conversations").insert({
      id,
      user_id: userId,
      context_type: anchor.contextType,
      entity_id: anchor.entityId,
    });

    if (error) {
      /** 23505 = unique violation: a concurrent ask created it first. */
      if (error.code === "23505") {
        const raced = await this.findConversation(userId, anchor);
        if (raced) return raced.id;
      }
      throw new AiConversationStoreError("create conversation");
    }

    return id;
  }

  private async findConversation(
    userId: string,
    anchor: ConversationAnchor,
  ): Promise<ConversationRecord | null> {
    const query = this.db
      .from("ai_conversations")
      .select("id, context_type, entity_id, created_at")
      .eq("user_id", userId)
      .eq("context_type", anchor.contextType);

    const { data, error } =
      anchor.entityId === null
        ? await query.is("entity_id", null).maybeSingle()
        : await query.eq("entity_id", anchor.entityId).maybeSingle();

    if (error) throw new AiConversationStoreError("read conversation");
    return data ? toConversation(data) : null;
  }

  /**
   * Appends turns to a conversation, encrypting each one.
   *
   * The message id is generated here rather than by the column default, because
   * the AAD binds the ciphertext to `ai_messages.content_encrypted:<id>` and the
   * id therefore has to exist before the value is sealed. Generating it in the
   * application is what lets the encrypt and the insert be a single round trip —
   * the pattern `digital_assets.account_identifier_encrypted` established.
   *
   * ## One statement per turn, because a batch cannot be ordered
   *
   * This previously inserted every turn in a single statement. That produced a
   * transcript in **random order**, and the reason is worth stating exactly,
   * because the bug is invisible in the code:
   *
   *   * `created_at` defaults to `now()`, which is *transaction start time*, so
   *     every row in one statement receives a byte-identical timestamp — a tie
   *     at microsecond resolution, not merely a close call.
   *   * The tiebreak is `id`, and `randomUUID()` is a v4 UUID with no temporal
   *     component, so comparing ids is comparing random numbers.
   *
   * Measured on PostgreSQL 17: one statement ties on the microsecond 20 times in
   * 20 and returns the exchange reversed in 10 of 20 — a coin flip. Separate
   * statements tie 0 times in 20 and never reverse, because each turn is its own
   * transaction and a transaction that begins after the previous one commits
   * necessarily gets a later `now()`.
   *
   * Ordering is therefore a property of how the rows are written, and there is
   * no §7.18 column that could carry it instead. (An explicit turn ordinal would
   * be the textbook fix; it is not in the specification, so it is not added
   * here.)
   *
   * ## What this gives up, stated rather than engineered around
   *
   * A single statement was atomic; sequential writes are not. If the assistant
   * turn fails to store, the question remains on its own. That is a real
   * regression against the previous comment's claim, and it is accepted rather
   * than compensated for: undoing the earlier turn would need a DELETE grant on
   * `ai_messages` that the migration deliberately withholds, and widening a
   * privilege to tidy a rare failure path is a poor trade.
   *
   * The consequence is bounded. `AiHistoryService.append` runs after a validated
   * answer and never fails the request, so the person still receives their
   * answer; the residue is a transcript entry with no reply, and `clearAll`
   * still removes it. Correct ordering on every successful write is worth more
   * than tidiness on a failed one.
   */
  async appendMessages(
    userId: string,
    conversationId: string,
    turns: readonly ConversationTurn[],
  ): Promise<string[]> {
    if (turns.length === 0) return [];

    const written: string[] = [];

    for (const turn of turns) {
      const id = randomUUID();
      const contentEncrypted = await this.crypto.encrypt(userId, turn.content, {
        table: AAD_TABLE,
        column: AAD_COLUMN,
        recordId: id,
      });

      const { error } = await this.db.from("ai_messages").insert({
        id,
        user_id: userId,
        conversation_id: conversationId,
        role: turn.role,
        content_encrypted: contentEncrypted,
      });

      if (error) throw new AiConversationStoreError("append messages");

      written.push(id);
    }

    return written;
  }

  /** One conversation's turns, oldest first, decrypted. */
  async listMessages(userId: string, conversationId: string): Promise<ConversationMessage[]> {
    const { data, error } = await this.db
      .from("ai_messages")
      .select("id, role, content_encrypted, created_at")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });

    if (error) throw new AiConversationStoreError("list messages");

    return Promise.all(
      (data ?? []).map(async (row) => ({
        id: row.id,
        role: row.role as ConversationRole,
        content: await this.crypto.decrypt(userId, row.content_encrypted, {
          table: AAD_TABLE,
          column: AAD_COLUMN,
          recordId: row.id,
        }),
        createdAt: row.created_at,
      })),
    );
  }

  /** The user's conversations, newest first. Carries no message content. */
  async listConversations(userId: string): Promise<ConversationRecord[]> {
    const { data, error } = await this.db
      .from("ai_conversations")
      .select("id, context_type, entity_id, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) throw new AiConversationStoreError("list conversations");
    return (data ?? []).map(toConversation);
  }

  /**
   * Removes every conversation and message for one user.
   *
   * Messages go via `on delete cascade` rather than a second statement, so there
   * is no window in which conversations are gone and their turns are not.
   * Security §14 requires disabling history to hard-delete, and a partial delete
   * would leave content behind while the UI reported it removed.
   */
  async deleteAllForUser(userId: string): Promise<number> {
    const { data, error } = await this.db
      .from("ai_conversations")
      .delete()
      .eq("user_id", userId)
      .select("id");

    if (error) throw new AiConversationStoreError("delete conversations");
    return (data ?? []).length;
  }
}

interface ConversationRow {
  id: string;
  context_type: string;
  entity_id: string | null;
  created_at: string;
}

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    contextType: row.context_type as ConversationContextType,
    entityId: row.entity_id,
    createdAt: row.created_at,
  };
}
