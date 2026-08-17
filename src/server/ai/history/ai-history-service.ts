import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { ConsentService } from "@/server/consent/consent-service";
import { AuditWriter, emitEvent } from "@/server/audit/audit-writer";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import {
  AiConversationRepository,
  type ConversationAnchor,
  type ConversationMessage,
  type ConversationRecord,
  type ConversationTurn,
} from "@/server/repositories/ai-conversation-repository";

/**
 * AI conversation history (ATL-109, architecture §7.18, security §14).
 *
 * ## The consent gate lives here, and only here
 *
 * `ai_conversation_history` is off until the person grants it, and absence of a
 * positive record is not permission — `ConsentService.hasConsent` already fails
 * closed for "never decided", "revoked", and "decided against superseded terms".
 * This service is the single place that consults it before anything is written,
 * so there is no second path to storage that could forget.
 *
 * ## Storage is strictly additive to the request pipeline
 *
 * Nothing here participates in producing an answer. Retrieval, the policy layer,
 * the prompt, schema validation and the invariant checks all run exactly as they
 * did before ATL-109, and `append` is called afterwards with an answer that has
 * already been validated. A failure to store is therefore never allowed to fail
 * the request: the person asked a question and got a correct answer, and losing
 * the transcript is not a reason to withhold it.
 *
 * ## What is not stored
 *
 * No system policy text, no assembled context block, no retrieved record values.
 * §7.18 gives `ai_messages` a `role` of user or assistant and nothing else, and
 * the context block is transient by security §14 ("AI transient context:
 * discarded after request completion"). Storing the assembled prompt would
 * persist a redacted copy of the person's records under a second retention rule.
 */

export interface AppendResult {
  /** False when consent is absent. Not an error — it is the default state. */
  stored: boolean;
  conversationId: string | null;
}

export interface ClearResult {
  /** Conversations removed. Messages go with them by cascade. */
  deleted: number;
}

interface AiHistoryDependencies {
  consent: ConsentService;
  conversations: AiConversationRepository;
  audit: AuditWriter;
}

export class AiHistoryService {
  private readonly consent: ConsentService;
  private readonly conversations: AiConversationRepository;
  private readonly audit: AuditWriter;

  constructor(dependencies: AiHistoryDependencies) {
    this.consent = dependencies.consent;
    this.conversations = dependencies.conversations;
    this.audit = dependencies.audit;
  }

  /** Uses the service-role client: every write here is server-side by design. */
  static create(db: SupabaseClient<Database> = createServiceRoleClient()): AiHistoryService {
    return new AiHistoryService({
      consent: new ConsentService(db),
      conversations: new AiConversationRepository(db),
      audit: new AuditWriter(db),
    });
  }

  /** Whether this person has turned history on. Off by default. */
  async isEnabled(userId: string): Promise<boolean> {
    return this.consent.hasConsent(userId, "ai_conversation_history");
  }

  /**
   * Stores one exchange, if and only if history is enabled.
   *
   * Returns `stored: false` rather than throwing when consent is absent, because
   * that is the ordinary state of the majority of accounts and not an error
   * condition. A caller that treated it as one would log a failure on every
   * request made by every user who never opted in.
   */
  async append(
    userId: string,
    anchor: ConversationAnchor,
    turns: readonly ConversationTurn[],
  ): Promise<AppendResult> {
    if (turns.length === 0) return { stored: false, conversationId: null };
    if (!(await this.isEnabled(userId))) return { stored: false, conversationId: null };

    const conversationId = await this.conversations.findOrCreateConversation(userId, anchor);
    await this.conversations.appendMessages(userId, conversationId, turns);

    return { stored: true, conversationId };
  }

  /** The person's conversations, newest first. Carries no message content. */
  async listConversations(userId: string): Promise<ConversationRecord[]> {
    return this.conversations.listConversations(userId);
  }

  /** One conversation's turns, decrypted, oldest first. */
  async listMessages(userId: string, conversationId: string): Promise<ConversationMessage[]> {
    return this.conversations.listMessages(userId, conversationId);
  }

  /**
   * Turns history off and destroys everything already stored.
   *
   * Security §14: "disabling hard-deletes all conversations." One method rather
   * than two, because a caller that could revoke without deleting would leave
   * content behind that no surface would ever show again — retained, invisible,
   * and contrary to what the toggle said it did.
   *
   * ## Revoke first, then delete
   *
   * The ordering is chosen for which failure is survivable.
   *
   * Revoking first closes the window immediately: `append` consults the gate on
   * every call, so from that moment nothing new can be written, and a concurrent
   * request cannot slip a turn in between the delete and the revoke.
   *
   * If the delete then fails, the error propagates — the caller is told, nothing
   * is reported as removed, and because `clearAll` is unconditional a retry
   * completes it. The reverse order has no such recovery: a successful delete
   * followed by a failed revoke would leave history enabled and immediately
   * begin accumulating again, which is the state the person just asked to end.
   */
  async disable(userId: string): Promise<ClearResult> {
    await this.consent.revoke(userId, "ai_conversation_history");
    return this.clearAll(userId);
  }

  /**
   * Destroys stored history without touching the consent decision.
   *
   * Deliberately not consent-gated. Deletion is the safe direction, and a gate
   * here would mean a user whose consent record was somehow inconsistent could
   * not clear their own transcripts.
   */
  async clearAll(userId: string): Promise<ClearResult> {
    const deleted = await this.conversations.deleteAllForUser(userId);

    /**
     * Audited after the rows are gone, so the event describes a deletion that
     * happened rather than one that was attempted — the ordering
     * `ConsentService` uses, for the same reason.
     *
     * The context carries a count and nothing else. A message id would be a
     * pointer to destroyed content; message text would defeat the deletion.
     */
    await emitEvent(
      {
        audit: {
          userId,
          eventType: "ai.history_cleared",
          actorType: "user",
          entityType: "ai_history",
          context: { count: deleted },
        },
      },
      this.audit,
    );

    return { deleted };
  }
}
