import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import {
  buildRequestEventSummary,
  isRequestEventType,
  type RequestEventParams,
  type RequestEventType,
} from "@/lib/requests/request-events";
import type { RequestActorType, RequestStatus } from "@/lib/requests/requests";

/**
 * Data access for `request_events` (ATL-056, architecture §7.8).
 *
 * The request-scoped, user-facing timeline frontend §9 renders. Two other logs
 * record the same transitions for different readers, and the division is
 * deliberate: `activity_events` is the global feed (ATL-069), and `audit_events`
 * is the pseudonymous, hash-chained security record (ADR-006, security §12).
 *
 * ## The summary is composed here, never accepted
 *
 * `append` takes an event type and at most two statuses; the template produces
 * the sentence. There is **no free-text parameter**, which matters more on this
 * table than anywhere else: a row is written at the moment the caller holds the
 * recipient, the subject and the draft body — three Restricted values — so a
 * `summary` argument would make "no restricted value lands here" a rule every
 * future caller has to remember, and an address in a timeline reads perfectly
 * normally. `ActivityWriter` and `NotificationService` are built the same way.
 *
 * Unlike those two this composition lives in the repository rather than a
 * service above it, because ATL-056 creates no request service — ATL-057 owns
 * `RequestService`. Putting the templates here keeps the guarantee attached to
 * the only code that can write the column, rather than leaving the column
 * writable by whatever ATL-057 builds. If ATL-057 later adds a writer of its
 * own, this stays the single place the string is produced.
 *
 * ## Append-only, enforced by privilege
 *
 * The table grants `select, insert` to `service_role` and nothing else — no
 * update or delete for any role — so this repository exposes no method to change
 * or remove an event. A missing method is not a guarantee; the withheld
 * privilege is. Rows leave only by the cascade from their request or from
 * `auth.users`.
 */

export type RequestEventRow = Database["public"]["Tables"]["request_events"]["Row"];

export interface RequestEventRecord {
  id: string;
  userId: string;
  requestId: string;
  eventType: string;
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus | null;
  summary: string;
  actorType: RequestActorType;
  occurredAt: string;
}

export interface AppendRequestEventInput {
  userId: string;
  requestId: string;
  type: RequestEventType;
  /**
   * Both or neither, matching the table's paired constraint. A draft edit
   * changes no status and supplies neither.
   */
  params?: RequestEventParams;
  actorType: RequestActorType;
}

export class RequestEventStoreError extends Error {
  constructor(operation: string) {
    super(`request event store failed: ${operation}`);
    this.name = "RequestEventStoreError";
  }
}

/** Raised when an event type is not in the vocabulary. Fail closed. */
export class UnknownRequestEventTypeError extends Error {
  readonly eventType: string;

  constructor(eventType: string) {
    super("unknown request event type");
    this.name = "UnknownRequestEventTypeError";
    this.eventType = eventType;
  }
}

/** Raised when a transition names one end but not the other. */
export class IncompleteTransitionError extends Error {
  constructor() {
    super("a request transition must name both statuses or neither");
    this.name = "IncompleteTransitionError";
  }
}

const COLUMNS =
  "id, user_id, request_id, event_type, from_status, to_status, summary, actor_type, occurred_at";

export class RequestEventRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Records one event on a request's timeline.
   *
   * ATL-057 is the caller. Nothing in ATL-056 appends an event, because an event
   * describes a transition and performing transitions is that ticket's.
   */
  async append(input: AppendRequestEventInput): Promise<RequestEventRecord> {
    if (!isRequestEventType(input.type)) {
      /**
       * Thrown rather than defaulted: an unrecognised type renders as a blank
       * row in the request timeline, which is worse than a loud failure at the
       * call site that introduced it.
       */
      throw new UnknownRequestEventTypeError(String(input.type));
    }

    const params = input.params ?? {};
    const { fromStatus, toStatus } = params;

    /**
     * Both or neither. The table's constraint would refuse it, but answering
     * here keeps the database as the second gate — and half a transition is
     * unreadable: "changed to sent" from an unrecorded state cannot be placed in
     * a timeline.
     */
    if ((fromStatus === undefined) !== (toStatus === undefined)) {
      throw new IncompleteTransitionError();
    }

    const summary = buildRequestEventSummary(input.type, params);

    const { data, error } = await this.db
      .from("request_events")
      .insert({
        user_id: input.userId,
        request_id: input.requestId,
        event_type: input.type,
        summary,
        actor_type: input.actorType,
        ...(fromStatus === undefined
          ? {}
          : { from_status: fromStatus, to_status: toStatus ?? null }),
      })
      .select(COLUMNS)
      .single();

    if (error || !data) throw new RequestEventStoreError("append");
    return toRecord(data);
  }

  /**
   * One request's timeline, newest first.
   *
   * Ordered with the `id` tiebreak ATL-114 documents: `occurred_at` defaults to
   * `now()`, which is `transaction_timestamp()`, so two events written in one
   * transaction tie byte-identically — the failure ATL-109 measured on
   * `ai_messages`, where a tie reversed the transcript 10 times in 20.
   */
  async listForRequest(userId: string, requestId: string): Promise<RequestEventRecord[]> {
    const { data, error } = await this.db
      .from("request_events")
      .select(COLUMNS)
      .eq("user_id", userId)
      .eq("request_id", requestId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) throw new RequestEventStoreError("list for request");
    return (data ?? []).map(toRecord);
  }
}

function toRecord(row: RequestEventRow): RequestEventRecord {
  return {
    id: row.id,
    userId: row.user_id,
    requestId: row.request_id,
    eventType: row.event_type,
    fromStatus: (row.from_status as RequestStatus | null) ?? null,
    toStatus: (row.to_status as RequestStatus | null) ?? null,
    summary: row.summary,
    actorType: row.actor_type as RequestActorType,
    occurredAt: row.occurred_at,
  };
}
