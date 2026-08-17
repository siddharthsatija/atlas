/**
 * The `ai_interactions` vocabularies (task #95, architecture §7.11).
 *
 * In `lib/` rather than `server/` for the reason the response envelope is: the
 * disclosure surface (ATL-053, ATL-076) will render these values, and a
 * duplicated copy for the client is how a UI ends up branching on a status the
 * server stopped writing.
 *
 * ## Why these are code constants and not SQL enums
 *
 * The migration shape-checks each column and stops there. That is the split
 * `finding_type` and `score_version` already use: adding a status then becomes
 * an application change rather than a forward migration racing a deployed
 * constant. The shape check still rejects anything structurally wrong.
 */

/**
 * How an interaction ended.
 *
 * Spans all three layers deliberately: `provider_error` and `rate_limited` come
 * from ATL-048's gateway, `validated`, `fallback` and `unavailable` from
 * ATL-050's validation pipeline, and `consent_denied` from ATL-049's gate. One
 * row per interaction means one column has to describe every way it can end.
 *
 * **None of these is ever a provider message.** ATL-048's `AiGatewayError` has
 * no field capable of carrying provider prose, and architecture §10 requires
 * typed codes rather than raw provider text.
 */
export const AI_INTERACTION_STATUSES = [
  /** Output passed the schema and every invariant. */
  "validated",
  /** Validation failed; ATL-052's deterministic content was substituted. */
  "fallback",
  /** Validation failed and no fallback was available. */
  "unavailable",
  /** The provider call failed after the gateway's bounded retries. */
  "provider_error",
  /** Atlas's own per-user limit denied the call (ATL-048). */
  "rate_limited",
  /** `ai_processing` consent was absent or revoked (ATL-049). */
  "consent_denied",
] as const;

export type AiInteractionStatus = (typeof AI_INTERACTION_STATUSES)[number];

export function isAiInteractionStatus(value: string): value is AiInteractionStatus {
  return (AI_INTERACTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Feedback categories, from AI behavior §12.
 *
 * The specification's five options, snake-cased. `incorrect` here is feedback
 * about an AI *response* and is unrelated to the finding-correction path in
 * OQ-04 — same word, different subject.
 */
export const AI_FEEDBACK_CATEGORIES = [
  "incorrect",
  "too_vague",
  "too_alarming",
  "missing_context",
  "draft_quality",
] as const;

export type AiFeedbackCategory = (typeof AI_FEEDBACK_CATEGORIES)[number];

export function isAiFeedbackCategory(value: string): value is AiFeedbackCategory {
  return (AI_FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

/**
 * `input_classification`: the sensitivity of the context that was sent (ATL-049).
 *
 * §7.11 names the column and defines nothing about it — it appears exactly once
 * in the whole specification. Task #95 therefore left it null rather than guess.
 * ATL-049 is the layer that finally knows the answer, because it is the only
 * code that sees what actually entered the context block, and the reading chosen
 * is the one that is **not redundant** with a column already on the row:
 * `purpose` and demo state are recorded or derivable elsewhere, but how
 * sensitive the sent context was is recorded nowhere.
 *
 * Three tiers, deliberately coarse. A finer scale would invite per-record
 * judgement calls at the call site, which is the thing the policy layer exists
 * to remove.
 */
export const INPUT_CLASSIFICATIONS = [
  /** No user records were sent at all — product guidance only. */
  "none",
  /** Record metadata only: findings, assets, permissions, score factors. */
  "metadata",
  /** Personal-field values approved for this request were included (ADR-002). */
  "personal",
] as const;

export type InputClassification = (typeof INPUT_CLASSIFICATIONS)[number];

export function isInputClassification(value: string): value is InputClassification {
  return (INPUT_CLASSIFICATIONS as readonly string[]).includes(value);
}
