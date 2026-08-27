import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service module reaches `createServiceRoleClient` at import time, which
 * validates the whole environment. These tests construct the service with their
 * own doubles and never touch a client. The same two mocks
 * `archive-actions.integration.test.ts` and `notification-service.integration.test.ts`
 * use, for the same reason.
 */
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 5).toString("base64") },
}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

import {
  RequestService,
  AWAITING_RESPONSE_AFTER_DAYS,
  REQUEST_TRANSITION_SCOPE,
  type RequestResult,
} from "./request-service";
import { IdempotencyInProgressError } from "@/server/idempotency/idempotency";
import type {
  DataRequestRecord,
  StatusStampInput,
  UpdateDataRequestInput,
} from "@/server/repositories/data-request-repository";
import type { AppendRequestEventInput } from "@/server/repositories/request-event-repository";
import {
  ALLOWED_REQUEST_TRANSITIONS,
  REQUEST_STATUSES,
  type RequestStatus,
} from "@/lib/requests/requests";

/**
 * ATL-057 — the request state machine against test doubles.
 *
 * What only this layer can show, and what the acceptance criteria actually ask
 * for: that every §13 transition is permitted and every other pair is refused
 * with `REQUEST_INVALID_TRANSITION`; that a repeat with the same idempotency key
 * replays instead of transitioning again; that each transition writes
 * `request_events` **and** audit; and that the three-day job moves what is due
 * and nothing else.
 *
 * The doubles are in-memory rather than call-by-call mocks, because most of these
 * claims are about *what ends up recorded* — a spy assertion would pass for a
 * service that called the right method and wrote nothing. The idempotency double
 * reproduces ATL-104's contract (claim before execute, replay a recorded result,
 * refuse a live incomplete claim) rather than the storage underneath it, which
 * has its own suite against real Postgres.
 *
 * RLS, encryption and the schema constraints are asserted against real Postgres in
 * the ATL-056 suites and are not restated here.
 */

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ASSET = "44444444-4444-4444-8444-444444444444";

const DAY_MS = 24 * 60 * 60 * 1000;

/** An in-memory `data_requests`, only as capable as the real queries are. */
class FakeRequests {
  rows: DataRequestRecord[] = [];
  failOn: string | null = null;
  private sequence = 0;

  seed(overrides: Partial<DataRequestRecord> = {}): DataRequestRecord {
    this.sequence += 1;
    const row: DataRequestRecord = {
      id: `r${String(this.sequence).padStart(3, "0")}`,
      userId: ALICE,
      assetId: ASSET,
      requestType: "deletion",
      status: "draft",
      includedFieldKeys: [],
      deliveryMethod: null,
      sentAt: null,
      followUpAt: null,
      completedAt: null,
      externalReference: null,
      hasRecipient: true,
      hasSubject: true,
      hasBody: true,
      hasStatusNote: false,
      createdAt: new Date(Date.UTC(2026, 0, this.sequence)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, this.sequence)).toISOString(),
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  create(input: {
    userId: string;
    assetId: string;
    requestType: DataRequestRecord["requestType"];
    recipient?: string | undefined;
    includedFieldKeys?: readonly DataRequestRecord["includedFieldKeys"][number][] | undefined;
  }): Promise<DataRequestRecord> {
    if (this.failOn === "create") return Promise.reject(new Error("store down"));

    const row = this.seed({
      userId: input.userId,
      assetId: input.assetId,
      requestType: input.requestType,
      status: "draft",
      includedFieldKeys: [...(input.includedFieldKeys ?? [])],
      hasRecipient: input.recipient !== undefined,
      hasSubject: false,
      hasBody: false,
    });
    return Promise.resolve({ ...row });
  }

  find(userId: string, requestId: string): Promise<DataRequestRecord | null> {
    if (this.failOn === "find") return Promise.reject(new Error("store down"));
    return Promise.resolve(
      this.rows.find((r) => r.userId === userId && r.id === requestId) ?? null,
    );
  }

  updateStatus(
    userId: string,
    requestId: string,
    expectedStatus: RequestStatus,
    nextStatus: RequestStatus,
    stamp: StatusStampInput = {},
  ): Promise<DataRequestRecord | null> {
    if (this.failOn === "updateStatus") return Promise.reject(new Error("store down"));

    const row = this.rows.find(
      (r) => r.userId === userId && r.id === requestId && r.status === expectedStatus,
    );
    if (!row) return Promise.resolve(null);

    row.status = nextStatus;
    if (stamp.sentAt !== undefined) row.sentAt = stamp.sentAt;
    if (stamp.completedAt !== undefined) row.completedAt = stamp.completedAt ?? null;
    if (stamp.deliveryMethod !== undefined) row.deliveryMethod = stamp.deliveryMethod;
    return Promise.resolve({ ...row });
  }

  update(
    userId: string,
    requestId: string,
    input: UpdateDataRequestInput,
  ): Promise<DataRequestRecord | null> {
    if (this.failOn === "update") return Promise.reject(new Error("store down"));

    const row = this.rows.find((r) => r.userId === userId && r.id === requestId);
    if (!row) return Promise.resolve(null);

    if (input.lastStatusNote !== undefined) row.hasStatusNote = true;
    return Promise.resolve({ ...row });
  }

  listSentBefore(cutoff: string, limit: number): Promise<DataRequestRecord[]> {
    if (this.failOn === "listSentBefore") return Promise.reject(new Error("store down"));

    return Promise.resolve(
      this.rows
        .filter((r) => r.status === "sent" && r.sentAt !== null && r.sentAt < cutoff)
        .sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""))
        .slice(0, limit)
        .map((r) => ({ ...r })),
    );
  }
}

/** An in-memory `request_events`. */
class FakeEvents {
  appended: AppendRequestEventInput[] = [];
  failNext = false;

  append(input: AppendRequestEventInput): Promise<{ id: string }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("event store down"));
    }
    this.appended.push(input);
    return Promise.resolve({ id: `e${this.appended.length}` });
  }
}

interface AuditCall {
  eventType: string;
  actorType: string;
  entityType?: string | undefined;
  entityId?: string | undefined;
  context?: Record<string, unknown> | undefined;
}

class FakeAudit {
  written: AuditCall[] = [];
  failNext = false;

  write(input: AuditCall): Promise<{ id: string }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("audit store down"));
    }
    this.written.push(input);
    return Promise.resolve({ id: `a${this.written.length}` });
  }
}

interface ActivityCall {
  type: string;
  entityType?: string | undefined;
  entityId?: string | undefined;
}

class FakeActivity {
  written: ActivityCall[] = [];
  failNext = false;

  write(input: ActivityCall): Promise<{ id: string }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("activity store down"));
    }
    this.written.push(input);
    return Promise.resolve({ id: `act${this.written.length}` });
  }
}

/** ATL-105's vault, as `createDraft` uses it: one best-effort stamp. */
class FakePersonalFields {
  marked: { userId: string; fieldIds: readonly string[] }[] = [];
  failNext = false;

  markUsed(userId: string, fieldIds: readonly string[]): Promise<{ ok: true; data: number }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("vault down"));
    }
    this.marked.push({ userId, fieldIds });
    return Promise.resolve({ ok: true, data: fieldIds.length });
  }
}

class FakeScore {
  enqueued: { userId: string; reason: string }[] = [];
  failNext = false;

  enqueue(request: { userId: string; reason: string }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("queue down"));
    }
    this.enqueued.push(request);
    return Promise.resolve();
  }
}

/**
 * ATL-104's contract, reproduced: claim before execute, replay a recorded
 * result, refuse a live claim that has not completed.
 *
 * A result is recorded only when the handler *returns* — a throw leaves the claim
 * in flight, which is exactly what the real service does and what the retry
 * semantics depend on.
 */
class FakeIdempotency {
  claims = new Map<string, { done: boolean; result?: unknown }>();
  executions = 0;

  async run<T>({
    userId,
    scope,
    key,
    execute,
  }: {
    userId: string;
    scope: string;
    key: string;
    execute: () => Promise<T>;
  }): Promise<{ result: T; replayed: boolean }> {
    const id = `${userId}:${scope}:${key}`;
    const existing = this.claims.get(id);

    if (existing) {
      if (!existing.done) throw new IdempotencyInProgressError(scope);
      return { result: existing.result as T, replayed: true };
    }

    this.claims.set(id, { done: false });
    this.executions += 1;

    const result = await execute();
    this.claims.set(id, { done: true, result });
    return { result, replayed: false };
  }
}

let requests: FakeRequests;
let events: FakeEvents;
let audit: FakeAudit;
let activity: FakeActivity;
let score: FakeScore;
let idempotency: FakeIdempotency;
let personalFields: FakePersonalFields;
let service: RequestService;

type Deps = ConstructorParameters<typeof RequestService>[0];

function build(): RequestService {
  return new RequestService({
    requests: requests as unknown as Deps["requests"],
    events: events as unknown as Deps["events"],
    personalFields: personalFields as unknown as Deps["personalFields"],
    activity: activity as unknown as Deps["activity"],
    audit: audit as unknown as Deps["audit"],
    idempotency: idempotency as unknown as Deps["idempotency"],
    /** No cast: `FakeScore` structurally satisfies the real queue interface. */
    score,
  });
}

function expectOk<T>(result: RequestResult<T>): T {
  if (!result.ok) throw new Error(`expected success but got ${result.code}`);
  return result.data;
}

let keyCounter = 0;
const nextKey = () => `key-${(keyCounter += 1)}`;

beforeEach(() => {
  requests = new FakeRequests();
  events = new FakeEvents();
  audit = new FakeAudit();
  activity = new FakeActivity();
  score = new FakeScore();
  idempotency = new FakeIdempotency();
  personalFields = new FakePersonalFields();
  service = build();
  keyCounter = 0;
});

describe("the exhaustive §13 matrix", () => {
  const allowed = new Set(
    REQUEST_STATUSES.flatMap((from) =>
      ALLOWED_REQUEST_TRANSITIONS[from].map((to) => `${from}->${to}`),
    ),
  );

  const pairs = REQUEST_STATUSES.flatMap((from) =>
    REQUEST_STATUSES.map((to) => [from, to] as const),
  );

  it("covers all 64 ordered pairs", () => {
    expect(pairs).toHaveLength(64);
    expect(allowed.size).toBe(18);
  });

  it.each(pairs)("%s -> %s", async (from, to) => {
    const request = requests.seed({ status: from });

    const result = await service.transition({
      userId: ALICE,
      requestId: request.id,
      to,
      idempotencyKey: nextKey(),
    });

    if (allowed.has(`${from}->${to}`)) {
      expect(expectOk(result).to).toBe(to);
    } else {
      /**
       * The acceptance criterion, verbatim: "every non-listed transition
       * rejected with `REQUEST_INVALID_TRANSITION`". Including every
       * self-transition, which §13 does not list.
       */
      expect(result).toEqual({ ok: false, code: "REQUEST_INVALID_TRANSITION" });
      expect(requests.rows[0]?.status).toBe(from);
    }
  });

  it("writes nothing at all for a refused transition", async () => {
    const request = requests.seed({ status: "completed" });

    await service.transition({
      userId: ALICE,
      requestId: request.id,
      to: "sent",
      idempotencyKey: nextKey(),
    });

    expect(events.appended).toEqual([]);
    expect(audit.written).toEqual([]);
    expect(activity.written).toEqual([]);
    expect(score.enqueued).toEqual([]);
  });
});

describe("rejected is nonterminal", () => {
  it.each(["completed", "canceled"] as const)("moves rejected -> %s", async (to) => {
    const request = requests.seed({ status: "rejected" });

    const outcome = expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to,
        idempotencyKey: nextKey(),
      }),
    );

    expect(outcome.from).toBe("rejected");
    expect(outcome.to).toBe(to);
  });

  it("keeps completed and canceled terminal", async () => {
    for (const from of ["completed", "canceled"] as const) {
      const request = requests.seed({ status: from });

      for (const to of REQUEST_STATUSES) {
        const result = await service.transition({
          userId: ALICE,
          requestId: request.id,
          to,
          idempotencyKey: nextKey(),
        });
        expect(result.ok).toBe(false);
      }
    }
  });
});

describe("ownership and the non-oracle rule", () => {
  it("answers NOT_FOUND for another person's request", async () => {
    const request = requests.seed({ status: "draft", userId: BOB });

    expect(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: nextKey(),
      }),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("answers NOT_FOUND identically for a request that does not exist", async () => {
    /** Missing and foreign are indistinguishable (ATL-030). */
    expect(
      await service.transition({
        userId: ALICE,
        requestId: "no-such-request",
        to: "ready",
        idempotencyKey: nextKey(),
      }),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("optimistic concurrency is not exposed as its own condition (D2)", () => {
  it("reports a row that moved underneath as REQUEST_INVALID_TRANSITION", async () => {
    const request = requests.seed({ status: "draft" });

    /**
     * Simulates the race: the read sees `draft`, and the row becomes `canceled`
     * before the conditional write lands. `updateStatus` matches nothing, and the
     * re-read finds a state that no longer permits `ready`.
     */
    const original = requests.find.bind(requests);
    vi.spyOn(requests, "find").mockImplementationOnce(async (u: string, r: string) => {
      const row = await original(u, r);
      requests.rows[0]!.status = "canceled";
      return row ? { ...row, status: "draft" as RequestStatus } : null;
    });

    expect(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: nextKey(),
      }),
    ).toEqual({ ok: false, code: "REQUEST_INVALID_TRANSITION" });
  });

  it("reports a row that vanished underneath as NOT_FOUND", async () => {
    const request = requests.seed({ status: "draft" });

    const original = requests.find.bind(requests);
    vi.spyOn(requests, "find").mockImplementationOnce(async (u: string, r: string) => {
      const row = await original(u, r);
      requests.rows = [];
      return row;
    });

    expect(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: nextKey(),
      }),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("each transition records what §13 requires", () => {
  it("writes one request_events row and one audit event", async () => {
    const request = requests.seed({ status: "ready" });

    await service.transition({
      userId: ALICE,
      requestId: request.id,
      to: "sent",
      idempotencyKey: nextKey(),
    });

    expect(events.appended).toHaveLength(1);
    expect(events.appended[0]).toMatchObject({
      requestId: request.id,
      type: "marked_sent",
      params: { fromStatus: "ready", toStatus: "sent" },
      actorType: "user",
    });

    expect(audit.written).toHaveLength(1);
    expect(audit.written[0]).toMatchObject({
      eventType: "request.transitioned",
      actorType: "user",
      entityType: "data_request",
      entityId: request.id,
      context: { fromStatus: "ready", toStatus: "sent" },
    });
  });

  it("writes an activity row and enqueues a recalculation", async () => {
    const request = requests.seed({ status: "sent", sentAt: new Date().toISOString() });

    await service.transition({
      userId: ALICE,
      requestId: request.id,
      to: "completed",
      idempotencyKey: nextKey(),
    });

    expect(activity.written[0]).toMatchObject({
      type: "request.completed",
      entityType: "data_request",
      entityId: request.id,
    });
    expect(score.enqueued).toEqual([{ userId: ALICE, reason: "request.transitioned" }]);
  });

  it("puts no restricted value in the audit context", async () => {
    /**
     * An audit row says a state changed. The recipient, subject, body and status
     * note never appear — security §12, and the whole reason ATL-056 encrypted
     * them.
     */
    const request = requests.seed({ status: "ready" });

    await service.transition({
      userId: ALICE,
      requestId: request.id,
      to: "sent",
      idempotencyKey: nextKey(),
    });

    expect(Object.keys(audit.written[0]?.context ?? {}).sort()).toEqual(["fromStatus", "toStatus"]);
  });

  it("stamps sent_at when a request is sent, and again on a follow-up", async () => {
    // §13: `follow_up_due -> sent` records a **new** `sent_at`.
    const request = requests.seed({ status: "ready" });

    const sent = expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "sent",
        idempotencyKey: nextKey(),
        deliveryMethod: "copy",
      }),
    );
    expect(sent.request.sentAt).not.toBeNull();
    expect(sent.request.deliveryMethod).toBe("copy");

    const first = sent.request.sentAt;

    requests.rows[0]!.status = "follow_up_due";
    await new Promise((resolve) => setTimeout(resolve, 2));

    const followed = expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "sent",
        idempotencyKey: nextKey(),
      }),
    );

    expect(followed.request.sentAt).not.toBe(first);
    expect(events.appended[1]?.type).toBe("follow_up_sent");
  });

  it("stamps completed_at on completion", async () => {
    // ADR-004's trailing-180-day credit cannot count a completion with no time.
    const request = requests.seed({ status: "sent" });

    const outcome = expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "completed",
        idempotencyKey: nextKey(),
      }),
    );

    expect(outcome.request.completedAt).not.toBeNull();
  });

  it("attributes a system transition to the system", async () => {
    // Jobs README: "jobs that change user-visible state emit activity/audit
    // events with `actor_type = 'system'` so the user can see why something
    // changed."
    const request = requests.seed({ status: "sent" });

    await service.transition({
      userId: ALICE,
      requestId: request.id,
      to: "awaiting_response",
      idempotencyKey: nextKey(),
      actorType: "system",
    });

    expect(events.appended[0]?.actorType).toBe("system");
    expect(audit.written[0]?.actorType).toBe("system");
  });
});

describe("required versus best-effort writes (D3)", () => {
  it("fails the call when request_events cannot be written", async () => {
    const request = requests.seed({ status: "draft" });
    events.failNext = true;

    expect(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: nextKey(),
      }),
    ).toEqual({ ok: false, code: "UNAVAILABLE" });
  });

  it("fails the call when the audit event cannot be written", async () => {
    const request = requests.seed({ status: "draft" });
    audit.failNext = true;

    expect(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: nextKey(),
      }),
    ).toEqual({ ok: false, code: "UNAVAILABLE" });
  });

  it("succeeds when only the activity write fails", async () => {
    /**
     * The transition committed and is the user's. Failing their request because a
     * global-feed row did not persist would lose the change they asked for.
     */
    const request = requests.seed({ status: "draft" });
    activity.failNext = true;

    const outcome = expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: nextKey(),
      }),
    );

    expect(outcome.to).toBe("ready");
    expect(activity.written).toEqual([]);
    /** The required records still landed. */
    expect(events.appended).toHaveLength(1);
    expect(audit.written).toHaveLength(1);
  });

  it("succeeds when only the score enqueue fails", async () => {
    const request = requests.seed({ status: "draft" });
    score.failNext = true;

    expect(
      expectOk(
        await service.transition({
          userId: ALICE,
          requestId: request.id,
          to: "ready",
          idempotencyKey: nextKey(),
        }),
      ).to,
    ).toBe("ready");
    expect(score.enqueued).toEqual([]);
  });
});

describe("idempotency and retry semantics", () => {
  it("performs the transition once for a repeated key", async () => {
    const request = requests.seed({ status: "draft" });
    const key = nextKey();

    const first = expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: key,
      }),
    );
    const second = expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: key,
      }),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(idempotency.executions).toBe(1);
    /** One transition, one of each record. */
    expect(events.appended).toHaveLength(1);
    expect(audit.written).toHaveLength(1);
  });

  it("replays the committed transition after a best-effort failure", async () => {
    /**
     * The requirement stated explicitly: if a transition commits but activity or
     * the score enqueue fails, a retry with the same key replays the successful
     * result and does **not** transition again.
     */
    const request = requests.seed({ status: "draft" });
    const key = nextKey();

    activity.failNext = true;
    const first = expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: key,
      }),
    );
    expect(first.replayed).toBe(false);

    const retry = expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: key,
      }),
    );

    expect(retry.replayed).toBe(true);
    expect(retry.to).toBe("ready");
    expect(idempotency.executions).toBe(1);
    expect(events.appended).toHaveLength(1);
  });

  it("does not let a different key repeat a transition that already happened", async () => {
    /**
     * The second line of defence, and the reason a derived key was rejected (D1):
     * a fresh key runs the handler, but the status guard refuses because the row
     * is no longer in the state §13 requires.
     */
    const request = requests.seed({ status: "draft" });

    expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: nextKey(),
      }),
    );

    expect(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: nextKey(),
      }),
    ).toEqual({ ok: false, code: "REQUEST_INVALID_TRANSITION" });
  });

  it("lets a genuinely repeated transition happen under a new key", async () => {
    /**
     * §13 permits `follow_up_due -> sent` once per follow-up. A derived key would
     * have made the second one a silent replay of the first — the failure D1
     * exists to prevent.
     */
    const request = requests.seed({ status: "follow_up_due" });

    expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "sent",
        idempotencyKey: nextKey(),
      }),
    );

    requests.rows[0]!.status = "follow_up_due";

    const second = expectOk(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "sent",
        idempotencyKey: nextKey(),
      }),
    );

    expect(second.replayed).toBe(false);
    expect(idempotency.executions).toBe(2);
    expect(events.appended).toHaveLength(2);
  });

  it("replays a refusal rather than re-deciding it", async () => {
    const request = requests.seed({ status: "completed" });
    const key = nextKey();

    const first = await service.transition({
      userId: ALICE,
      requestId: request.id,
      to: "sent",
      idempotencyKey: key,
    });
    const second = await service.transition({
      userId: ALICE,
      requestId: request.id,
      to: "sent",
      idempotencyKey: key,
    });

    expect(first).toEqual({ ok: false, code: "REQUEST_INVALID_TRANSITION" });
    expect(second).toEqual(first);
    expect(idempotency.executions).toBe(1);
  });

  it("reports a claim still in flight as unavailable", async () => {
    const request = requests.seed({ status: "draft" });
    idempotency.claims.set(`${ALICE}:${REQUEST_TRANSITION_SCOPE}:busy`, { done: false });

    expect(
      await service.transition({
        userId: ALICE,
        requestId: request.id,
        to: "ready",
        idempotencyKey: "busy",
      }),
    ).toEqual({ ok: false, code: "UNAVAILABLE" });
  });

  it("scopes the claim to request_transition", async () => {
    const request = requests.seed({ status: "draft" });

    await service.transition({
      userId: ALICE,
      requestId: request.id,
      to: "ready",
      idempotencyKey: "k",
    });

    // Architecture §7.17 and the migration both name this scope.
    expect([...idempotency.claims.keys()]).toEqual([`${ALICE}:${REQUEST_TRANSITION_SCOPE}:k`]);
  });
});

describe("recording a response note", () => {
  it("stores the note and moves sent -> awaiting_response", async () => {
    // §13: the transition happens "immediately when the user records a response
    // note", whichever comes first.
    const request = requests.seed({ status: "sent" });

    const result = await service.recordResponseNote({
      userId: ALICE,
      requestId: request.id,
      note: "They asked for ID.",
      idempotencyKey: nextKey(),
    });

    expect(result.ok).toBe(true);
    expect(requests.rows[0]?.status).toBe("awaiting_response");
    expect(requests.rows[0]?.hasStatusNote).toBe(true);
  });

  it("stores a note without transitioning when the request is past sent", async () => {
    /** §13 has no edge from `awaiting_response` back to itself. */
    const request = requests.seed({ status: "awaiting_response" });

    const result = await service.recordResponseNote({
      userId: ALICE,
      requestId: request.id,
      note: "Chased again.",
      idempotencyKey: nextKey(),
    });

    expect(result.ok).toBe(true);
    expect(requests.rows[0]?.status).toBe("awaiting_response");
    expect(events.appended[0]?.type).toBe("response_noted");
  });

  it("answers NOT_FOUND for another person's request, storing nothing", async () => {
    const request = requests.seed({ status: "sent", userId: BOB });

    expect(
      await service.recordResponseNote({
        userId: ALICE,
        requestId: request.id,
        note: "Nope.",
        idempotencyKey: nextKey(),
      }),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(requests.rows[0]?.hasStatusNote).toBe(false);
  });

  it("fails without transitioning when the note cannot be stored", async () => {
    /**
     * The note is what the person typed. A transition claiming a reply arrived
     * without recording what it said would be worse than no transition.
     */
    const request = requests.seed({ status: "sent" });
    requests.failOn = "update";

    expect(
      await service.recordResponseNote({
        userId: ALICE,
        requestId: request.id,
        note: "Lost.",
        idempotencyKey: nextKey(),
      }),
    ).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(requests.rows[0]?.status).toBe("sent");
  });
});

describe("the three-day sweep (D5)", () => {
  const now = new Date(Date.UTC(2026, 5, 1));
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

  it("moves a request sent more than three days ago", async () => {
    requests.seed({ status: "sent", sentAt: daysAgo(AWAITING_RESPONSE_AFTER_DAYS + 1) });

    expect(expectOk(await service.runAwaitingResponseSweep(now))).toBe(1);
    expect(requests.rows[0]?.status).toBe("awaiting_response");
  });

  it("leaves one sent less than three days ago alone", async () => {
    requests.seed({ status: "sent", sentAt: daysAgo(AWAITING_RESPONSE_AFTER_DAYS - 1) });

    expect(expectOk(await service.runAwaitingResponseSweep(now))).toBe(0);
    expect(requests.rows[0]?.status).toBe("sent");
  });

  it("leaves one sent exactly three days ago alone", async () => {
    /**
     * The cutoff is exclusive. Asserted because an off-by-one here nudges every
     * request a day early, and nothing would report it.
     */
    requests.seed({ status: "sent", sentAt: daysAgo(AWAITING_RESPONSE_AFTER_DAYS) });

    expect(expectOk(await service.runAwaitingResponseSweep(now))).toBe(0);
  });

  it("ignores requests that are not in sent", async () => {
    requests.seed({ status: "completed", sentAt: daysAgo(30) });
    requests.seed({ status: "canceled", sentAt: daysAgo(30) });
    requests.seed({ status: "awaiting_response", sentAt: daysAgo(30) });

    expect(expectOk(await service.runAwaitingResponseSweep(now))).toBe(0);
  });

  it("is idempotent: a second run over the same window moves nothing", async () => {
    requests.seed({ status: "sent", sentAt: daysAgo(10) });

    expect(expectOk(await service.runAwaitingResponseSweep(now))).toBe(1);
    expect(expectOk(await service.runAwaitingResponseSweep(now))).toBe(0);
  });

  it("attributes every move it makes to the system", async () => {
    requests.seed({ status: "sent", sentAt: daysAgo(10) });

    await service.runAwaitingResponseSweep(now);

    expect(events.appended[0]?.actorType).toBe("system");
    expect(audit.written[0]?.actorType).toBe("system");
  });

  it("crosses users, because a sweep is not about one person", async () => {
    requests.seed({ status: "sent", sentAt: daysAgo(10), userId: ALICE });
    requests.seed({ status: "sent", sentAt: daysAgo(10), userId: BOB });

    expect(expectOk(await service.runAwaitingResponseSweep(now))).toBe(2);
  });

  it("is bounded by the batch size", async () => {
    for (let i = 0; i < 5; i += 1) {
      requests.seed({ status: "sent", sentAt: daysAgo(10 + i) });
    }

    expect(expectOk(await service.runAwaitingResponseSweep(now, 2))).toBe(2);
    /** The rest wait for the next run rather than starving it. */
    expect(requests.rows.filter((r) => r.status === "sent")).toHaveLength(3);
  });

  it("reports a store failure rather than a partial count", async () => {
    requests.failOn = "listSentBefore";

    expect(await service.runAwaitingResponseSweep(now)).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
  });

  it("defaults its clock to now, so production passes no second clock", async () => {
    const spy = vi.spyOn(requests, "listSentBefore");

    await service.runAwaitingResponseSweep();

    const cutoff = spy.mock.calls[0]?.[0] ?? "";
    const expected = Date.now() - AWAITING_RESPONSE_AFTER_DAYS * DAY_MS;
    expect(Math.abs(new Date(cutoff).getTime() - expected)).toBeLessThan(5_000);
  });
});

describe("creating the draft Step 1 prepared (ATL-058)", () => {
  const validDraft = {
    userId: ALICE,
    assetId: ASSET,
    requestType: "deletion" as const,
    recipient: "privacy@acme.example",
    includedFieldKeys: ["email"] as const,
    fieldIds: ["field-1"],
  };

  it("creates the request in draft, carrying the approved keys", async () => {
    const created = expectOk(await service.createDraft(validDraft));

    expect(created.status).toBe("draft");
    expect(created.includedFieldKeys).toEqual(["email"]);
    expect(created.hasRecipient).toBe(true);
  });

  it("stores no subject or body", async () => {
    /**
     * Step 1 collects a recipient and approvals; ATL-059 writes the body. All
     * three encrypted columns are nullable precisely so this state is legal.
     */
    const created = expectOk(await service.createDraft(validDraft));

    expect(created.hasSubject).toBe(false);
    expect(created.hasBody).toBe(false);
  });

  it("leaves the request in draft rather than advancing it (D6)", async () => {
    /**
     * `draft -> ready` means the draft is prepared, which is ATL-060's outcome.
     * ATL-058 stopping here is what keeps the two tickets separable.
     */
    const created = expectOk(await service.createDraft(validDraft));

    expect(created.status).toBe("draft");
    expect(events.appended).toEqual([]);
    expect(audit.written).toEqual([]);
  });

  it("approves nothing when the person ticked nothing", async () => {
    // FR-08: every field is optional, and unchecked is the default.
    const created = expectOk(
      await service.createDraft({ ...validDraft, includedFieldKeys: [], fieldIds: [] }),
    );

    expect(created.includedFieldKeys).toEqual([]);
    expect(personalFields.marked).toEqual([]);
  });

  it("refuses an invalid recipient before writing anything", async () => {
    expect(await service.createDraft({ ...validDraft, recipient: "not-an-address" })).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(requests.rows).toEqual([]);
  });

  it("refuses a missing recipient before writing anything", async () => {
    expect(await service.createDraft({ ...validDraft, recipient: "   " })).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(requests.rows).toEqual([]);
  });

  it("refuses a key outside the ADR-002 vocabulary", async () => {
    /**
     * The keys govern what may later be sent, so an unrecognised one must not
     * reach storage. The repository refuses it too; this keeps the database as
     * the second gate.
     */
    expect(
      await service.createDraft({
        ...validDraft,
        includedFieldKeys: ["passport_number"] as unknown as typeof validDraft.includedFieldKeys,
      }),
    ).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(requests.rows).toEqual([]);
  });

  it("stamps last_used_at on the fields it included", async () => {
    /**
     * ATL-105 built `markUsed` and left it uncalled, because the only thing that
     * uses a field is a request draft. This is that draft.
     */
    await service.createDraft({ ...validDraft, fieldIds: ["field-1", "field-2"] });

    expect(personalFields.marked).toEqual([{ userId: ALICE, fieldIds: ["field-1", "field-2"] }]);
  });

  it("writes request.created to the global feed", async () => {
    await service.createDraft(validDraft);

    expect(activity.written[0]).toMatchObject({
      type: "request.created",
      entityType: "data_request",
    });
  });

  it("still creates the draft when the activity write fails", async () => {
    // Best effort (D4). A missing feed row must not cost the person their draft.
    activity.failNext = true;

    const created = expectOk(await service.createDraft(validDraft));

    expect(created.status).toBe("draft");
    expect(activity.written).toEqual([]);
  });

  it("still creates the draft when the usage stamp fails", async () => {
    /**
     * `last_used_at` exists so a person can prune unused fields. Losing one hint
     * must not cost them the request.
     */
    personalFields.failNext = true;

    const created = expectOk(await service.createDraft(validDraft));

    expect(created.status).toBe("draft");
    expect(personalFields.marked).toEqual([]);
  });

  it("reports a store failure as unavailable", async () => {
    requests.failOn = "create";

    expect(await service.createDraft(validDraft)).toEqual({ ok: false, code: "UNAVAILABLE" });
  });

  it("is not idempotency-claimed, so two drafts are two requests", async () => {
    /**
     * Deliberate: a person may genuinely start two requests to one service. A
     * claim keyed on anything stable enough to deduplicate the accidental case
     * would also refuse the deliberate one.
     */
    await service.createDraft(validDraft);
    await service.createDraft(validDraft);

    expect(requests.rows).toHaveLength(2);
    expect(idempotency.executions).toBe(0);
  });
});
