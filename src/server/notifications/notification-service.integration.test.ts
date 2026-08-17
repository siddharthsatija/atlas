import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service module reaches `createServiceRoleClient` at import time, which
 * validates the whole environment. These tests construct the service with their
 * own doubles and never touch a client, so the real env is not merely unnecessary
 * — requiring it would make this suite need a database it does not use. The same
 * two mocks `archive-actions.integration.test.ts` uses, for the same reason.
 */
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 5).toString("base64") },
}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

import {
  NotificationService,
  NOTIFICATION_RETENTION_DAYS,
  type CreateNotificationOutcome,
  type NotificationResult,
} from "./notification-service";
import type {
  CreateNotificationInput,
  ListNotificationsInput,
  NotificationRecord,
} from "@/server/repositories/notification-repository";
import type { NotificationPreferenceRecord } from "@/server/repositories/notification-preference-repository";
import type { NotificationType } from "@/lib/notifications/notification-types";

/**
 * ATL-107 — the notification service against test doubles.
 *
 * What this layer owns, and what only a fake store can show cheaply: that a
 * disabled type is never written, that `security` is written without any
 * preference being consulted, that a preference for `security` is refused before
 * the store is touched, that content carrying a restricted value is refused
 * rather than stored, and that the purge is bounded and idempotent.
 *
 * The doubles are in-memory rather than mocked call-by-call, because most of these
 * claims are about *what ends up stored* — an assertion on a spy would pass for a
 * service that called the right method with the right arguments and then wrote
 * nothing.
 *
 * The database's own guarantees are asserted against real Postgres in
 * `tests/integration/notifications-rls.test.ts`: two-user isolation, the closed
 * type vocabulary, and the constraint that makes a `security` preference row
 * unrepresentable. None of that is restated here — a fake store cannot enforce
 * any of it, and pretending otherwise would be the worst kind of green test.
 */

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const DAY_MS = 24 * 60 * 60 * 1000;

/** An in-memory `notifications` table, only as capable as the real queries are. */
class FakeNotifications {
  rows: NotificationRecord[] = [];
  /** Counts delete round trips, so the purge's batching can be observed. */
  purgeCalls: number[] = [];
  failOn: string | null = null;
  private sequence = 0;

  create(input: CreateNotificationInput): Promise<NotificationRecord> {
    if (this.failOn === "create") return Promise.reject(new Error("store down"));

    this.sequence += 1;
    const row: NotificationRecord = {
      id: `n${String(this.sequence).padStart(3, "0")}`,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      readAt: null,
      createdAt: new Date(Date.UTC(2026, 0, this.sequence)).toISOString(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  list(input: ListNotificationsInput): Promise<NotificationRecord[]> {
    if (this.failOn === "list") return Promise.reject(new Error("store down"));

    const ordered = [...this.rows]
      .filter((row) => row.userId === input.userId)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.id.localeCompare(a.id)
          : b.createdAt.localeCompare(a.createdAt),
      );

    const after = input.before
      ? ordered.filter((row) =>
          row.createdAt === input.before?.createdAt
            ? row.id < input.before.id
            : row.createdAt < (input.before?.createdAt ?? ""),
        )
      : ordered;

    return Promise.resolve(after.slice(0, input.limit));
  }

  countUnread(userId: string): Promise<number> {
    if (this.failOn === "countUnread") return Promise.reject(new Error("store down"));
    return Promise.resolve(
      this.rows.filter((row) => row.userId === userId && row.readAt === null).length,
    );
  }

  markRead(userId: string, id: string, readAt: string): Promise<boolean> {
    const row = this.rows.find((r) => r.userId === userId && r.id === id && r.readAt === null);
    if (!row) return Promise.resolve(false);
    row.readAt = readAt;
    return Promise.resolve(true);
  }

  markAllRead(userId: string, readAt: string): Promise<number> {
    const unread = this.rows.filter((r) => r.userId === userId && r.readAt === null);
    for (const row of unread) row.readAt = readAt;
    return Promise.resolve(unread.length);
  }

  markEntityRead(
    userId: string,
    entityType: string,
    entityId: string,
    readAt: string,
  ): Promise<number> {
    const matching = this.rows.filter(
      (r) =>
        r.userId === userId &&
        r.entityType === entityType &&
        r.entityId === entityId &&
        r.readAt === null,
    );
    for (const row of matching) row.readAt = readAt;
    return Promise.resolve(matching.length);
  }

  purgeOlderThan(cutoff: string, limit: number): Promise<number> {
    if (this.failOn === "purge") return Promise.reject(new Error("store down"));

    const stale = this.rows.filter((row) => row.createdAt < cutoff).slice(0, limit);
    this.purgeCalls.push(stale.length);
    this.rows = this.rows.filter((row) => !stale.includes(row));
    return Promise.resolve(stale.length);
  }

  /** Seeds directly, bypassing the service, so creation rules are not under test. */
  seed(userId: string, type: NotificationType, createdAt: string, readAt: string | null = null) {
    this.sequence += 1;
    this.rows.push({
      id: `s${String(this.sequence).padStart(3, "0")}`,
      userId,
      type,
      title: "Seeded",
      body: "Seeded",
      entityType: null,
      entityId: null,
      readAt,
      createdAt,
    });
  }
}

/** An in-memory `notification_preferences` table, with the unique pair enforced. */
class FakePreferences {
  rows: NotificationPreferenceRecord[] = [];
  /** Every `find` the service performed, so a bypass can be proven. */
  lookups: { userId: string; type: NotificationType }[] = [];

  find(
    userId: string,
    notificationType: NotificationType,
  ): Promise<NotificationPreferenceRecord | null> {
    this.lookups.push({ userId, type: notificationType });
    return Promise.resolve(
      this.rows.find((r) => r.userId === userId && r.notificationType === notificationType) ?? null,
    );
  }

  list(userId: string): Promise<NotificationPreferenceRecord[]> {
    return Promise.resolve(this.rows.filter((r) => r.userId === userId));
  }

  upsert(
    userId: string,
    notificationType: NotificationType,
    enabled: boolean,
  ): Promise<NotificationPreferenceRecord> {
    const existing = this.rows.find(
      (r) => r.userId === userId && r.notificationType === notificationType,
    );
    if (existing) {
      existing.enabled = enabled;
      return Promise.resolve(existing);
    }

    const row: NotificationPreferenceRecord = {
      id: `p${String(this.rows.length + 1).padStart(3, "0")}`,
      userId,
      notificationType,
      enabled,
      createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  clear(userId: string, notificationType: NotificationType): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) => !(r.userId === userId && r.notificationType === notificationType),
    );
    return Promise.resolve(this.rows.length < before);
  }

  /** Seeds an override without going through the service's refusals. */
  seed(userId: string, notificationType: NotificationType, enabled: boolean) {
    this.rows.push({
      id: `p${String(this.rows.length + 1).padStart(3, "0")}`,
      userId,
      notificationType,
      enabled,
      createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    });
  }
}

let notifications: FakeNotifications;
let preferences: FakePreferences;
let service: NotificationService;

/** Narrows a result, failing loudly instead of leaving `data` possibly absent. */
function expectOk<T>(result: NotificationResult<T>): T {
  if (!result.ok) throw new Error(`expected success but got ${result.code}`);
  return result.data;
}

function expectCreated(outcome: CreateNotificationOutcome): NotificationRecord {
  if (!outcome.created) throw new Error(`expected a notification but it was suppressed`);
  return outcome.notification;
}

beforeEach(() => {
  notifications = new FakeNotifications();
  preferences = new FakePreferences();
  service = new NotificationService({
    notifications: notifications as unknown as ConstructorParameters<
      typeof NotificationService
    >[0]["notifications"],
    preferences: preferences as unknown as ConstructorParameters<
      typeof NotificationService
    >[0]["preferences"],
  });
});

describe("creating a notification", () => {
  it("composes the title and body from the type's templates", async () => {
    const outcome = expectCreated(
      expectOk(
        await service.create({
          userId: ALICE,
          type: "follow_up_due",
          params: { service: "Acme Media", days: 5 },
        }),
      ),
    );

    /**
     * The caller supplied no strings. Everything a person reads was produced by
     * the definition in `notification-types.ts`, which is the whole of D4.
     */
    expect(outcome.title).toBe("Time to follow up with Acme Media");
    expect(outcome.body).toContain("5 days");
    expect(outcome.type).toBe("follow_up_due");
  });

  it("stores the entity link when both halves are supplied", async () => {
    const outcome = expectCreated(
      expectOk(
        await service.create({
          userId: ALICE,
          type: "request_status",
          params: { service: "Acme Media", fromStatus: "sent", toStatus: "awaiting response" },
          entityType: "data_request",
          entityId: "44444444-4444-4444-8444-444444444444",
        }),
      ),
    );

    expect(outcome.entityType).toBe("data_request");
    expect(outcome.entityId).toBe("44444444-4444-4444-8444-444444444444");
  });

  it.each([
    ["a type without an id", { entityType: "data_request" }],
    ["an id without a type", { entityId: "44444444-4444-4444-8444-444444444444" }],
  ])("refuses half an entity link: %s", async (_label, link) => {
    /**
     * The table's paired constraint would refuse it too. Answering here keeps the
     * database as the second gate rather than the first, and half a link renders
     * as a dead control in the panel.
     */
    const result = await service.create({ userId: ALICE, type: "system", ...link });

    expect(result).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(notifications.rows).toHaveLength(0);
  });

  it("refuses an unknown type without touching the store", async () => {
    const result = await service.create({
      userId: ALICE,
      type: "marketing_blast" as NotificationType,
    });

    expect(result).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(notifications.rows).toHaveLength(0);
  });

  it("reports a store outage as unavailable, not as a bad request", async () => {
    notifications.failOn = "create";

    expect(await service.create({ userId: ALICE, type: "system" })).toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
  });
});

describe("content that would carry a restricted value", () => {
  it("is refused, and nothing is stored", async () => {
    /**
     * The guard that should never fire. `service` is caller-supplied — a service
     * name comes from the person's own asset record and cannot be
     * pattern-constrained — so the enforcement is the scan over the composed
     * string, exactly as in `ActivityWriter`. FR-14 and ADR-005 forbid a personal
     * value in a notification body, and this is what makes that structural rather
     * than a rule each future caller has to remember.
     */
    const result = await service.create({
      userId: ALICE,
      type: "follow_up_due",
      params: { service: "alex.person@example.com" },
    });

    expect(result).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(notifications.rows).toHaveLength(0);
  });

  it("is a bad request rather than an outage, so nothing retries it", async () => {
    /**
     * A template or caller bug fails identically forever. Reporting `UNAVAILABLE`
     * would invite a job to retry it until it gave up, and each attempt would
     * compose the same unsafe string again.
     */
    const result = await service.create({
      userId: ALICE,
      type: "security",
      params: { status: "sk-live-0123456789abcdefghij" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_REQUEST");
  });

  it("still allows ordinary copy through, so the guard is not vacuous", async () => {
    const outcome = expectCreated(
      expectOk(
        await service.create({
          userId: ALICE,
          type: "security",
          params: { status: "a new sign-in" },
        }),
      ),
    );

    expect(outcome.body).toContain("a new sign-in");
  });
});

describe("preferences govern what is created", () => {
  it("writes a configurable type when no override exists (D1, D2)", async () => {
    const outcome = expectOk(
      await service.create({ userId: ALICE, type: "finding_new", params: { service: "Acme" } }),
    );

    expect(outcome.created).toBe(true);
    expect(notifications.rows).toHaveLength(1);
  });

  it("declines silently when the person switched the type off", async () => {
    preferences.seed(ALICE, "finding_new", false);

    const outcome = expectOk(
      await service.create({ userId: ALICE, type: "finding_new", params: { service: "Acme" } }),
    );

    /**
     * A **success** that created nothing. Atlas did what the person asked, so a
     * failure code would invite the caller to retry — and a job that retried a
     * suppression would either loop or eventually find a way to write the row.
     */
    expect(outcome).toEqual({ created: false, reason: "preference_disabled" });
    expect(notifications.rows).toHaveLength(0);
  });

  it("honours one person's choice without affecting another's", async () => {
    preferences.seed(ALICE, "system", false);

    expect(expectOk(await service.create({ userId: ALICE, type: "system" })).created).toBe(false);
    expect(expectOk(await service.create({ userId: BOB, type: "system" })).created).toBe(true);
  });

  it("writes security without consulting a preference at all", async () => {
    /**
     * The difference between "cannot be disabled" and "defaults to on". Even with
     * a row present that says false — which the migration makes unrepresentable —
     * the service performs **no lookup**, so there is no value it could honour by
     * mistake.
     */
    preferences.seed(ALICE, "security", false);

    const outcome = expectOk(await service.create({ userId: ALICE, type: "security" }));

    expect(outcome.created).toBe(true);
    expect(preferences.lookups).toEqual([]);
  });

  it("consults exactly one preference for a configurable type", async () => {
    await service.create({ userId: ALICE, type: "follow_up_due", params: { service: "Acme" } });

    expect(preferences.lookups).toEqual([{ userId: ALICE, type: "follow_up_due" }]);
  });
});

describe("setting a preference", () => {
  it("records a choice for a configurable type", async () => {
    const state = expectOk(await service.setPreference(ALICE, "follow_up_due", false));

    expect(state).toEqual({
      type: "follow_up_due",
      enabled: false,
      configurable: true,
      overridden: true,
    });
    expect(preferences.rows).toHaveLength(1);
  });

  it("replaces a previous choice rather than accumulating rows", async () => {
    /**
     * A preference is current state, not history. Two rows for one pair would make
     * the answer depend on which one a query read first; `consents` is the table
     * that appends, because a consent is evidence of an agreement.
     */
    await service.setPreference(ALICE, "system", false);
    await service.setPreference(ALICE, "system", true);

    expect(preferences.rows).toHaveLength(1);
    expect(preferences.rows[0]?.enabled).toBe(true);
  });

  it("refuses a preference for security before touching the store", async () => {
    const result = await service.setPreference(ALICE, "security", false);

    expect(result).toEqual({ ok: false, code: "INVALID_REQUEST" });
    /** The check constraint is the gate behind this; nothing reached it. */
    expect(preferences.rows).toHaveLength(0);
  });

  it("refuses to clear a security preference too", async () => {
    /**
     * Clearing is refused for the same reason as setting: neither is a control the
     * product offers, and answering `INVALID_REQUEST` to both keeps the surface
     * from inferring that one of them is available.
     */
    expect(await service.clearPreference(ALICE, "security")).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
  });

  it("clears an override, returning the type to its declared default", async () => {
    await service.setPreference(ALICE, "finding_new", false);
    expect(await service.isEnabled(ALICE, "finding_new")).toBe(false);

    expect(expectOk(await service.clearPreference(ALICE, "finding_new"))).toEqual({
      cleared: true,
    });

    /**
     * Back to the default rather than pinned to today's value: if the default ever
     * changed, a cleared preference follows it and a stored `true` would not.
     */
    expect(await service.isEnabled(ALICE, "finding_new")).toBe(true);
    expect(preferences.rows).toHaveLength(0);
  });

  it("reports clearing nothing as a success that changed nothing", async () => {
    expect(expectOk(await service.clearPreference(ALICE, "system"))).toEqual({ cleared: false });
  });
});

describe("the preference states Settings renders (ATL-077)", () => {
  it("lists every type, including ones never touched", async () => {
    preferences.seed(ALICE, "system", false);

    const states = expectOk(await service.preferenceStates(ALICE));

    expect(states).toHaveLength(5);
    expect(states.map((s) => s.type).sort()).toEqual([
      "finding_new",
      "follow_up_due",
      "request_status",
      "security",
      "system",
    ]);
  });

  it("distinguishes an explicit choice from a declared default", async () => {
    preferences.seed(ALICE, "system", false);

    const states = expectOk(await service.preferenceStates(ALICE));
    const system = states.find((s) => s.type === "system");
    const findings = states.find((s) => s.type === "finding_new");

    /** What lets a toggle render in the right position without knowing defaults. */
    expect(system).toEqual({
      type: "system",
      enabled: false,
      configurable: true,
      overridden: true,
    });
    expect(findings).toEqual({
      type: "finding_new",
      enabled: true,
      configurable: true,
      overridden: false,
    });
  });

  it("reports security as enabled and not configurable, ignoring any row", async () => {
    preferences.seed(ALICE, "security", false);

    const security = expectOk(await service.preferenceStates(ALICE)).find(
      (s) => s.type === "security",
    );

    expect(security).toEqual({
      type: "security",
      enabled: true,
      configurable: false,
      overridden: false,
    });
  });
});

describe("reading and read state", () => {
  it("counts only this person's unread notifications, uncapped (D7)", async () => {
    for (let i = 0; i < 12; i += 1) {
      notifications.seed(ALICE, "system", new Date(Date.UTC(2026, 0, i + 1)).toISOString());
    }
    notifications.seed(ALICE, "system", new Date(Date.UTC(2026, 1, 1)).toISOString(), "read");
    notifications.seed(BOB, "system", new Date(Date.UTC(2026, 0, 1)).toISOString());

    /** 12, not "9+". Frontend §4.1 calls the cap a display concern. */
    expect(expectOk(await service.unreadCount(ALICE))).toBe(12);
  });

  it("returns notifications newest first", async () => {
    notifications.seed(ALICE, "system", new Date(Date.UTC(2026, 0, 1)).toISOString());
    notifications.seed(ALICE, "system", new Date(Date.UTC(2026, 0, 3)).toISOString());
    notifications.seed(ALICE, "system", new Date(Date.UTC(2026, 0, 2)).toISOString());

    const page = expectOk(await service.list(ALICE));

    expect(page.notifications.map((n) => n.createdAt)).toEqual([
      new Date(Date.UTC(2026, 0, 3)).toISOString(),
      new Date(Date.UTC(2026, 0, 2)).toISOString(),
      new Date(Date.UTC(2026, 0, 1)).toISOString(),
    ]);
  });

  it("offers no next cursor when the last page is exactly full", async () => {
    /**
     * The off-by-one an extra fetched row exists to avoid: asking for `pageSize`
     * and inferring "a full page means more" offers an empty next page whenever
     * the total is an exact multiple.
     */
    notifications.seed(ALICE, "system", new Date(Date.UTC(2026, 0, 1)).toISOString());
    notifications.seed(ALICE, "system", new Date(Date.UTC(2026, 0, 2)).toISOString());

    const page = expectOk(await service.list(ALICE, undefined, 2));

    expect(page.notifications).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("pages through without repeating or skipping a row", async () => {
    for (let day = 1; day <= 5; day += 1) {
      notifications.seed(ALICE, "system", new Date(Date.UTC(2026, 0, day)).toISOString());
    }

    const first = expectOk(await service.list(ALICE, undefined, 2));
    expect(first.nextCursor).not.toBeNull();

    const second = expectOk(await service.list(ALICE, first.nextCursor ?? undefined, 2));
    const third = expectOk(await service.list(ALICE, second.nextCursor ?? undefined, 2));

    const seen = [...first.notifications, ...second.notifications, ...third.notifications].map(
      (n) => n.id,
    );
    expect(new Set(seen).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });

  it("marks one notification read, and says so only once", async () => {
    const created = expectCreated(
      expectOk(await service.create({ userId: ALICE, type: "system" })),
    );

    expect(expectOk(await service.markRead(ALICE, created.id))).toEqual({ id: created.id });
    expect(expectOk(await service.unreadCount(ALICE))).toBe(0);

    /** Already read answers the same as absent — a caller has no different action. */
    expect(await service.markRead(ALICE, created.id)).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("cannot mark another person's notification read", async () => {
    const created = expectCreated(expectOk(await service.create({ userId: BOB, type: "system" })));

    /** Absent and not-yours answer identically — the non-oracle rule (ATL-030). */
    expect(await service.markRead(ALICE, created.id)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(expectOk(await service.unreadCount(BOB))).toBe(1);
  });

  it("marks everything read and reports how many changed", async () => {
    notifications.seed(ALICE, "system", new Date(Date.UTC(2026, 0, 1)).toISOString());
    notifications.seed(ALICE, "system", new Date(Date.UTC(2026, 0, 2)).toISOString());
    notifications.seed(BOB, "system", new Date(Date.UTC(2026, 0, 1)).toISOString());

    expect(expectOk(await service.markAllRead(ALICE))).toBe(2);
    expect(expectOk(await service.unreadCount(ALICE))).toBe(0);
    expect(expectOk(await service.unreadCount(BOB))).toBe(1);
  });

  it("marks every notification pointing at one entity read", async () => {
    /**
     * ADR-005: "Opening a linked entity marks its notification read." Plural,
     * because a status change and a follow-up reminder can both point at one
     * request, and opening it addresses both.
     */
    const link = { entityType: "data_request", entityId: "44444444-4444-4444-8444-444444444444" };
    await service.create({
      userId: ALICE,
      type: "follow_up_due",
      params: { service: "Acme" },
      ...link,
    });
    await service.create({
      userId: ALICE,
      type: "request_status",
      params: { service: "Acme", fromStatus: "sent", toStatus: "awaiting response" },
      ...link,
    });
    await service.create({ userId: ALICE, type: "system" });

    expect(expectOk(await service.markEntityRead(ALICE, link.entityType, link.entityId))).toBe(2);

    /** The unlinked one is untouched — it was not what the person opened. */
    expect(expectOk(await service.unreadCount(ALICE))).toBe(1);
  });

  it("treats opening an entity with no notification as a success", async () => {
    // Entirely normal, and a failure here would make every navigation look broken.
    expect(expectOk(await service.markEntityRead(ALICE, "data_request", "none"))).toBe(0);
  });
});

describe("the 90-day purge (D6, security §14)", () => {
  const now = new Date(Date.UTC(2026, 5, 1));
  const daysBefore = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

  it("removes what is past retention and keeps what is not", async () => {
    notifications.seed(ALICE, "system", daysBefore(NOTIFICATION_RETENTION_DAYS + 1));
    notifications.seed(ALICE, "system", daysBefore(NOTIFICATION_RETENTION_DAYS - 1));
    notifications.seed(BOB, "system", daysBefore(NOTIFICATION_RETENTION_DAYS + 30));

    expect(expectOk(await service.purgeOlderThan(now))).toBe(2);
    expect(notifications.rows).toHaveLength(1);
  });

  it("keeps a notification that is exactly at the boundary", async () => {
    /**
     * The cutoff is exclusive (`created_at < cutoff`), so a row created exactly 90
     * days ago survives one more run. Asserted because an off-by-one here deletes
     * a person's newest expiring notification a day early, and nothing would
     * report it.
     */
    notifications.seed(ALICE, "system", daysBefore(NOTIFICATION_RETENTION_DAYS));

    expect(expectOk(await service.purgeOlderThan(now))).toBe(0);
    expect(notifications.rows).toHaveLength(1);
  });

  it("is idempotent: a second run over the same window removes nothing", async () => {
    notifications.seed(ALICE, "system", daysBefore(200));

    expect(expectOk(await service.purgeOlderThan(now))).toBe(1);
    expect(expectOk(await service.purgeOlderThan(now))).toBe(0);
  });

  it("drains a backlog in bounded batches rather than one unbounded delete", async () => {
    for (let i = 0; i < 5; i += 1) {
      notifications.seed(ALICE, "system", daysBefore(200 + i));
    }

    expect(expectOk(await service.purgeOlderThan(now, 2))).toBe(5);

    /**
     * Three full batches would have been ambiguous; 2 + 2 + 1 shows both that the
     * limit was respected and that the loop stopped when a short batch proved the
     * table was clear. A job that issued one delete for all five would show `[5]`.
     */
    expect(notifications.purgeCalls).toEqual([2, 2, 1]);
  });

  it("reports how far it got when the store fails midway", async () => {
    notifications.failOn = "purge";

    /** Not a corruption: every row that went was past retention. */
    expect(await service.purgeOlderThan(now)).toEqual({ ok: false, code: "UNAVAILABLE" });
  });

  it("purges across all users, because retention is not per-person", async () => {
    notifications.seed(ALICE, "system", daysBefore(120));
    notifications.seed(BOB, "system", daysBefore(120));

    expect(expectOk(await service.purgeOlderThan(now))).toBe(2);
  });

  it("defaults its clock to now, so production passes no second clock", async () => {
    /**
     * ATL-113 removed the second clock from every lifecycle timestamp after an
     * application value lost a race with a database constraint. The parameter
     * exists for tests; the default is what production uses.
     */
    const spy = vi.spyOn(notifications, "purgeOlderThan");

    await service.purgeOlderThan();

    const cutoff = spy.mock.calls[0]?.[0] ?? "";
    const expected = Date.now() - NOTIFICATION_RETENTION_DAYS * DAY_MS;
    expect(Math.abs(new Date(cutoff).getTime() - expected)).toBeLessThan(5_000);
  });
});
