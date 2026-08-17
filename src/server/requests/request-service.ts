import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { ApiErrorCode } from "@/lib/api/response-envelope";
import { logger } from "@/lib/telemetry/logger";
import {
  isAllowedTransition,
  type DeliveryMethod,
  type RequestActorType,
  type RequestStatus,
} from "@/lib/requests/requests";
import { recordingFor } from "@/lib/requests/request-transitions";
import { ActivityWriter } from "@/server/activity/activity-writer";
import { AuditWriter } from "@/server/audit/audit-writer";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { IdempotencyService, IdempotencyInProgressError } from "@/server/idempotency/idempotency";
import {
  DataRequestRepository,
  type DataRequestRecord,
} from "@/server/repositories/data-request-repository";
import { RequestEventRepository } from "@/server/repositories/request-event-repository";
import {
  NoopScoreRecalculationQueue,
  type ScoreRecalculationQueue,
} from "@/server/score/recalculation-queue";

/**
 * The data-request lifecycle (ATL-057, architecture §13).
 *
 * ATL-056 stored the state and declared the graph; this enforces it. §13 gives
 * four obligations for a transition — validated server-side, protected by an
 * idempotency key, recorded in `request_events`, and recorded in `audit_events` —
 * and all four live here, in one method, so none can be skipped by calling
 * something else. `DataRequestRepository.updateStatus` remains what ATL-056 made
 * it: a write seam that validates nothing.
 *
 * ## What a transition costs, and what it may not cost
 *
 * Five things happen, and the order is the design (D3):
 *
 *   1. **The status write** — the primary operation, conditional on the status
 *      the caller validated against. Everything else describes it.
 *   2. **`request_events`** — required. The request-scoped timeline is what
 *      frontend §9 renders; a transition missing from it is a gap in the record
 *      the user reads.
 *   3. **`audit_events`** — required. Security §12 lists request state
 *      transitions among the events the log must hold, and the acceptance
 *      criteria name it.
 *   4. **`activity_events`** — best effort. A missing global-feed row is a
 *      cosmetic gap.
 *   5. **Score recalculation** — best effort. A dropped enqueue costs a stale
 *      score until the next trigger.
 *
 * **A committed transition is never rolled back for 4 or 5.** The status change
 * is the user's and it succeeded; failing their request afterwards because a
 * timeline row did not persist would lose the thing they actually asked for —
 * the trade `AssetService.afterMutation` and ATL-069's emitter already make.
 *
 * Steps 2 and 3 are different: they are required, so a failure there fails the
 * call. The transition itself has still committed — these are separate
 * statements against separate tables, and PostgREST cannot open a transaction —
 * so the caller is told the operation failed while the status did move. That is
 * deliberate and it is why the idempotency key matters: a retry with the same key
 * replays rather than re-transitions.
 *
 * ## Retry semantics
 *
 * A caller retrying with the same `(userId, "request_transition", key)` gets the
 * recorded result back and **the transition is not performed again** — the claim
 * is written before the handler runs (ATL-104), so the second call reads the
 * first one's result. This holds whether the first attempt failed at a
 * best-effort step or succeeded outright: the result is recorded once the handler
 * returns, and steps 4 and 5 cannot make it return anything else.
 *
 * If a required step failed, the handler threw, no result was recorded, and the
 * claim stays in flight until its TTL — so an immediate retry is told the
 * operation is in progress rather than being allowed to double-write. That is
 * the honest answer: something is unresolved, and guessing which half succeeded
 * is worse than saying so.
 *
 * ## Scope
 *
 * Transitions only. `createDraft` and `updateDraft` are ATL-058/ATL-060,
 * `scheduleFollowUp` is ATL-066, and none of them appear here — architecture §9
 * lists them under `RequestService`, but a method built before the ticket that
 * defines its behaviour is a guess with a name.
 */

export type RequestResult<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode };

const ok = <T>(data: T): RequestResult<T> => ({ ok: true, data });
const fail = <T>(code: ApiErrorCode): RequestResult<T> => ({ ok: false, code });

/** The idempotency family §7.17 and the migration both name for this operation. */
export const REQUEST_TRANSITION_SCOPE = "request_transition";

/**
 * §13: `sent -> awaiting_response` is performed by a system job three days after
 * `sent_at`, or immediately when the user records a response note — whichever
 * comes first.
 */
export const AWAITING_RESPONSE_AFTER_DAYS = 3;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const SWEEP_BATCH_SIZE = 500;

export interface TransitionInput {
  userId: string;
  requestId: string;
  to: RequestStatus;
  /**
   * Supplied by the caller, never derived (D1).
   *
   * A key derived from the request id and the statuses would collapse two
   * genuinely separate actions into one: §13 permits `follow_up_due -> sent`
   * repeatedly, once per follow-up a person sends, and a derived key would make
   * the second one a silent replay of the first. The caller knows which
   * submission this is; this service does not.
   */
  idempotencyKey: string;
  /** `user` unless a job is acting (§7.8, jobs README). */
  actorType?: RequestActorType;
  /** Recorded when moving to `sent` — how the person sent it. */
  deliveryMethod?: DeliveryMethod;
}

/** What a transition answers with. */
export interface TransitionOutcome {
  request: DataRequestRecord;
  from: RequestStatus;
  to: RequestStatus;
  /** True when this is a replay of an earlier call with the same key. */
  replayed: boolean;
}

interface RequestDependencies {
  requests: DataRequestRepository;
  events: RequestEventRepository;
  activity: ActivityWriter;
  audit: AuditWriter;
  idempotency: IdempotencyService;
  score: ScoreRecalculationQueue;
}

export class RequestService {
  private readonly requests: DataRequestRepository;
  private readonly events: RequestEventRepository;
  private readonly activity: ActivityWriter;
  /**
   * The security-side record. Distinct from `activity`: §12 reserves
   * `audit_events` for security and incident response, pseudonymises the subject,
   * and allows no client access.
   */
  private readonly audit: AuditWriter;
  private readonly idempotency: IdempotencyService;
  private readonly score: ScoreRecalculationQueue;

  constructor(dependencies: RequestDependencies) {
    this.requests = dependencies.requests;
    this.events = dependencies.events;
    this.activity = dependencies.activity;
    this.audit = dependencies.audit;
    this.idempotency = dependencies.idempotency;
    this.score = dependencies.score;
  }

  /** Uses the service-role client: every write here is server-side by design. */
  static create(db: SupabaseClient<Database> = createServiceRoleClient()): RequestService {
    return new RequestService({
      requests: new DataRequestRepository(db),
      events: new RequestEventRepository(db),
      activity: new ActivityWriter(db),
      audit: new AuditWriter(db),
      idempotency: new IdempotencyService(db),
      score: new NoopScoreRecalculationQueue(),
    });
  }

  /**
   * Moves a request to a new status, if §13 permits it.
   *
   * The whole operation runs inside an idempotency claim, so a retry with the
   * same key replays rather than transitioning twice.
   */
  async transition(input: TransitionInput): Promise<RequestResult<TransitionOutcome>> {
    try {
      const outcome = await this.idempotency.run<RequestResult<TransitionOutcome>>({
        userId: input.userId,
        scope: REQUEST_TRANSITION_SCOPE,
        key: input.idempotencyKey,
        execute: () => this.performTransition(input),
      });

      /**
       * A replayed failure stays a failure, and a replayed success is marked as
       * one. `replayed` is carried on the data rather than the result, because a
       * refusal has no `data` to carry it and the caller's branch on `ok` should
       * not change shape depending on whether this is a retry.
       */
      if (!outcome.result.ok) return outcome.result;

      return ok({ ...outcome.result.data, replayed: outcome.replayed });
    } catch (error) {
      /**
       * Another caller holds the claim and has not finished. Not `UNAVAILABLE`
       * in spirit — nothing is broken — but the caller's options are identical:
       * wait and try again. Reported as `UNAVAILABLE` rather than inventing a
       * code, because `ApiErrorCode` is closed and "in progress" is not a
       * condition any surface in the product distinguishes today.
       */
      if (error instanceof IdempotencyInProgressError) {
        logger.warn("request.transition_in_progress", { operation: "request.transition" });
        return fail("UNAVAILABLE");
      }
      return this.storeFailure("request.transition", error);
    }
  }

  /**
   * Records what a service replied, and moves `sent -> awaiting_response`.
   *
   * §13 makes a recorded response note one of the two triggers for that
   * transition — "or immediately when the user records a response note, whichever
   * comes first" — so the note and the move belong together. Splitting them would
   * leave a request whose note says a reply arrived while its status says nobody
   * has answered.
   *
   * The note is stored **first**, and its failure fails the call: the note is the
   * thing the person typed, and a transition that claimed a reply arrived without
   * recording what it said would be worse than no transition. The transition then
   * runs through the same idempotent path as any other.
   *
   * The status only moves from `sent`. A note recorded later — while
   * `awaiting_response` or `follow_up_due` — is stored without a transition,
   * because §13 has no edge for it and the request is already past that point.
   */
  async recordResponseNote(input: {
    userId: string;
    requestId: string;
    note: string;
    idempotencyKey: string;
  }): Promise<RequestResult<TransitionOutcome | { request: DataRequestRecord }>> {
    let stored: DataRequestRecord | null;

    try {
      stored = await this.requests.update(input.userId, input.requestId, {
        lastStatusNote: input.note,
      });
    } catch (error) {
      return this.storeFailure("request.recordnote", error);
    }

    if (!stored) return fail("NOT_FOUND");

    if (stored.status !== "sent") {
      /**
       * Recorded, not transitioned. Answered as a success because the person's
       * note was stored, which is what they asked for; the absent transition is
       * not a failure of anything they did.
       */
      await this.appendResponseNoteEvent(input.userId, input.requestId);
      return ok({ request: stored });
    }

    return this.transition({
      userId: input.userId,
      requestId: input.requestId,
      to: "awaiting_response",
      idempotencyKey: input.idempotencyKey,
      actorType: "user",
    });
  }

  /**
   * The body of §13's three-day job: `sent -> awaiting_response`.
   *
   * **No scheduler.** The runtime — Edge Functions versus a dedicated worker — is
   * a deferred architecture decision (§21), and `src/server/jobs/README.md` holds
   * the requirements rather than a runner. This is the job's body, callable and
   * tested, exactly as `FindingsEngine.runNightlySweep` and
   * `NotificationService.purgeOlderThan` already are.
   *
   * Pure duration arithmetic from `sent_at` (D5). Three days is an interval, not
   * a calendar date, so no timezone is involved — the jobs README's
   * timezone-correctness rule applies to `follow_up_at`, which ATL-066 owns.
   *
   * Idempotent twice over: the predicate only matches requests still in `sent`,
   * and each transition carries a key derived from the request and the sweep's
   * own clock, so re-running the same sweep replays rather than repeats. Bounded
   * by `batchSize`, so one busy account cannot starve a run.
   *
   * Returns how many moved. Zero is the normal answer.
   */
  async runAwaitingResponseSweep(
    now: Date = new Date(),
    batchSize: number = SWEEP_BATCH_SIZE,
  ): Promise<RequestResult<number>> {
    const cutoff = new Date(
      now.getTime() - AWAITING_RESPONSE_AFTER_DAYS * MILLISECONDS_PER_DAY,
    ).toISOString();

    let due: DataRequestRecord[];

    try {
      due = await this.requests.listSentBefore(cutoff, batchSize);
    } catch (error) {
      return this.storeFailure("request.sweep", error);
    }

    let moved = 0;

    for (const request of due) {
      /**
       * The job's key, and the one place a key is *not* caller-supplied — because
       * here the job is the caller. Derived from the request and the cutoff so
       * that re-running the same sweep window replays instead of repeating, while
       * a later window is a genuinely new attempt.
       */
      const result = await this.transition({
        userId: request.userId,
        requestId: request.id,
        to: "awaiting_response",
        idempotencyKey: `sweep:${request.id}:${cutoff}`,
        actorType: "system",
      });

      if (result.ok && !result.data.replayed) moved += 1;
    }

    logger.info("request.sweep_completed", {
      jobName: "request-awaiting-response",
      jobStatus: "succeeded",
      count: moved,
    });

    return ok(moved);
  }

  /**
   * Validate, write, record. Runs inside the idempotency claim.
   *
   * Returns a `RequestResult` rather than throwing for the *expected* refusals —
   * a disallowed transition is an answer, not an error, and recording it as the
   * claim's result means a retry with the same key is told the same thing rather
   * than being allowed to try again. A **failure** of a required step throws, so
   * no result is recorded and the claim can be retried after its TTL.
   */
  private async performTransition(
    input: TransitionInput,
  ): Promise<RequestResult<TransitionOutcome>> {
    const current = await this.requests.find(input.userId, input.requestId);

    /** Missing and foreign answer identically — the non-oracle rule (ATL-030). */
    if (!current) return fail("NOT_FOUND");

    const from = current.status;

    if (!isAllowedTransition(from, input.to)) return fail("REQUEST_INVALID_TRANSITION");

    const moved = await this.requests.updateStatus(
      input.userId,
      input.requestId,
      from,
      input.to,
      this.stampFor(input.to, input.deliveryMethod),
    );

    /**
     * The row moved between the read and the write (D2). One re-read decides
     * which of the two answers is true, and neither exposes optimistic
     * concurrency as its own condition: the request is either gone, or in a state
     * that no longer permits what was asked.
     */
    if (!moved) {
      const reread = await this.requests.find(input.userId, input.requestId);
      if (!reread) return fail("NOT_FOUND");
      return fail("REQUEST_INVALID_TRANSITION");
    }

    const actorType = input.actorType ?? "user";
    const recording = recordingFor(from, input.to);

    /**
     * Required (D3). Thrown failures leave the claim without a result, so the
     * caller learns the operation did not complete rather than being handed a
     * success whose record does not exist.
     */
    await this.events.append({
      userId: input.userId,
      requestId: input.requestId,
      type: recording.requestEvent,
      params: { fromStatus: from, toStatus: input.to },
      actorType,
    });

    /**
     * Also required — security §12 lists request state transitions, and the
     * acceptance criteria name audit alongside `request_events`.
     *
     * Every context key is already in `AUDIT_CONTEXT_POLICY` and none is free
     * text, an identifier, or a personal value. The recipient, subject, body and
     * status note never appear here: an audit row describes that a state changed,
     * not what the request said.
     */
    await this.audit.write({
      userId: input.userId,
      eventType: "request.transitioned",
      actorType,
      entityType: "data_request",
      entityId: input.requestId,
      context: { fromStatus: from, toStatus: input.to },
    });

    await this.afterTransition(moved, recording.activity, from, input.to);

    return ok({ request: moved, from, to: input.to, replayed: false });
  }

  /**
   * The two best-effort records (D3).
   *
   * Neither can undo the transition and neither may fail the call. The write has
   * committed and is the user's; failing their request afterwards because a
   * timeline row did not persist would lose the change they actually asked for.
   * Logged loudly instead, so "best effort" means *observably* best effort.
   */
  private async afterTransition(
    request: DataRequestRecord,
    activityType: ReturnType<typeof recordingFor>["activity"],
    from: RequestStatus,
    to: RequestStatus,
  ): Promise<void> {
    try {
      await this.activity.write({
        userId: request.userId,
        type: activityType,
        /**
         * No `service` parameter: naming the service would need a second read of
         * `digital_assets`, and the templates fall back to "a service" without
         * one. A request's own timeline (`request_events`) is where the detail
         * lives; the global feed says that something moved.
         */
        params: { fromStatus: from, toStatus: to },
        entityType: "data_request",
        entityId: request.id,
        metadata: { fromStatus: from, toStatus: to, status: to },
      });
    } catch {
      logger.error("activity.write_failed", { operation: "request.transition", count: 1 });
    }

    try {
      await this.score.enqueue({ userId: request.userId, reason: "request.transitioned" });
    } catch {
      /**
       * A dropped recalculation costs a stale score until the next trigger or the
       * nightly sweep, which §11 runs regardless. It must never cost the user
       * their transition.
       */
      logger.error("score.enqueue_failed", { operation: "request.transition", count: 1 });
    }
  }

  /**
   * The lifecycle timestamps a given transition stamps alongside the status.
   *
   * `sent` records when it went out — and records it again on a follow-up, which
   * §13 requires explicitly ("a new `sent_at` is recorded"). `completed` records
   * when the matter closed, which the table's pairing constraint requires and
   * ADR-004's trailing-180-day credit depends on.
   *
   * Timestamps come from the application clock here rather than the database's,
   * because `updateStatus` takes them as values. Both columns are guarded by
   * not-future check constraints, so ATL-113's two-clock hazard applies: a
   * millisecond of clock skew ahead of the database would be refused. `Date.now()`
   * on the same host is behind `now()` by the round trip, which is why this has
   * not been a problem for `sent_at` in practice — and why the constraints exist
   * to catch it if it ever is.
   */
  private stampFor(to: RequestStatus, deliveryMethod: DeliveryMethod | undefined) {
    const nowIso = new Date().toISOString();

    if (to === "sent") {
      return {
        sentAt: nowIso,
        ...(deliveryMethod === undefined ? {} : { deliveryMethod }),
      };
    }

    if (to === "completed") return { completedAt: nowIso };

    return {};
  }

  /** The note-without-transition case. Best effort: the note is already stored. */
  private async appendResponseNoteEvent(userId: string, requestId: string): Promise<void> {
    try {
      await this.events.append({
        userId,
        requestId,
        type: "response_noted",
        actorType: "user",
      });
    } catch {
      logger.error("request.event_write_failed", { operation: "request.recordnote", count: 1 });
    }
  }

  /**
   * One place where a store failure becomes a result.
   *
   * The caught error is never returned or logged as a value: it may carry a
   * database message, and security §16 forbids those reaching a log sink. Only
   * the operation name and a code go out.
   *
   * `operation` values carry no underscore — `LOG_FIELD_POLICY` requires
   * /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/, so `request.record_note` would fail
   * redaction and vanish from the record.
   */
  private storeFailure<T>(operation: string, error: unknown): RequestResult<T> {
    logger.error("request.store_failed", {
      operation,
      errorCode: error instanceof Error ? "STORE_ERROR" : "UNKNOWN_ERROR",
    });
    return fail("UNAVAILABLE");
  }
}
