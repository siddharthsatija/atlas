import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Type-only, so it is erased before `vi.mock` hoisting runs and cannot pull the
 * real repository into the module graph ahead of its mock.
 */
import type * as AuditRepositoryModule from "@/server/repositories/audit-event-repository";

/**
 * ATL-103 — audit writer, context allowlist, and chain verification.
 *
 * Runs against a fake store that mirrors the migration's constraints, including
 * the `(subject_ref, prev_hash)` unique index. Mirroring that index matters more
 * than usual here: it is the mechanism that keeps the chain linear under
 * concurrency, so a fake that ignored it would let the writer's retry loop pass
 * a test it would fail in production.
 *
 * The RLS and privilege half — deny-all, INSERT/SELECT only, UPDATE/DELETE
 * rejection — needs a real database and lives in
 * `tests/integration/audit-events-rls.test.ts`.
 */

const HMAC_KEY = Buffer.alloc(32, 7).toString("base64");

vi.mock("@/config/env", () => ({ env: { AUDIT_HMAC_KEY: HMAC_KEY } }));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

interface FakeRow {
  id: string;
  event_type: string;
  subject_ref: string;
  actor_type: string;
  entity_type: string | null;
  entity_id: string | null;
  context_json: Record<string, unknown>;
  occurred_at: string;
  prev_hash: string;
  event_hash: string;
}

class UniqueViolation extends Error {
  code = "23505";
}

class FakeStore {
  rows: FakeRow[] = [];
  private nextId = 1;
  /** Set to simulate a concurrent writer claiming the tail first. */
  onBeforeAppend: (() => void) | null = null;

  append(row: Omit<FakeRow, "id">): FakeRow {
    this.onBeforeAppend?.();

    // Mirrors `audit_events_chain_link_unique`.
    if (this.rows.some((r) => r.subject_ref === row.subject_ref && r.prev_hash === row.prev_hash)) {
      throw new UniqueViolation();
    }
    // Mirrors `audit_events_event_hash_unique`.
    if (this.rows.some((r) => r.event_hash === row.event_hash)) throw new UniqueViolation();

    const stored: FakeRow = { ...row, id: `evt-${this.nextId++}` };
    this.rows.push(stored);
    return stored;
  }

  forSubject(subjectRef: string): FakeRow[] {
    return this.rows.filter((r) => r.subject_ref === subjectRef);
  }
}

let store: FakeStore;

vi.mock("@/server/repositories/audit-event-repository", async () => {
  const actual = await vi.importActual<typeof AuditRepositoryModule>(
    "@/server/repositories/audit-event-repository",
  );

  const toRecord = (row: FakeRow) => ({
    id: row.id,
    eventType: row.event_type,
    subjectRef: row.subject_ref,
    actorType: row.actor_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    context: row.context_json,
    occurredAt: row.occurred_at,
    prevHash: row.prev_hash,
    eventHash: row.event_hash,
  });

  return {
    ...actual,
    AuditEventRepository: class {
      findLatestForSubject(subjectRef: string) {
        const rows = [...store.forSubject(subjectRef)].sort((a, b) =>
          a.occurred_at === b.occurred_at
            ? a.id < b.id
              ? 1
              : -1
            : a.occurred_at < b.occurred_at
              ? 1
              : -1,
        );
        return Promise.resolve(rows[0] ? toRecord(rows[0]) : null);
      }
      append(record: {
        eventType: string;
        subjectRef: string;
        actorType: string;
        entityType: string | null;
        entityId: string | null;
        context: Record<string, unknown>;
        occurredAt: string;
        prevHash: string;
        eventHash: string;
      }) {
        try {
          return Promise.resolve(
            toRecord(
              store.append({
                event_type: record.eventType,
                subject_ref: record.subjectRef,
                actor_type: record.actorType,
                entity_type: record.entityType,
                entity_id: record.entityId,
                context_json: record.context,
                occurred_at: record.occurredAt,
                prev_hash: record.prevHash,
                event_hash: record.eventHash,
              }),
            ),
          );
        } catch (error) {
          if ((error as { code?: string }).code === "23505") {
            return Promise.reject(new actual.AuditChainConflictError());
          }
          return Promise.reject(new actual.AuditWriteError());
        }
      }
      listForSubject(subjectRef: string) {
        return Promise.resolve(
          [...store.forSubject(subjectRef)]
            .sort((a, b) =>
              a.occurred_at === b.occurred_at
                ? a.id < b.id
                  ? -1
                  : 1
                : a.occurred_at < b.occurred_at
                  ? -1
                  : 1,
            )
            .map(toRecord),
        );
      }
      listSubjects() {
        return Promise.resolve([...new Set(store.rows.map((r) => r.subject_ref))]);
      }
    },
  };
});

const { AuditWriter, emitEvent } = await import("./audit-writer");
const { AuditChainVerifier } = await import("./chain-verification");
const {
  GENESIS_HASH,
  subjectRefFor,
  AUDIT_EVENT_TYPES,
  isAuditEventType,
  canonicalise,
  hashEvent,
} = await import("./audit-event");

const ALICE = "aaaaaaaa-0000-4000-8000-00000000000a";
const BOB = "bbbbbbbb-0000-4000-8000-00000000000b";

const writer = () => new AuditWriter({} as never);
const verifier = () => new AuditChainVerifier({} as never);

beforeEach(() => {
  store = new FakeStore();
});

describe("subject pseudonymisation", () => {
  it("never stores the user id", async () => {
    await writer().write({ userId: ALICE, eventType: "auth.signed_in", actorType: "user" });

    const serialised = JSON.stringify(store.rows);
    expect(serialised).not.toContain(ALICE);
  });

  it("is stable for the same user and distinct across users", () => {
    expect(subjectRefFor(ALICE)).toBe(subjectRefFor(ALICE));
    expect(subjectRefFor(ALICE)).not.toBe(subjectRefFor(BOB));
  });

  it("is a 64-character hex digest, matching the column constraint", () => {
    expect(subjectRefFor(ALICE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is keyed, so it cannot be reproduced from the user id alone", async () => {
    // A bare sha256(userId) would be trivially reversible over the UUID space.
    const { createHash } = await import("node:crypto");
    const unkeyed = createHash("sha256").update(ALICE).digest("hex");
    expect(subjectRefFor(ALICE)).not.toBe(unkeyed);
  });
});

describe("context allowlist", () => {
  it("keeps allowlisted keys", async () => {
    const { event } = await writer().write({
      userId: ALICE,
      eventType: "request.transitioned",
      actorType: "user",
      context: { fromStatus: "draft", toStatus: "sent", requestId: "req-1", count: 3 },
    });

    expect(event.context).toEqual({
      fromStatus: "draft",
      toStatus: "sent",
      requestId: "req-1",
      count: 3,
    });
  });

  /**
   * The ADR-006 "do not record" list, one case each.
   *
   * These are the values that would turn the audit log into a second sensitive
   * dataset — the outcome the pseudonymous design exists to avoid.
   */
  const forbidden: { name: string; context: Record<string, unknown> }[] = [
    { name: "an email", context: { email: "dana@example.com" } },
    { name: "a raw user id", context: { userId: ALICE } },
    { name: "a request body", context: { body: '{"draft":"delete my account"}' } },
    { name: "an AI prompt", context: { prompt: "system prompt text" } },
    { name: "a token", context: { accessToken: "secret-token-value" } },
    { name: "export contents", context: { export: "name,email\nDana,dana@example.com" } },
    { name: "a personal field value", context: { value: "1 Example Street" } },
  ];

  for (const { name, context } of forbidden) {
    it(`drops ${name} and counts it`, async () => {
      const result = await writer().write({
        userId: ALICE,
        eventType: "export.requested",
        actorType: "user",
        context,
      });

      const key = Object.keys(context)[0]!;
      expect(result.droppedKeys).toContain(key);
      expect(result.event.context).not.toHaveProperty(key);
      expect(JSON.stringify(store.rows)).not.toContain("dana@example.com");
    });
  }

  it("removes an allowlisted key whose value fails its shape check", async () => {
    const result = await writer().write({
      userId: ALICE,
      eventType: "export.requested",
      actorType: "user",
      context: { requestId: "dana@example.com" },
    });

    expect(result.redactedKeys).toContain("requestId");
    expect(result.event.context).not.toHaveProperty("requestId");
  });
});

describe("hash chain", () => {
  it("anchors the first event to the genesis hash", async () => {
    const { event } = await writer().write({
      userId: ALICE,
      eventType: "auth.signed_in",
      actorType: "user",
    });

    expect(event.prevHash).toBe(GENESIS_HASH);
  });

  it("links each event to its predecessor", async () => {
    const w = writer();
    const first = await w.write({ userId: ALICE, eventType: "auth.signed_in", actorType: "user" });
    const second = await w.write({
      userId: ALICE,
      eventType: "auth.signed_out",
      actorType: "user",
    });

    expect(second.event.prevHash).toBe(first.event.eventHash);
  });

  it("keeps each subject's chain independent", async () => {
    const w = writer();
    await w.write({ userId: ALICE, eventType: "auth.signed_in", actorType: "user" });
    const bob = await w.write({ userId: BOB, eventType: "auth.signed_in", actorType: "user" });

    // Bob's first event is his genesis, unaffected by Alice's chain.
    expect(bob.event.prevHash).toBe(GENESIS_HASH);
  });

  it("is order-independent for context keys", () => {
    // Two events differing only in context key order must hash identically, or
    // verification would fail for reasons unrelated to tampering.
    const base = {
      eventType: "export.requested" as const,
      subjectRef: subjectRefFor(ALICE),
      actorType: "user" as const,
      entityType: null,
      entityId: null,
      occurredAt: "2026-08-04T10:00:00.000Z",
      prevHash: GENESIS_HASH,
    };

    expect(canonicalise({ ...base, context: { a: 1, b: 2 } })).toBe(
      canonicalise({ ...base, context: { b: 2, a: 1 } }),
    );
  });

  it("retries and stays linear when a concurrent writer claims the tail", async () => {
    const w = writer();
    await w.write({ userId: ALICE, eventType: "auth.signed_in", actorType: "user" });

    // A competing writer commits between our read and our insert, exactly once.
    // Its event is properly hashed, as a real concurrent writer's would be —
    // a fabricated hash would test the tamper detector instead of the retry.
    let interfered = false;
    let rivalHash = "";
    store.onBeforeAppend = () => {
      if (interfered) return;
      interfered = true;
      const tail = store.rows[store.rows.length - 1]!;
      const rival: FakeRow = {
        ...tail,
        id: "evt-rival",
        event_type: "auth.session_revoked",
        prev_hash: tail.event_hash,
        occurred_at: new Date(Date.parse(tail.occurred_at) + 1).toISOString(),
        event_hash: "",
      };
      rival.event_hash = hashEvent({
        eventType: rival.event_type as never,
        subjectRef: rival.subject_ref,
        actorType: rival.actor_type as never,
        entityType: rival.entity_type,
        entityId: rival.entity_id,
        context: rival.context_json,
        occurredAt: rival.occurred_at,
        prevHash: rival.prev_hash,
      });
      rivalHash = rival.event_hash;
      store.rows.push(rival);
    };

    const result = await w.write({
      userId: ALICE,
      eventType: "auth.signed_out",
      actorType: "user",
    });

    // It adopted the rival's event as its predecessor rather than forking, so
    // the chain is still linear and still verifies.
    expect(result.event.prevHash).toBe(rivalHash);
    expect(await verifier().verifySubject(subjectRefFor(ALICE))).toEqual([]);
  });
});

describe("chain verification", () => {
  async function seedChain(): Promise<void> {
    const w = writer();
    await w.write({ userId: ALICE, eventType: "auth.signed_in", actorType: "user" });
    await w.write({ userId: ALICE, eventType: "export.requested", actorType: "user" });
    await w.write({ userId: ALICE, eventType: "auth.signed_out", actorType: "user" });
  }

  it("passes on an untampered chain", async () => {
    await seedChain();
    const result = await verifier().verifyAll();

    expect(result.faults).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.eventsChecked).toBe(3);
  });

  it("detects a modified field", async () => {
    await seedChain();
    // The tamper an insider would attempt: rewrite what happened, leave the
    // hashes alone because recomputing them means recomputing the whole chain.
    store.rows[1]!.event_type = "auth.signed_in";

    const result = await verifier().verifyAll();
    expect(result.ok).toBe(false);
    expect(result.faults.map((f) => f.kind)).toContain("hash_mismatch");
  });

  it("detects a modified context value", async () => {
    await seedChain();
    store.rows[1]!.context_json = { count: 999 };

    expect((await verifier().verifyAll()).faults.map((f) => f.kind)).toContain("hash_mismatch");
  });

  it("detects a deleted event", async () => {
    await seedChain();
    store.rows.splice(1, 1);

    const result = await verifier().verifyAll();
    expect(result.ok).toBe(false);
    expect(result.faults.map((f) => f.kind)).toContain("broken_link");
  });

  it("is independent of storage order, because the links define the order", async () => {
    await seedChain();
    const [first, second, third] = store.rows;
    store.rows = [first!, third!, second!];

    expect((await verifier().verifyAll()).ok).toBe(true);
  });

  it("detects a tampered timestamp", async () => {
    // `occurred_at` is inside the hash, so backdating an event to change its
    // apparent position cannot be done without breaking it.
    await seedChain();
    store.rows[1]!.occurred_at = "2020-01-01T00:00:00.000Z";

    expect((await verifier().verifyAll()).faults.map((f) => f.kind)).toContain("hash_mismatch");
  });

  it("detects a forked chain", async () => {
    // Two events claiming the same predecessor. The unique index makes this
    // unreachable through the writer, so it means direct database modification.
    await seedChain();
    store.rows.push({ ...store.rows[1]!, id: "evt-fork" });

    expect((await verifier().verifyAll()).faults.map((f) => f.kind)).toContain("duplicate_link");
  });

  it("does not report a fault for events written in the same millisecond", async () => {
    /**
     * REGRESSION.
     *
     * An earlier implementation ordered the chain by `(occurred_at, id)` and
     * compared adjacent events. `occurred_at` is millisecond-resolution, so two
     * events for one subject can tie, and `id` is a random UUID — meaning the
     * pair came back in arbitrary order and verification reported `bad_genesis`
     * and `broken_link` on a chain nobody had touched.
     *
     * A verification job that raises false alarms gets muted, and a muted job
     * detects no real tampering either. Verification now walks the links, which
     * carry their own order.
     */
    const w = writer();
    const when = new Date("2026-08-04T10:00:00.000Z");
    await w.write({
      userId: ALICE,
      eventType: "auth.signed_in",
      actorType: "user",
      occurredAt: when,
    });
    await w.write({
      userId: ALICE,
      eventType: "auth.signed_out",
      actorType: "user",
      occurredAt: when,
    });

    // Force the UUID tiebreak to land the "wrong" way round.
    store.rows[0]!.id = "zzz";
    store.rows[1]!.id = "aaa";

    expect(await verifier().verifySubject(subjectRefFor(ALICE))).toEqual([]);
  });

  it("detects a forged genesis", async () => {
    await seedChain();
    store.rows.splice(0, 1);

    // Removing the first event leaves a chain whose head no longer starts at
    // genesis — the signature of a truncated history.
    const result = await verifier().verifyAll();
    expect(result.faults.map((f) => f.kind)).toContain("bad_genesis");
  });

  it("reports every fault, not just the earliest", async () => {
    await seedChain();
    store.rows[0]!.event_type = "export.expired";
    store.rows[1]!.event_type = "export.expired";

    // A responder needs the blast radius, not the first symptom.
    const result = await verifier().verifyAll();
    expect(result.faults.length).toBeGreaterThan(1);
  });

  it("does not log a subject reference", async () => {
    const { setLogSink } = await import("@/lib/telemetry/logger");
    const records: unknown[] = [];
    setLogSink((record) => records.push(record));

    await seedChain();
    await verifier().verifyAll();
    setLogSink(null);

    // Pseudonymous is not anonymous, and a log sink is lower-trust than the
    // table it describes.
    expect(JSON.stringify(records)).not.toContain(subjectRefFor(ALICE));
  });
});

describe("event inventory", () => {
  it("covers the security §12 categories", () => {
    const prefixes = new Set(AUDIT_EVENT_TYPES.map((t) => t.split(".")[0]));
    for (const required of [
      "auth",
      "export",
      "account",
      "encryption",
      "request",
      "consent",
      "personal_field",
      "operator",
    ]) {
      expect(prefixes).toContain(required);
    }
  });

  it("rejects an unknown event type", () => {
    expect(isAuditEventType("something.invented")).toBe(false);
  });
});

describe("emitEvent", () => {
  it("writes the audit half through the shared call site", async () => {
    const result = await emitEvent(
      { audit: { userId: ALICE, eventType: "consent.granted", actorType: "user" } },
      writer(),
    );

    expect(result.event.eventType).toBe("consent.granted");
    expect(store.rows).toHaveLength(1);
  });
});
