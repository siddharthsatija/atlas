/**
 * The data-request vocabularies and the §13 lifecycle, declared (ATL-056).
 *
 * A data request is the product's second half: findings and the score describe
 * what a service holds, and a request is how a person asks for it to be deleted
 * or corrected (PRD FR-08, §9.3). This module owns the words that describe one.
 *
 * ## What is here, and what is deliberately not
 *
 * ATL-056 owns the **vocabulary and the declarative transition table**. ATL-057
 * owns **execution**: validating a proposed move, idempotency, writing
 * `request_events`, and emitting audit and activity. That split is why
 * `isAllowedTransition` below answers a question and changes nothing — a
 * function here cannot perform a transition, because performing one requires a
 * database, an idempotency key and two event writers that this layer has no
 * access to by design.
 *
 * The table is data rather than a `switch`, so ATL-057's exhaustive matrix test
 * can enumerate every (from, to) pair and compare against §13 directly, and so a
 * future lifecycle change is a visible diff in one place.
 *
 * ## The application half of the §7.2 split
 *
 * `REQUEST_STATUSES`, `REQUEST_TYPES` and `DELIVERY_METHODS` are check-
 * constrained in SQL **and** listed here. That duplication is deliberate and the
 * same one `digital_assets.status` documents: the constraint stops an
 * unrecognised value reaching storage, and the union stops one being written in
 * the first place. These are closed state machines that ADR-004's score factors
 * and ADR-001's R-007 will read — a fifth status appearing would silently change
 * what those mean.
 */

/**
 * The eight statuses of architecture §13, PRD FR-08 and frontend §9.
 *
 * FR-08 writes them with spaces ("awaiting response"); these are the stored
 * identifiers, so they are snake_case and match the audit `reason` allowlist
 * pattern by construction.
 */
export const REQUEST_STATUSES = [
  /** Being prepared. Subject and body are editable. */
  "draft",
  /** Reviewed and ready to send. Still editable (frontend §9). */
  "ready",
  /** The person sent it themselves — Atlas never sends (security §11). */
  "sent",
  /** Sent, and now waiting. Entered by system job or by a response note (§13). */
  "awaiting_response",
  /** `follow_up_at` has passed and a nudge is due (ATL-066). */
  "follow_up_due",
  /** Terminal. The matter is closed, including by acknowledging a rejection. */
  "completed",
  /**
   * The service refused. **Nonterminal** (§13): `rejected -> completed` means
   * the person acknowledges and closes the matter, and the any-nonterminal rule
   * permits `rejected -> canceled`.
   */
  "rejected",
  /** Terminal. The person abandoned the request. */
  "canceled",
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const STATUSES: ReadonlySet<string> = new Set(REQUEST_STATUSES);

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === "string" && STATUSES.has(value);
}

/**
 * The two request kinds (§7.7, FR-08).
 *
 * The table is named `data_requests` rather than `deletion_requests` precisely
 * because both exist, and §7.7 records that migrations are append-only "so the
 * name must be right from the first migration".
 */
export const REQUEST_TYPES = [
  /** Asking a service to erase what it holds. */
  "deletion",
  /** Asking a service to fix something it holds. */
  "correction",
] as const;

export type RequestType = (typeof REQUEST_TYPES)[number];

const TYPES: ReadonlySet<string> = new Set(REQUEST_TYPES);

export function isRequestType(value: unknown): value is RequestType {
  return typeof value === "string" && TYPES.has(value);
}

/**
 * How the person actually sent it (§7.7).
 *
 * Every value describes something **the user** did. Atlas drafts and never
 * sends (security §11, frontend §9: "No control may imply Atlas sent the request
 * unless it actually did"), so there is no `atlas` or `automatic` member — its
 * absence is what makes that promise structural rather than a rule to remember.
 */
export const DELIVERY_METHODS = [
  /** Copied to the clipboard and pasted somewhere Atlas cannot see (ATL-061). */
  "copy",
  /** Handed to the person's email client through a `mailto:` link (ATL-062). */
  "mailto",
  /** Sent some other way — a web form, a letter, a phone call. */
  "manual",
] as const;

export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

const METHODS: ReadonlySet<string> = new Set(DELIVERY_METHODS);

export function isDeliveryMethod(value: unknown): value is DeliveryMethod {
  return typeof value === "string" && METHODS.has(value);
}

/**
 * Terminal states. Nothing leaves them.
 *
 * `rejected` is **not** here, and §13 is explicit about why: a rejection is an
 * answer, not an ending. A person can acknowledge it and close the matter
 * (`rejected -> completed`) or abandon it (`rejected -> canceled`).
 */
export const TERMINAL_REQUEST_STATUSES: readonly RequestStatus[] = ["completed", "canceled"];

export function isTerminalStatus(status: RequestStatus): boolean {
  return TERMINAL_REQUEST_STATUSES.includes(status);
}

/**
 * Architecture §13's transition graph, transcribed.
 *
 * Read as: from this status, a request may move to any of these. **Every status
 * appears as a key**, including the terminal ones with an empty list, so a
 * caller iterating the table sees the whole state machine rather than inferring
 * absence.
 *
 * `canceled` is reachable from every nonterminal state — §13's "any nonterminal
 * state -> canceled" — so it is listed explicitly on each rather than applied as
 * a rule at validation time. Writing it out means the table *is* the
 * specification: ATL-057's exhaustive matrix can compare pairs against this
 * without also re-implementing an exception.
 */
export const ALLOWED_REQUEST_TRANSITIONS: Readonly<
  Record<RequestStatus, readonly RequestStatus[]>
> = {
  draft: ["ready", "canceled"],
  ready: ["sent", "canceled"],
  sent: ["awaiting_response", "completed", "rejected", "canceled"],
  awaiting_response: ["follow_up_due", "completed", "rejected", "canceled"],
  /** `follow_up_due -> sent` is a follow-up message; §13 records a new `sent_at`. */
  follow_up_due: ["sent", "completed", "rejected", "canceled"],
  /** Nonterminal: acknowledge and close, or abandon. */
  rejected: ["completed", "canceled"],
  completed: [],
  canceled: [],
};

/**
 * Whether §13 permits this move.
 *
 * A **question**, not an action. ATL-057 owns performing a transition — the
 * validation, the idempotency key, the `request_events` row, and the audit and
 * activity events — and none of that can happen here, which is the point: this
 * module has no database and no writers, so it cannot become a second, quieter
 * path to changing a request's state.
 *
 * A status equal to itself is **not** allowed. §13 lists no self-transition, and
 * treating one as a harmless no-op is how a double submission writes a second
 * event for something that did not happen twice — the reasoning ATL-039 already
 * applied to refusing an already-closed finding.
 */
export function isAllowedTransition(from: RequestStatus, to: RequestStatus): boolean {
  return ALLOWED_REQUEST_TRANSITIONS[from].includes(to);
}

/** Where a request can go from here. Empty for the two terminal states. */
export function allowedTransitionsFrom(from: RequestStatus): readonly RequestStatus[] {
  return ALLOWED_REQUEST_TRANSITIONS[from];
}

/**
 * Who caused an event (§7.8).
 *
 * Two values, not three: §7.8 specifies `user, system` and nothing in the MVP
 * acts as an operator on a request. ADR-006's audit log has its own wider
 * `actor_type` because operator elevation is an audited security event there;
 * copying that here would offer a value nothing can produce.
 */
export const REQUEST_ACTOR_TYPES = ["user", "system"] as const;

export type RequestActorType = (typeof REQUEST_ACTOR_TYPES)[number];

const ACTORS: ReadonlySet<string> = new Set(REQUEST_ACTOR_TYPES);

export function isRequestActorType(value: unknown): value is RequestActorType {
  return typeof value === "string" && ACTORS.has(value);
}

/**
 * How long an external reference may be (D10).
 *
 * A service's own case or ticket number — bounded metadata, not prose. Security
 * §3 does not classify it, so it is stored in plaintext under RLS with the rest
 * of the request's non-restricted fields, and the assumption is recorded in
 * architecture §7.7 rather than left implicit. The cap is what keeps "reference"
 * from becoming a second notes field; the value is kept out of logs regardless.
 */
export const EXTERNAL_REFERENCE_MAX_LENGTH = 120;
