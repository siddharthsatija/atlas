import type { ActivityEventType } from "@/lib/activity/activity-events";
import type { RequestEventType } from "./request-events";
import type { RequestStatus } from "./requests";

/**
 * What each §13 transition is called, in the two vocabularies that record it
 * (ATL-057).
 *
 * A transition is written to three logs and each has its own vocabulary:
 * `request_events` (ATL-056's templates), `activity_events` (ATL-069's), and
 * `audit_events`, which uses one type — `request.transitioned` — for every
 * transition because security §12 asks only that state changes be recorded.
 *
 * This maps the first two. It is a table rather than a `switch` for the same
 * reason `ALLOWED_REQUEST_TRANSITIONS` is: the mapping *is* the specification of
 * what a person sees, and a lookup can be enumerated by a test where a `switch`
 * can only be exercised case by case.
 *
 * ## No new vocabulary
 *
 * Both target types are closed unions that already exist. `ACTIVITY_TEMPLATES`
 * carries exactly four `request.*` entries, written before requests did — three
 * of them name a specific moment (`request.sent`, `request.completed`,
 * `request.created`) and `request.transitioned` covers the rest. Every transition
 * that has a specific type uses it; everything else falls back. Nothing here
 * invents an event type, in either vocabulary.
 *
 * `request.created` is absent below, deliberately: creation is not a transition —
 * a draft has no previous status — and ATL-058 owns emitting it.
 */

/** How one transition is recorded, in the two vocabularies that name it. */
export interface TransitionRecording {
  /** The request-scoped timeline entry (ATL-056). */
  requestEvent: RequestEventType;
  /** The global feed entry (ATL-069). */
  activity: ActivityEventType;
}

/**
 * Transitions with wording of their own.
 *
 * Keyed `from>to`. Only the moments where a specific sentence is truer than
 * "status changed" appear here; §13's remaining transitions fall back below.
 *
 * The keys are the §13 graph's edges, so this cannot name a move the lifecycle
 * does not allow — `ALLOWED_REQUEST_TRANSITIONS` is the gate, and a mapping for
 * an impossible edge would be unreachable code that looks meaningful.
 */
const SPECIFIC_RECORDINGS: Readonly<Partial<Record<string, TransitionRecording>>> = {
  /**
   * The person told Atlas they sent it. `request.sent` is the activity template
   * that says so — and says it about the person, because Atlas never sends
   * (security §11, frontend §9).
   */
  "ready>sent": { requestEvent: "marked_sent", activity: "request.sent" },
  /**
   * A follow-up went out. §13 records a new `sent_at`, and the timeline should
   * say a follow-up was sent rather than repeat "marked as sent" — but the
   * activity vocabulary has no follow-up entry and inventing one is out of scope,
   * so the global feed reuses `request.sent`.
   */
  "follow_up_due>sent": { requestEvent: "follow_up_sent", activity: "request.sent" },

  /** The service refused. Four §13 edges reach `rejected`; all read the same. */
  "sent>rejected": { requestEvent: "rejected", activity: "request.transitioned" },
  "awaiting_response>rejected": { requestEvent: "rejected", activity: "request.transitioned" },
  "follow_up_due>rejected": { requestEvent: "rejected", activity: "request.transitioned" },

  /** The matter is closed, including by acknowledging a rejection. */
  "sent>completed": { requestEvent: "completed", activity: "request.completed" },
  "awaiting_response>completed": { requestEvent: "completed", activity: "request.completed" },
  "follow_up_due>completed": { requestEvent: "completed", activity: "request.completed" },
  "rejected>completed": { requestEvent: "completed", activity: "request.completed" },

  /** Abandoned. Reachable from every nonterminal state (§13). */
  "draft>canceled": { requestEvent: "canceled", activity: "request.transitioned" },
  "ready>canceled": { requestEvent: "canceled", activity: "request.transitioned" },
  "sent>canceled": { requestEvent: "canceled", activity: "request.transitioned" },
  "awaiting_response>canceled": { requestEvent: "canceled", activity: "request.transitioned" },
  "follow_up_due>canceled": { requestEvent: "canceled", activity: "request.transitioned" },
  "rejected>canceled": { requestEvent: "canceled", activity: "request.transitioned" },

  /** The person finished preparing it. */
  "draft>ready": { requestEvent: "marked_ready", activity: "request.transitioned" },
};

/**
 * The fallback: a plain status change.
 *
 * Covers §13's two system transitions — `sent -> awaiting_response` and
 * `awaiting_response -> follow_up_due` — which have no specific wording because
 * nothing happened except time passing, and that is exactly what
 * `status_changed` says.
 */
const DEFAULT_RECORDING: TransitionRecording = {
  requestEvent: "status_changed",
  activity: "request.transitioned",
};

/** How this transition should be recorded in each of the two timelines. */
export function recordingFor(from: RequestStatus, to: RequestStatus): TransitionRecording {
  return SPECIFIC_RECORDINGS[`${from}>${to}`] ?? DEFAULT_RECORDING;
}
