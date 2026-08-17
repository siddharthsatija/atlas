import type {
  ConversationAnchor,
  ConversationContextType,
  ConversationTurn,
} from "@/server/repositories/ai-conversation-repository";
import type { AiPurpose } from "../prompts/prompt";

/**
 * The seam the policy layer sees (ATL-109).
 *
 * A narrow interface rather than the concrete `AiHistoryService`, for the reason
 * `AiInteractionRecorder` is one: the policy layer must not import a module that
 * pulls in consent and audit writers at runtime, and a caller should not be able
 * to reach `disable()` through a dependency it was given for storage.
 *
 * The default is a no-op, so every existing construction of `AiPolicyService`
 * keeps working untouched and history is off unless it is wired in.
 */
export interface AiConversationHistory {
  append(
    userId: string,
    anchor: ConversationAnchor,
    turns: readonly ConversationTurn[],
  ): Promise<{ stored: boolean; conversationId: string | null }>;
}

export const noopConversationHistory: AiConversationHistory = {
  append: () => Promise.resolve({ stored: false, conversationId: null }),
};

/**
 * Where a purpose's conversation is anchored.
 *
 * §7.18 gives four context types. Three of them have a producer today:
 *
 *   - `finding` — `explain_finding`, whose subject is the finding.
 *   - `asset`   — `summarize_asset`, whose subject is the asset.
 *   - `global`  — the purposes that operate over the account rather than one
 *                 record (`explain_score`, `recommend_action`, `draft_request`).
 *
 * `request` has **no producer and is deliberately not mapped**. Request surfaces
 * are M8 (ATL-056 onward) and do not exist; mapping `draft_request` to it would
 * mean claiming an anchor to a `data_requests` row that cannot be created yet,
 * and the anchor constraint requires an `entity_id` this purpose has no way to
 * supply. The context type stays in the migration because §7.18 specifies it,
 * and the ticket that builds request drafting connects it.
 *
 * `product_question` never reaches here — it returns deterministic guidance
 * before any provider call, and reads no user records at all.
 */
export function anchorFor(purpose: AiPurpose, subjectId: string | undefined): ConversationAnchor {
  const contextType: ConversationContextType =
    purpose === "explain_finding" ? "finding" : purpose === "summarize_asset" ? "asset" : "global";

  if (contextType === "global") return { contextType, entityId: null };

  /**
   * Both subject-bearing purposes require a subject upstream — `policy-map`
   * marks them `requiresSubject`, and retrieval returns `not_found` without one,
   * so this branch cannot be reached with `undefined`. Falling back to `global`
   * rather than asserting keeps a future purpose from crashing a request over
   * where its transcript is filed.
   */
  return subjectId === undefined
    ? { contextType: "global", entityId: null }
    : { contextType, entityId: subjectId };
}
