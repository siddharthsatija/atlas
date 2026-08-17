import type { AiPurpose } from "../prompts/prompt";

/**
 * The per-purpose data-selection policy (ATL-049, AI behavior §5, security §10).
 *
 * This table is the answer to "what may this purpose see", and it is a table
 * rather than branching logic on purpose: a reviewer can check the whole policy
 * against AI behavior §5 without reading any control flow, and adding a purpose
 * without deciding its data policy becomes a compile error rather than an
 * omission.
 *
 * ## Caps bound retrieval, not the result
 *
 * `maxFindings` is a limit on **what is fetched**, not a slice applied
 * afterwards. The skill's rule is explicit: "Never 'fetch the user's records and
 * let the model pick'." Fetching everything and truncating would still have read
 * the whole set into memory, and the first careless refactor would send it.
 *
 * ## What is deliberately absent
 *
 * There is no `all` or `any` value, and no wildcard. A purpose that needs a
 * record kind not listed here needs a decision, not a default.
 */

/** The kinds of record any purpose may draw on. */
export type ContextRecordKind =
  | "finding"
  | "asset"
  | "asset_categories"
  | "asset_permissions"
  | "score_snapshot"
  | "score_factor_definition"
  | "approved_personal_fields";

export interface PurposePolicy {
  /** Exactly the record kinds this purpose may retrieve. */
  allows: readonly ContextRecordKind[];
  /**
   * Whether the request names a single entity the retrieval hangs off.
   *
   * `explain_finding` and `summarize_asset` do; `explain_score` and
   * `recommend_action` operate over the user's own aggregate; `product_question`
   * touches nothing.
   */
  requiresSubject: boolean;
  /** Hard cap on findings retrieved. Zero means findings are not allowed at all. */
  maxFindings: number;
  /** True when this purpose may include approved personal-field values. */
  allowsPersonalFields: boolean;
  /** True when the purpose reads no user records whatsoever. */
  readsNoUserRecords: boolean;
}

/**
 * B2 caps, chosen as the smallest that satisfy the ticket.
 *
 * `explain_finding` takes one finding plus its related asset and the score-factor
 * definitions that finding references — the §5 list exactly. `recommend_action`
 * is the only purpose with a numeric cap worth arguing about: ten open findings
 * is enough to recommend a next action and small enough that the context stays
 * within one screen of reasoning, which is what the recommendation is for.
 */
export const PURPOSE_POLICIES: Record<AiPurpose, PurposePolicy> = {
  explain_finding: {
    allows: ["finding", "asset", "score_factor_definition"],
    requiresSubject: true,
    maxFindings: 1,
    allowsPersonalFields: false,
    readsNoUserRecords: false,
  },
  summarize_asset: {
    allows: ["asset", "asset_categories", "asset_permissions"],
    requiresSubject: true,
    maxFindings: 0,
    allowsPersonalFields: false,
    readsNoUserRecords: false,
  },
  explain_score: {
    allows: ["score_snapshot", "score_factor_definition"],
    requiresSubject: false,
    maxFindings: 0,
    allowsPersonalFields: false,
    readsNoUserRecords: false,
  },
  recommend_action: {
    allows: ["finding"],
    requiresSubject: false,
    maxFindings: 10,
    allowsPersonalFields: false,
    readsNoUserRecords: false,
  },
  /**
   * The only purpose permitting personal-field values, and only those approved
   * **in the current flow** (ADR-002: storage is not permission).
   *
   * Storage now exists — ATL-105 created `user_personal_fields` — but retrieval
   * is still deferred, and the distinction is the point: ADR-002 makes approval
   * per-request, so a stored value becomes eligible only once the person ticks it
   * in the draft flow, which is ATL-058. Nothing in this layer reads the table,
   * and `draft_request` supplies no stored values today.
   *
   * ATL-049 already enforces the rule that will govern them, by intersecting
   * whatever keys the caller declares against what the model claims it used. The
   * enforcement is real; what it enforces against arrives with ATL-058.
   */
  draft_request: {
    allows: ["approved_personal_fields"],
    requiresSubject: false,
    maxFindings: 0,
    allowsPersonalFields: true,
    readsNoUserRecords: false,
  },
  /**
   * Curated product guidance only — no user records (§5).
   *
   * B3: no corpus exists, so this purpose returns deterministic "not available"
   * guidance and never reaches a provider. Inventing product answers would be
   * the model stating facts about Atlas that nobody wrote down.
   */
  product_question: {
    allows: [],
    requiresSubject: false,
    maxFindings: 0,
    allowsPersonalFields: false,
    readsNoUserRecords: true,
  },
};

export function policyFor(purpose: AiPurpose): PurposePolicy {
  return PURPOSE_POLICIES[purpose];
}

/** True when the purpose permits this record kind. */
export function allowsRecordKind(purpose: AiPurpose, kind: ContextRecordKind): boolean {
  return PURPOSE_POLICIES[purpose].allows.includes(kind);
}
