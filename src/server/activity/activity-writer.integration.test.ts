import { beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so they are erased before `vi.mock` hoisting runs. */
import type * as ActivityRepositoryModule from "@/server/repositories/activity-event-repository";
import type * as AuditRepositoryModule from "@/server/repositories/audit-event-repository";

/**
 * ATL-069 — the activity writer and the shared emitter.
 *
 * Two things the ticket asks to be proven: that summaries reaching storage carry
 * no restricted values, and that audit and activity are emitted together for a
 * request transition.
 *
 * `activity_events` and `audit_events` are both faked at the repository, so this
 * exercises the writer's own guards. The RLS and constraint halves run against a
 * real database in `tests/integration/activity-events-rls.test.ts`.
 */

vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 3).toString("base64") },
}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

interface ActivityRow {
  id: string;
  userId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

const activityRows: ActivityRow[] = [];
const auditRows: { eventType: string; entityId?: string }[] = [];
/** Set to make the activity insert fail, for the partial-failure policy. */
const control = { activityFails: false };

vi.mock("@/server/repositories/activity-event-repository", async () => {
  const actual = await vi.importActual<typeof ActivityRepositoryModule>(
    "@/server/repositories/activity-event-repository",
  );
  let next = 1;

  return {
    ...actual,
    ActivityEventRepository: class {
      append(input: {
        userId: string;
        eventType: string;
        summary: string;
        entityType?: string;
        entityId?: string;
        metadata?: Record<string, unknown>;
      }) {
        if (control.activityFails) return Promise.reject(new actual.ActivityStoreError());

        const row: ActivityRow = {
          id: `act-${next++}`,
          userId: input.userId,
          eventType: input.eventType,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          summary: input.summary,
          metadata: input.metadata ?? {},
          occurredAt: new Date().toISOString(),
        };
        activityRows.push(row);
        return Promise.resolve(row);
      }
    },
  };
});

vi.mock("@/server/repositories/audit-event-repository", async () => {
  const actual = await vi.importActual<typeof AuditRepositoryModule>(
    "@/server/repositories/audit-event-repository",
  );
  let next = 1;

  return {
    ...actual,
    AuditEventRepository: class {
      findLatestForSubject() {
        return Promise.resolve(null);
      }
      append(record: { eventType: string; entityId: string | null }) {
        auditRows.push({
          eventType: record.eventType,
          ...(record.entityId ? { entityId: record.entityId } : {}),
        });
        return Promise.resolve({ ...record, id: `evt-${next++}` });
      }
    },
  };
});

const { ActivityWriter, UnknownActivityEventTypeError, UnsafeActivitySummaryError } =
  await import("./activity-writer");
const { AuditWriter, emitEvent } = await import("@/server/audit/audit-writer");
const { maskEmail } = await import("@/lib/formatting/mask");
const { setLogSink } = await import("@/lib/telemetry/logger");

const ALICE = "aaaaaaaa-0000-4000-8000-00000000000a";
const REQUEST_ID = "cccccccc-0000-4000-8000-00000000000c";

const writer = () => new ActivityWriter({} as never);

beforeEach(() => {
  activityRows.length = 0;
  auditRows.length = 0;
  control.activityFails = false;
  setLogSink(() => {});
});

describe("event vocabulary enforcement", () => {
  it("writes a known event type", async () => {
    const row = await writer().write({
      userId: ALICE,
      type: "asset.created",
      params: { service: "Acme" },
    });

    expect(row.summary).toBe("Added Acme");
    expect(activityRows).toHaveLength(1);
  });

  it("rejects an unknown event type", async () => {
    // ATL-069: "unknown types rejected". A row nobody can read or filter is
    // worse than a loud failure at the call site.
    await expect(
      writer().write({ userId: ALICE, type: "asset.invented" as never }),
    ).rejects.toBeInstanceOf(UnknownActivityEventTypeError);

    expect(activityRows).toHaveLength(0);
  });
});

describe("summaries reaching storage", () => {
  it("stores the composed sentence, not a caller-supplied string", async () => {
    // There is no parameter that accepts free text — the shape of the API is
    // the guarantee.
    const row = await writer().write({
      userId: ALICE,
      type: "request.transitioned",
      params: { service: "Acme", fromStatus: "sent", toStatus: "awaiting response" },
    });

    expect(row.summary).toBe("Data request to Acme moved from sent to awaiting response");
  });

  it("permits a masked identifier", async () => {
    const row = await writer().write({
      userId: ALICE,
      type: "request.sent",
      params: { service: "Acme", maskedIdentifier: maskEmail("privacy@acme.example") },
    });

    expect(row.summary).toContain("p••••y@acme.example");
    expect(row.summary).not.toContain("privacy@acme.example");
  });

  it("refuses an identifier that was not actually masked", async () => {
    /**
     * The parameter name is the contract, so it is enforced rather than
     * trusted. A caller passing a raw address here would otherwise publish it,
     * and the parameter name would make that look deliberate.
     */
    await expect(
      writer().write({
        userId: ALICE,
        type: "request.sent",
        params: { service: "Acme", maskedIdentifier: "privacy@acme.example" },
      }),
    ).rejects.toBeInstanceOf(UnsafeActivitySummaryError);

    expect(activityRows).toHaveLength(0);
  });

  it.each([
    ["an email in a service name", { service: "dana@example.com" }],
    ["a phone number in a label", { label: "+1 (415) 555-4821" }],
    ["a credential in a status", { fromStatus: "sk_live_9f2b7c1d", toStatus: "sent" }],
  ])("refuses %s", async (_name, params) => {
    // Templates interpolate verbatim, so this guard is what stops a restricted
    // value that arrived through a legitimately-named parameter.
    await expect(
      writer().write({ userId: ALICE, type: "request.transitioned", params }),
    ).rejects.toBeInstanceOf(UnsafeActivitySummaryError);

    expect(activityRows).toHaveLength(0);
  });

  it("stores nothing when a summary is refused", async () => {
    await expect(
      writer().write({ userId: ALICE, type: "asset.created", params: { service: "a@b.com" } }),
    ).rejects.toThrow();

    expect(JSON.stringify(activityRows)).not.toContain("a@b.com");
  });
});

describe("metadata", () => {
  it("stores allowlisted metadata", async () => {
    const row = await writer().write({
      userId: ALICE,
      type: "finding.resolved",
      params: { service: "Acme" },
      metadata: { severity: "high", count: 2 },
    });

    expect(row.metadata).toEqual({ severity: "high", count: 2 });
  });

  it("drops metadata outside the ATL-068 allowlist", async () => {
    const row = await writer().write({
      userId: ALICE,
      type: "asset.created",
      params: { service: "Acme" },
      metadata: { severity: "high", email: "dana@example.com", note: "free text" },
    });

    expect(row.metadata).toEqual({ severity: "high" });
    expect(JSON.stringify(activityRows)).not.toContain("dana@example.com");
  });

  it("reports filtering as a counted warning", async () => {
    const records: { event: string; count?: number }[] = [];
    setLogSink((record) => records.push(record));

    await writer().write({
      userId: ALICE,
      type: "asset.created",
      params: { service: "Acme" },
      metadata: { email: "dana@example.com" },
    });

    const warning = records.find((r) => r.event === "activity.metadata_filtered");
    expect(warning?.count).toBe(1);
    // Counted, never echoed.
    expect(JSON.stringify(records)).not.toContain("dana@example.com");
  });
});

describe("the shared emitter", () => {
  const auditWriter = () => new AuditWriter({} as never);

  it("emits audit and activity together for a request transition", async () => {
    /**
     * The integration the ticket names explicitly. ADR-006 requires both records
     * to be written "from a single call site so the two cannot drift", and a
     * request transition is the case where both matter: it is user-meaningful
     * and security-relevant.
     */
    const result = await emitEvent(
      {
        audit: {
          userId: ALICE,
          eventType: "request.transitioned",
          actorType: "user",
          entityType: "request",
          entityId: REQUEST_ID,
          context: { fromStatus: "sent", toStatus: "completed" },
        },
        activity: {
          userId: ALICE,
          type: "request.transitioned",
          params: { service: "Acme", fromStatus: "sent", toStatus: "completed" },
          entityType: "request",
          entityId: REQUEST_ID,
          metadata: { fromStatus: "sent", toStatus: "completed" },
        },
      },
      auditWriter(),
      writer(),
    );

    expect(auditRows).toHaveLength(1);
    expect(activityRows).toHaveLength(1);
    expect(auditRows[0]?.eventType).toBe("request.transitioned");
    expect(result.activity?.summary).toBe("Data request to Acme moved from sent to completed");
    // Both point at the same entity, so the two records are correlatable.
    expect(auditRows[0]?.entityId).toBe(REQUEST_ID);
    expect(activityRows[0]?.entityId).toBe(REQUEST_ID);
  });

  it("writes audit only when no activity is requested", async () => {
    // Some audited events — DEK destruction, operator elevation — have no
    // user-facing counterpart. Omitting activity is a statement, not a default.
    await emitEvent(
      {
        audit: { userId: ALICE, eventType: "encryption.dek_destroyed", actorType: "system" },
      },
      auditWriter(),
      writer(),
    );

    expect(auditRows).toHaveLength(1);
    expect(activityRows).toHaveLength(0);
  });

  it("keeps the audit record when the activity write fails", async () => {
    /**
     * The partial-failure policy. These are two inserts and PostgREST cannot
     * open a transaction, so this state is unavoidable rather than a bug.
     * A missing timeline row is cosmetic; failing the caller would turn a
     * display problem into a data problem.
     */
    const records: { level: string; event: string }[] = [];
    setLogSink((record) => records.push(record));
    control.activityFails = true;

    const result = await emitEvent(
      {
        audit: { userId: ALICE, eventType: "request.transitioned", actorType: "user" },
        activity: { userId: ALICE, type: "request.transitioned", params: { service: "Acme" } },
      },
      auditWriter(),
      writer(),
    );

    expect(auditRows).toHaveLength(1);
    expect(result.activity).toBeNull();
    // "Best effort" must mean observably best effort.
    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", event: "activity.write_failed" }),
    );
  });

  it("does not write activity when the audit write fails", async () => {
    // Audit is written first and its failure propagates, so a timeline row can
    // never describe an event with no security record behind it.
    const failing = {
      write: () => Promise.reject(new Error("audit store down")),
    } as unknown as InstanceType<typeof AuditWriter>;

    await expect(
      emitEvent(
        {
          audit: { userId: ALICE, eventType: "request.transitioned", actorType: "user" },
          activity: { userId: ALICE, type: "request.transitioned", params: { service: "Acme" } },
        },
        failing,
        writer(),
      ),
    ).rejects.toThrow("audit store down");

    expect(activityRows).toHaveLength(0);
  });
});
