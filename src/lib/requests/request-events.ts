import type { RequestStatus } from "./requests";

/**
 * The `request_events` vocabulary and its summary templates (ATL-056, §7.8).
 *
 * §7.8 gives `request_events` a `summary` column. Every comparable surface in
 * this codebase refuses caller-supplied strings for exactly this kind of field:
 * `ActivityWriter` composes summaries from templates because "a summary is the
 * one user-visible free-text field in the product", and ATL-107 adopted the same
 * design for notification titles and bodies.
 *
 * The reason applies with more force here than anywhere else. A `request_events`
 * row is written at the precise moment the service holding the request has the
 * recipient address, the subject and the draft body in memory — three Restricted
 * values (security §3, §8). A free-text `summary` parameter would make "no
 * restricted value lands in this column" a rule every future caller has to
 * remember, and the failure would be invisible: an address in a request timeline
 * reads perfectly normally.
 *
 * So there is **no free-text parameter**, and no `summary` argument anywhere in
 * the write path. A caller supplies an event type and, at most, two statuses
 * drawn from a closed vocabulary; the template produces the sentence.
 *
 * ## Why the parameters are only statuses
 *
 * `ActivityParams` permits a service name and a pre-masked identifier because a
 * global timeline has to say *which* service an entry is about. A request event
 * does not: it is already anchored to one request, which is anchored to one
 * asset, so the surface rendering it (frontend §9's status timeline) knows the
 * service from the row it is displaying. Passing the name again would be a
 * second copy of a value the reader already has, and every additional parameter
 * is another thing that could carry something it should not.
 *
 * ## Scope
 *
 * ATL-056 defines this vocabulary; **ATL-057 writes the rows**. Nothing in this
 * ticket emits a request event, because emitting one is part of performing a
 * transition and that is ATL-057's to own.
 */

/** The two statuses a template may name. Both are closed vocabularies. */
export interface RequestEventParams {
  fromStatus?: RequestStatus;
  toStatus?: RequestStatus;
}

type Template = (params: RequestEventParams) => string;

/** Human wording for a stored status, for use inside a sentence. */
const STATUS_PHRASES: Record<RequestStatus, string> = {
  draft: "draft",
  ready: "ready to send",
  sent: "sent",
  awaiting_response: "awaiting a response",
  follow_up_due: "due a follow-up",
  completed: "completed",
  rejected: "rejected",
  canceled: "canceled",
};

const phrase = (status: RequestStatus | undefined, fallback: string): string =>
  status ? STATUS_PHRASES[status] : fallback;

/**
 * The vocabulary. Adding an entry here is the only way to add an event type.
 *
 * Written in the user's voice and in the past tense — the timeline says what
 * happened. Where Atlas did something on its own (`system` actor), the sentence
 * says so, because frontend §9 forbids any wording that implies Atlas sent a
 * request it did not send.
 */
export const REQUEST_EVENT_TEMPLATES = {
  /** The request record was created, in `draft`. */
  created: () => "Request drafted",
  /** The draft's subject or body changed while `draft` or `ready`. */
  draft_updated: () => "Draft updated",
  /** The person marked it ready to send. */
  marked_ready: () => "Marked ready to send",
  /**
   * The person sent it and told Atlas so. Atlas never sends (security §11), and
   * this sentence is deliberately about the person rather than the system.
   */
  marked_sent: () => "You marked this as sent",
  /** The person recorded what the service said back. */
  response_noted: () => "Response recorded",
  /** The person sent a follow-up; §13 records a new `sent_at`. */
  follow_up_sent: () => "You sent a follow-up",
  /** The service refused. */
  rejected: () => "The service rejected this request",
  /** The matter is closed, including by acknowledging a rejection. */
  completed: () => "Request completed",
  /** The person abandoned it. */
  canceled: () => "Request canceled",
  /**
   * A system-driven move (§13): `sent -> awaiting_response` after three days,
   * or `awaiting_response -> follow_up_due` when `follow_up_at` passes.
   *
   * The generic template, used when a transition has no more specific entry
   * above. Both statuses are optional so the sentence degrades to something true
   * rather than breaking.
   */
  status_changed: (p) =>
    p.fromStatus && p.toStatus
      ? `Status changed from ${phrase(p.fromStatus, "its previous state")} to ${phrase(p.toStatus, "a new state")}`
      : `Status changed to ${phrase(p.toStatus, "a new state")}`,
} as const satisfies Record<string, Template>;

export type RequestEventType = keyof typeof REQUEST_EVENT_TEMPLATES;

export const REQUEST_EVENT_TYPES = Object.keys(REQUEST_EVENT_TEMPLATES) as RequestEventType[];

const EVENT_TYPES: ReadonlySet<string> = new Set(REQUEST_EVENT_TYPES);

/**
 * Whether a string is a known event type.
 *
 * Unknown types are rejected rather than stored: an unrecognised value renders
 * as a blank row in the request timeline, which is worse than a loud failure at
 * the call site that introduced it. The column carries a matching shape check —
 * both exist on purpose, as with every other vocabulary here.
 */
export function isRequestEventType(value: unknown): value is RequestEventType {
  return typeof value === "string" && EVENT_TYPES.has(value);
}

/** Builds the summary for one request event. */
export function buildRequestEventSummary(
  type: RequestEventType,
  params: RequestEventParams = {},
): string {
  return REQUEST_EVENT_TEMPLATES[type](params);
}
