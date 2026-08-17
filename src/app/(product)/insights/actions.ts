"use server";

import { revalidatePath } from "next/cache";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { FindingService } from "@/server/findings/finding-service";
import { isResolutionAction } from "@/lib/findings/resolution-actions";
import { isDismissalReason } from "@/lib/findings/dismissal-reasons";
import { isAiFeedbackCategory } from "@/lib/ai/interaction-vocabulary";
import type { AiFeedbackState, AssistantState } from "@/lib/ai/explanation-view";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { createAiPolicyService } from "@/server/ai/composition";
import { presentExplanation } from "@/server/ai/presentation/explanation-presenter";
import { AiInteractionRepository } from "@/server/repositories/ai-interaction-repository";
import type { DismissFindingState, ResolveFindingState, RestoreFindingState } from "./form-state";

/**
 * Insights Server Actions (ATL-042, ATL-043, ATL-053).
 *
 * Five: resolve, dismiss, undo, and ATL-053's two — asking about a finding and
 * giving feedback on the answer.
 *
 * The user id comes from `requireVerifiedUser`, never from the form
 * (architecture §10), and `FindingService` re-checks ownership underneath —
 * a Server Action is an independently invocable POST, so being reachable only
 * from the drawer is not protection.
 *
 * The result is returned rather than discarded. ATL-112 established why: an
 * action that drops its service result renders a page that looks like nothing
 * happened, which for a resolution would leave the user believing a finding was
 * closed when it was not.
 */

/** Reads one field as text. A `File` is not a string and is treated as absent. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Resolves a finding, recording what the user did about it.
 *
 * ATL-042: "resolution requires selecting or confirming the action taken". The
 * action is validated here, at the boundary where it arrives untrusted, rather
 * than being sent to the database to fail a check constraint — the constraint
 * is the second gate, not the first.
 *
 * `resolved_by = 'user'`, the database-clock `resolved_at`, and the audit
 * event's post-commit policy all live in `FindingService`; nothing about them
 * is decided here.
 */
export async function resolveFindingAction(
  previous: ResolveFindingState,
  formData: FormData,
): Promise<ResolveFindingState> {
  const user = await requireVerifiedUser();
  const findingId = text(formData, "findingId");
  const action = text(formData, "action");
  const attempt = previous.attempt + 1;

  /**
   * The selection is preserved on every failure path below.
   *
   * A user who picked "I closed the account" and hit a store outage should not
   * have to remember and re-pick it — frontend §19: "preserve form input during
   * recoverable errors".
   */
  const selected = isResolutionAction(action) ? action : previous.action;

  if (!isResolutionAction(action)) {
    return { failure: "action_required", action: selected, attempt };
  }

  const result = await FindingService.create().resolveFinding(user.id, findingId, action);

  if (!result.ok) {
    return {
      failure:
        result.code === "NOT_FOUND"
          ? "not_found"
          : result.code === "INVALID_REQUEST"
            ? "already_closed"
            : "unavailable",
      action: selected,
      attempt,
    };
  }

  /**
   * Both views that read this finding.
   *
   * The list and the panel are the same route, so one path covers both — but a
   * resolved finding leaves the Recommended view and enters Resolved, so the
   * page must re-read rather than reuse its cached tree.
   */
  revalidatePath("/insights");

  return { failure: null, action: selected, attempt, resolved: true };
}

/**
 * Dismisses a finding: the user has seen it and does not intend to act.
 *
 * The reason is **optional** (frontend §5.4), which is the one structural
 * difference from resolve: an absent reason is a valid submission, not a
 * validation failure. An unrecognised one is dropped rather than rejected —
 * dismissal is the user's decision either way, and refusing it over a reason
 * they did not have to give would be the wrong thing to fail on.
 *
 * **This does not improve the score, and the UI says so.** ADR-004 keeps the
 * deduction until the underlying condition clears, and the OQ-04 amendment makes
 * that a rule: a dismissal never improves the score by itself.
 */
export async function dismissFindingAction(
  previous: DismissFindingState,
  formData: FormData,
): Promise<DismissFindingState> {
  const user = await requireVerifiedUser();
  const findingId = text(formData, "findingId");
  const submitted = text(formData, "reason");
  const attempt = previous.attempt + 1;

  /** Preserved across failures, exactly as the resolve action preserves its action. */
  const reason = isDismissalReason(submitted) ? submitted : null;

  const result = await FindingService.create().dismissFinding(
    user.id,
    findingId,
    reason ?? undefined,
  );

  if (!result.ok) {
    return {
      failure:
        result.code === "NOT_FOUND"
          ? "not_found"
          : result.code === "INVALID_REQUEST"
            ? "already_closed"
            : "unavailable",
      reason,
      attempt,
    };
  }

  revalidatePath("/insights");

  return { failure: null, reason, attempt, dismissed: true };
}

/**
 * Undoes a dismissal (ATL-043), returning the finding to the open views.
 *
 * Unbounded: there is no window to check here, because none exists. The service
 * refuses anything that is not currently dismissed — a resolved finding
 * included — so this action carries no lifecycle logic of its own.
 *
 * No reason is read. Undo is a single decision with nothing to qualify, and the
 * original dismissal's reason stays on the timeline where it was written.
 */
export async function restoreFindingAction(
  previous: RestoreFindingState,
  formData: FormData,
): Promise<RestoreFindingState> {
  const user = await requireVerifiedUser();
  const findingId = text(formData, "findingId");
  const attempt = previous.attempt + 1;

  const result = await FindingService.create().undismissFinding(user.id, findingId);

  if (!result.ok) {
    return {
      failure:
        result.code === "NOT_FOUND"
          ? "not_found"
          : result.code === "INVALID_REQUEST"
            ? "already_closed"
            : "unavailable",
      attempt,
    };
  }

  revalidatePath("/insights");

  return { failure: null, attempt, restored: true };
}

/**
 * Asks Atlas to explain one finding (ATL-053).
 *
 * ## The evidence is re-read here, not accepted from the caller
 *
 * The panel already has resolved evidence labels on screen, and passing them in
 * would save a read. It would also mean the citation labels attached to an answer
 * came from the client — so anything that reached this action could choose what
 * an explanation appears to cite. `getFindingDetail` re-resolves them under the
 * same ownership predicate instead. The extra read is the price of the labels
 * being the server's.
 *
 * A `NOT_FOUND` finding returns `not_found` without asking anything, which also
 * keeps the policy layer from being invoked for an id the caller does not own.
 *
 * ## No user message
 *
 * ATL-055 made `userMessage` optional precisely so this path can omit it: the
 * question is "explain this finding", which the prompt already states. Sending a
 * synthesised sentence would put words in the user's mouth and add untrusted text
 * to the context for no gain.
 *
 * ## Cancellation is not represented here
 *
 * Per the locked decision, Cancel is UI state only. There is no `AbortSignal` and
 * no gateway cancellation: this request may complete and record its interaction
 * normally after the user has dismissed it, and that is intended — the row
 * describes what Atlas actually did.
 */
export async function explainFindingAction(findingId: string): Promise<AssistantState> {
  const user = await requireVerifiedUser();

  const detail = await FindingService.create().getFindingDetail(user.id, findingId);

  if (!detail.ok) {
    return detail.code === "NOT_FOUND" ? { status: "not_found" } : { status: "unavailable" };
  }

  const result = await createAiPolicyService(createServiceRoleClient()).answer({
    /** From the session (architecture §10). Never from the caller's argument. */
    userId: user.id,
    purpose: "explain_finding",
    subjectId: findingId,
    userMessage: undefined,
  });

  return presentExplanation({ result, evidence: detail.data.evidenceRecords });
}

/**
 * Records whether an answer helped (AI behavior §12).
 *
 * Two values reach the database and no more: `helpful`, and an optional category
 * from the closed vocabulary. There is no free-text field, here or on the table —
 * a comment box is where a user's own account details end up in a column that was
 * never meant to hold them.
 *
 * An unrecognised category is dropped rather than rejected. The signal the user
 * actually gave is the thumb; refusing it over a malformed qualifier would
 * discard the part that matters.
 *
 * Ownership is an explicit predicate in the repository because this runs as
 * `service_role`, which bypasses RLS. A row belonging to someone else updates
 * nothing and returns `unavailable` — the same answer a storage failure gives, so
 * neither confirms that the id names a real interaction.
 */
export async function submitAiFeedbackAction(
  interactionId: string,
  helpful: boolean,
  category?: string,
): Promise<AiFeedbackState> {
  const user = await requireVerifiedUser();

  const validCategory =
    category !== undefined && isAiFeedbackCategory(category) ? category : undefined;

  try {
    const updated = await new AiInteractionRepository(createServiceRoleClient()).recordFeedback({
      interactionId,
      userId: user.id,
      helpful,
      category: validCategory,
    });

    return updated ? { status: "recorded" } : { status: "unavailable" };
  } catch {
    /**
     * Swallowed deliberately: feedback is a courtesy, and an outage here must not
     * take down the answer the user is reading. The repository already logs.
     */
    return { status: "unavailable" };
  }
}
