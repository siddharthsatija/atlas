import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * ATL-039 — the finding service, against the real repository.
 *
 * The three things the ticket names as testable here: authorization, the
 * recommended ordering as the service actually returns it, and invalid
 * transitions. The ordering rule itself is covered purely in
 * `src/lib/findings/recommendation.test.ts`; what is asserted here is that the
 * service applies it and that a user's actions are recorded as *theirs*.
 *
 * The real `FindingService`, `PrivacyFindingRepository` and `ActivityWriter` run;
 * only PostgREST is faked. The engine is not involved — nothing here evaluates a
 * rule, which is the separation ATL-039 exists to keep.
 */

vi.mock("@/config/env", () => ({
  env: {
    ATLAS_KEK: Buffer.alloc(32, 9).toString("base64"),
    ATLAS_KEK_VERSION: 1,
    AUDIT_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
  },
}));

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

const tables = new Map<string, Map<string, Row>>();
const tableOf = (name: string) => {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name) as Map<string, Row>;
};

/**
 * The BEFORE UPDATE triggers from `20260811090000`, modelled here (ATL-113).
 *
 * Not decoration. Since that migration the database, not the caller, writes
 * `updated_at`, `last_verified_at` and `resolved_at` — so a fake that merely
 * assigned the patch would let these tests pass while asserting behaviour the
 * real schema no longer has. The point of the change is that the timestamp and
 * the constraint judging it share one clock; a double that ignores the triggers
 * cannot show that.
 */
function applyUpdateTriggers(table: string, row: Row, patch: Row): void {
  const before = { ...row };
  Object.assign(row, patch);

  // `set_updated_at`, attached to both tables.
  row.updated_at = new Date().toISOString();

  // `set_asset_review_time`: the sentinel resolves to the database clock.
  if (table === "digital_assets" && row.last_verified_at === "infinity") {
    row.last_verified_at = new Date().toISOString();
  }

  // `set_finding_resolution_time`: stamped on the transition into a closed
  // status, and only then — reopening clears it and must stay cleared.
  if (
    table === "privacy_findings" &&
    row.status !== before.status &&
    (row.status === "resolved" || row.status === "dismissed")
  ) {
    row.resolved_at = new Date().toISOString();
  }
}

function createDb(): SupabaseClient<Database> {
  const builder = (tableName: string) => {
    const store = tableOf(tableName);
    let operation: "select" | "insert" | "update" | "delete" = "select";
    let pending: Row = {};
    const filters: { column: string; value: unknown }[] = [];
    const inFilters: { column: string; values: unknown[] }[] = [];

    const matching = () =>
      [...store.values()].filter(
        (row) =>
          filters.every((f) => row[f.column] === f.value) &&
          inFilters.every((f) => f.values.includes(row[f.column])),
      );

    const run = () => {
      if (operation === "insert") return { data: [{ ...pending }], error: null };
      if (operation === "update") {
        const matched = matching();
        for (const row of matched) applyUpdateTriggers(tableName, row, pending);
        return { data: matched.map((row) => ({ ...row })), error: null };
      }
      if (operation === "delete") {
        const matched = matching();
        for (const row of matched) store.delete(String(row.id));
        return { data: matched.map((row) => ({ ...row })), error: null };
      }
      return { data: matching().map((row) => ({ ...row })), error: null };
    };

    const self = {
      select: () => self,
      eq: (column: string, value: unknown) => {
        filters.push({ column, value });
        return self;
      },
      in: (column: string, values: unknown[]) => {
        inFilters.push({ column, values });
        return self;
      },
      is: (column: string, value: unknown) => {
        filters.push({ column, value });
        return self;
      },
      or: () => self,
      order: () => self,
      limit: () => self,
      insert: (values: Row) => {
        operation = "insert";
        const now = new Date().toISOString();
        pending = { id: randomUUID(), created_at: now, updated_at: now, ...values };
        store.set(String(pending.id), { ...pending });
        return self;
      },
      update: (values: Row) => {
        operation = "update";
        pending = values;
        return self;
      },
      delete: () => {
        operation = "delete";
        return self;
      },
      single: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
      maybeSingle: () =>
        Promise.resolve({
          data: operation === "select" ? (matching()[0] ?? null) : (run().data[0] ?? null),
          error: null,
        }),
      then: (resolve: (result: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };

    return self;
  };

  return { from: (table: string) => builder(table) } as unknown as SupabaseClient<Database>;
}

const { FindingService, FOOTPRINT_WIDE_LABEL } = await import("./finding-service");
const { ActivityWriter } = await import("@/server/activity/activity-writer");
const { PrivacyFindingRepository } =
  await import("@/server/repositories/privacy-finding-repository");

let service: InstanceType<typeof FindingService>;
const scored: { userId: string; reason: string }[] = [];

const activity = () => [...tableOf("activity_events").values()];
const stored = (id: string) => tableOf("privacy_findings").get(id);

/**
 * The same fake, with every `update()` payload recorded (ATL-113).
 *
 * Wrapping rather than reimplementing: the rows still move exactly as they do
 * everywhere else in this file, so what is captured is the real patch the
 * repository built, not a second model of it.
 */
function dbWithUpdateSpy(patches: Row[]): SupabaseClient<Database> {
  const db = createDb();
  const from = db.from.bind(db) as unknown as (table: string) => Record<string, unknown>;

  return {
    from: (table: string) => {
      const builder = from(table);
      const update = builder.update as (values: Row) => unknown;
      builder.update = (values: Row) => {
        patches.push({ ...values });
        return update(values);
      };
      return builder;
    },
  } as unknown as SupabaseClient<Database>;
}

/** A service wired to the spying client, with the side-effects stubbed out. */
function serviceSpying(patches: Row[]): InstanceType<typeof FindingService> {
  const db = dbWithUpdateSpy(patches);
  return new FindingService(db, new ActivityWriter(db), { enqueue: () => Promise.resolve() });
}

beforeEach(() => {
  tables.clear();
  scored.length = 0;
  const db = createDb();
  service = new FindingService(db, new ActivityWriter(db), {
    enqueue: (request) => {
      scored.push(request);
      return Promise.resolve();
    },
  });
});

/** Seeds an asset so a finding can name it. */
const seedAsset = (serviceName: string, overrides: Row = {}): string => {
  const id = randomUUID();
  tableOf("digital_assets").set(id, {
    id,
    user_id: ALICE,
    service_name: serviceName,
    category: "entertainment",
    status: "active",
    source_type: "manual",
    confidence: "medium",
    last_verified_at: null,
    service_domain: null,
    source_label: null,
    notes: null,
    metadata_json: {},
    account_identifier_encrypted: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
  return id;
};

/** Seeds a finding the way the engine would have written it. */
const seed = (overrides: Row = {}): string => {
  const id = randomUUID();
  tableOf("privacy_findings").set(id, {
    id,
    user_id: ALICE,
    asset_id: null,
    finding_type: "hygiene",
    rule_id: "R-001",
    rule_version: "rules-v1",
    dedup_key: `key-${id}`,
    title: "A service has not been reviewed recently",
    description: "Records drift as services change what they collect.",
    severity: "medium",
    confidence: "medium",
    source_type: "manual",
    source_reference: "R-001@rules-v1",
    evidence_summary: "Last reviewed 2025-01-01.",
    evidence_refs_json: {},
    recommended_action: "Review what this service holds.",
    input_hash: null,
    status: "open",
    resolved_by: null,
    resolved_at: null,
    // Present and null, as the column actually is on an open finding (ATL-042).
    // Omitting it would let the record read `undefined` where the schema
    // guarantees `null`, and a test could then pass on the wrong value.
    resolution_action: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  });
  return id;
};

const unwrap = <T>(result: { ok: true; data: T } | { ok: false; code: string }): T => {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.data;
};

describe("authorization", () => {
  it("lists only the caller's findings", async () => {
    const mine = seed();
    seed({ user_id: BOB });

    const listed = unwrap(await service.listFindings(ALICE));

    expect(listed.map((finding) => finding.id)).toEqual([mine]);
  });

  it("refuses to read another user's finding", async () => {
    const theirs = seed({ user_id: BOB });

    const result = await service.getFinding(ALICE, theirs);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("NOT_FOUND");
  });

  it("answers a missing finding identically, so an id cannot be probed", async () => {
    // A FORBIDDEN on a record you do not own confirms it exists.
    const foreign = await service.getFinding(ALICE, seed({ user_id: BOB }));
    const missing = await service.getFinding(ALICE, randomUUID());

    expect(foreign.ok === false && foreign.code).toBe(missing.ok === false && missing.code);
  });

  it("refuses to resolve or dismiss another user's finding", async () => {
    const theirs = seed({ user_id: BOB });

    expect((await service.resolveFinding(ALICE, theirs, "reviewed")).ok).toBe(false);
    expect((await service.dismissFinding(ALICE, theirs)).ok).toBe(false);
    expect(stored(theirs)?.status).toBe("open");
  });

  it("recommends only the caller's findings", async () => {
    const mine = seed();
    seed({ user_id: BOB });

    const recommended = unwrap(await service.calculateRecommendations(ALICE));

    expect(recommended.map((finding) => finding.id)).toEqual([mine]);
  });
});

describe("listing", () => {
  it("returns findings in recommended order", async () => {
    const low = seed({ severity: "low" });
    const critical = seed({ severity: "critical" });
    const high = seed({ severity: "high" });

    const listed = unwrap(await service.listFindings(ALICE));

    expect(listed.map((finding) => finding.id)).toEqual([critical, high, low]);
  });

  it("filters by status", async () => {
    const open = seed();
    seed({ status: "dismissed", resolved_by: "user", resolved_at: "2026-07-01T00:00:00.000Z" });

    const listed = unwrap(await service.listFindings(ALICE, { status: "open" }));

    expect(listed.map((finding) => finding.id)).toEqual([open]);
  });

  it("filters by severity", async () => {
    const high = seed({ severity: "high" });
    seed({ severity: "low" });

    const listed = unwrap(await service.listFindings(ALICE, { severity: "high" }));

    expect(listed.map((finding) => finding.id)).toEqual([high]);
  });

  it("combines both filters with AND", async () => {
    const wanted = seed({ severity: "high" });
    seed({
      severity: "high",
      status: "resolved",
      resolved_by: "user",
      resolved_at: "2026-07-01T00:00:00.000Z",
    });
    seed({ severity: "low" });

    const listed = unwrap(await service.listFindings(ALICE, { status: "open", severity: "high" }));

    expect(listed.map((finding) => finding.id)).toEqual([wanted]);
  });

  it("returns an empty list rather than failing when nothing matches", async () => {
    seed({ severity: "low" });

    expect(unwrap(await service.listFindings(ALICE, { severity: "critical" }))).toEqual([]);
  });

  it("shows finished findings too, unlike the Recommended view", async () => {
    // Frontend §8's Resolved and Dismissed views read the same list.
    seed({ status: "resolved", resolved_by: "system", resolved_at: "2026-07-01T00:00:00.000Z" });

    expect(unwrap(await service.listFindings(ALICE))).toHaveLength(1);
    expect(unwrap(await service.calculateRecommendations(ALICE))).toHaveLength(0);
  });
});

describe("no timestamp leaves the application (ATL-113)", () => {
  /**
   * The defect this replaced: `close()` sent `resolved_at` and `updated_at`
   * from this process's clock, and the not-future constraint judged them with
   * the database's. Two clocks, one comparison — it rejected eight ordinary
   * closures in a single local run.
   *
   * Asserted at the point where the patch is built, because that is where the
   * regression would reappear: adding a timestamp back is a one-line change
   * that would look harmless.
   */

  it("sends no timestamp when closing", async () => {
    /**
     * The patch widened in ATL-042 — `resolution_action` joined it, which is a
     * value the user chose rather than a clock. What this test guards is
     * unchanged: no timestamp leaves the application, because ATL-113's
     * triggers own `resolved_at` and `updated_at`.
     */
    const patches: Row[] = [];
    const id = seed({});

    await serviceSpying(patches).resolveFinding(ALICE, id, "reviewed");

    expect(patches).toHaveLength(1);
    expect(patches[0]).not.toHaveProperty("resolved_at");
    expect(patches[0]).not.toHaveProperty("updated_at");
  });

  it("sends no timestamp when dismissing either", async () => {
    const patches: Row[] = [];
    const id = seed({});

    await serviceSpying(patches).dismissFinding(ALICE, id);

    expect(patches[0]).not.toHaveProperty("resolved_at");
    expect(patches[0]).not.toHaveProperty("updated_at");
  });

  it("still lets the database record when the closure happened", async () => {
    // The value is not absent, it is simply not the application's to supply.
    const id = seed({});

    await service.resolveFinding(ALICE, id, "reviewed");

    expect(stored(id)?.resolved_at).toBeTruthy();
    expect(stored(id)?.resolved_by).toBe("user");
  });
});

describe("the user resolves a finding", () => {
  it("records the user as the resolver, never the system", async () => {
    /**
     * The distinction ADR-004 depends on: its protective-actions factor credits
     * resolutions, and recording `system` here would pay the user for a
     * condition that expired on its own.
     */
    const id = seed();

    unwrap(await service.resolveFinding(ALICE, id, "reviewed"));

    expect(stored(id)?.status).toBe("resolved");
    expect(stored(id)?.resolved_by).toBe("user");
    expect(stored(id)?.resolved_at).toBeTruthy();
  });

  it("puts it on the timeline, attributed to the user", async () => {
    const id = seed();

    unwrap(await service.resolveFinding(ALICE, id, "reviewed"));

    const event = activity().at(-1);
    expect(event?.event_type).toBe("finding.resolved");
    expect((event?.metadata_redacted_json as Record<string, unknown>).actor).toBe("user");
  });

  it("asks for a score recalculation", async () => {
    // ADR-004 lists finding resolution among its recalculation triggers.
    unwrap(await service.resolveFinding(ALICE, seed(), "reviewed"));

    expect(scored).toEqual([{ userId: ALICE, reason: "finding.changed" }]);
  });

  it("works from in_progress as well as open", async () => {
    // §11.1's lifecycle is open → in_progress → resolved or dismissed.
    const id = seed({ status: "in_progress" });

    expect((await service.resolveFinding(ALICE, id, "reviewed")).ok).toBe(true);
  });
});

describe("the user dismisses a finding", () => {
  it("records the decision without claiming a fix", async () => {
    const id = seed();

    unwrap(await service.dismissFinding(ALICE, id));

    expect(stored(id)?.status).toBe("dismissed");
    expect(stored(id)?.resolved_by).toBe("user");
  });

  it("still triggers recalculation, even though the score will not improve", async () => {
    /**
     * ADR-004 lists dismissal among its triggers *and* keeps the deduction until
     * the condition clears. Both hold: recalculation is idempotent and writes a
     * snapshot only when something actually changed.
     */
    unwrap(await service.dismissFinding(ALICE, seed()));

    expect(scored).toHaveLength(1);
  });

  it("announces a dismissal, not a resolution", async () => {
    unwrap(await service.dismissFinding(ALICE, seed()));

    expect(activity().at(-1)?.event_type).toBe("finding.dismissed");
  });
});

describe("the dismissal reason (ATL-043)", () => {
  /**
   * The reason lives on the timeline and nowhere else. There is no column for
   * it: nothing reads it — ATL-102 suppresses on the input hash alone, and per
   * the OQ-04 amendment no reason moves the score — so persisting it on the
   * finding would be storage in search of a reader.
   */

  const lastMetadata = () =>
    activity().at(-1)?.metadata_redacted_json as Record<string, unknown> | undefined;

  it.each(["not_relevant", "accepted_risk"] as const)("records %s on the timeline", async (r) => {
    unwrap(await service.dismissFinding(ALICE, seed(), r));

    expect(lastMetadata()?.reason).toBe(r);
  });

  it("dismisses perfectly well without one", async () => {
    // Frontend §5.4 makes the reason optional, so an absent one is a complete
    // dismissal rather than a degraded one.
    const id = seed();

    const result = await service.dismissFinding(ALICE, id);

    expect(result.ok).toBe(true);
    expect(stored(id)?.status).toBe("dismissed");
  });

  it("omits the key entirely when no reason was given", async () => {
    // Rather than writing `reason: null`, which the allowlist would drop and
    // which would read as "a reason was recorded and it was nothing".
    unwrap(await service.dismissFinding(ALICE, seed()));

    expect(lastMetadata()).not.toHaveProperty("reason");
  });

  it("writes no reason onto the finding itself", async () => {
    /**
     * `resolution_action` is ATL-042's column and belongs to resolution alone —
     * the check constraint refuses it on a dismissed row. This asserts the
     * service does not try.
     */
    const id = seed();

    unwrap(await service.dismissFinding(ALICE, id, "accepted_risk"));

    expect(stored(id)?.resolution_action ?? null).toBeNull();
  });

  it("sends no reason column in the patch", async () => {
    const patches: Row[] = [];
    const id = seed();

    await serviceSpying(patches).dismissFinding(ALICE, id, "not_relevant");

    expect(Object.keys(patches[0] ?? {}).sort()).toEqual(["resolved_by", "status"]);
  });
});

describe("undo (ATL-043)", () => {
  const dismissed = () =>
    seed({ status: "dismissed", resolved_by: "user", resolved_at: PAST, input_hash: "hash-1" });

  it("returns a dismissed finding to open", async () => {
    const id = dismissed();

    const restored = unwrap(await service.undismissFinding(ALICE, id));

    expect(restored.status).toBe("open");
    expect(stored(id)?.status).toBe("open");
  });

  it("clears the resolver and the resolution time together", async () => {
    // The resolution-complete constraint refuses an open finding that still
    // names a resolver, so these move as a pair or not at all.
    const id = dismissed();

    unwrap(await service.undismissFinding(ALICE, id));

    expect(stored(id)?.resolved_by ?? null).toBeNull();
    expect(stored(id)?.resolved_at ?? null).toBeNull();
  });

  it("leaves the input hash exactly as it was", async () => {
    /**
     * §11.1: "a null hash means unknown, not unchanged." Undo re-evaluates
     * nothing, so writing a hash here would tell ATL-102 something false about a
     * finding nobody looked at.
     */
    const id = dismissed();

    unwrap(await service.undismissFinding(ALICE, id));

    expect(stored(id)?.input_hash).toBe("hash-1");
  });

  it("does not touch severity or confidence", async () => {
    // Those are derived from inputs. Nothing about the user's records changed.
    const id = seed({
      status: "dismissed",
      resolved_by: "user",
      resolved_at: PAST,
      severity: "high",
      confidence: "low",
    });

    unwrap(await service.undismissFinding(ALICE, id));

    expect(stored(id)?.severity).toBe("high");
    expect(stored(id)?.confidence).toBe("low");
  });

  it("announces a restoration rather than a new finding", async () => {
    // `finding.opened` would say "New finding" for something the user already
    // saw, decided about, and changed their mind on.
    unwrap(await service.undismissFinding(ALICE, dismissed()));

    expect(activity().at(-1)?.event_type).toBe("finding.restored");
  });

  it("triggers recalculation", async () => {
    // The finding is open again, so ADR-004's open-findings factor sees it.
    unwrap(await service.undismissFinding(ALICE, dismissed()));

    expect(scored).toHaveLength(1);
  });

  it("refuses to undo a resolution", async () => {
    /**
     * Resolution asserts the underlying problem was dealt with, and ADR-004's
     * protective-actions factor has already credited it. Undoing one is a
     * different act from changing your mind about ignoring something.
     */
    const id = seed({ status: "resolved", resolved_by: "user", resolved_at: PAST });

    const result = await service.undismissFinding(ALICE, id);

    expect(result.ok === false && result.code).toBe("INVALID_REQUEST");
    expect(stored(id)?.status).toBe("resolved");
  });

  it("refuses to undo an open finding", async () => {
    const result = await service.undismissFinding(ALICE, seed());

    expect(result.ok === false && result.code).toBe("INVALID_REQUEST");
  });

  it("refuses another user's dismissed finding, and says NOT_FOUND", async () => {
    // The non-oracle rule: a FORBIDDEN would confirm the finding exists.
    const theirs = seed({
      user_id: BOB,
      status: "dismissed",
      resolved_by: "user",
      resolved_at: PAST,
    });

    const result = await service.undismissFinding(ALICE, theirs);

    expect(result.ok === false && result.code).toBe("NOT_FOUND");
    expect(stored(theirs)?.status).toBe("dismissed");
  });

  it("answers NOT_FOUND for a finding that does not exist", async () => {
    const result = await service.undismissFinding(ALICE, randomUUID());

    expect(result.ok === false && result.code).toBe("NOT_FOUND");
  });

  it("writes nothing at all when it refuses", async () => {
    await service.undismissFinding(ALICE, seed());

    expect(activity()).toHaveLength(0);
    expect(scored).toHaveLength(0);
  });

  it("can be dismissed again afterwards, and undone again", async () => {
    // Unbounded in both directions: these are the user's own records.
    const id = dismissed();

    unwrap(await service.undismissFinding(ALICE, id));
    unwrap(await service.dismissFinding(ALICE, id, "accepted_risk"));
    unwrap(await service.undismissFinding(ALICE, id));

    expect(stored(id)?.status).toBe("open");
  });

  it("leaves the original dismissal's reason on the timeline", async () => {
    /**
     * Undo writes its own event rather than editing the previous one. The
     * history stays truthful: the user dismissed it, for that reason, and then
     * restored it.
     */
    const id = seed();
    unwrap(await service.dismissFinding(ALICE, id, "not_relevant"));

    unwrap(await service.undismissFinding(ALICE, id));

    const [dismissEvent, restoreEvent] = activity();
    expect((dismissEvent?.metadata_redacted_json as Record<string, unknown>).reason).toBe(
      "not_relevant",
    );
    expect(restoreEvent?.event_type).toBe("finding.restored");
  });
});

describe("invalid transitions", () => {
  it("refuses to resolve a finding that is already resolved", async () => {
    /**
     * Rejecting rather than treating it as a no-op: a silent success would let a
     * double-submitted form rewrite `resolved_at`, moving the finding inside
     * ADR-004's trailing 180-day window, and post a second timeline entry for
     * something that happened once.
     */
    const id = seed({
      status: "resolved",
      resolved_by: "user",
      resolved_at: "2026-07-01T00:00:00.000Z",
    });

    const result = await service.resolveFinding(ALICE, id, "reviewed");

    expect(result.ok === false && result.code).toBe("INVALID_REQUEST");
  });

  it("refuses to dismiss a finding that is already dismissed", async () => {
    const id = seed({
      status: "dismissed",
      resolved_by: "user",
      resolved_at: "2026-07-01T00:00:00.000Z",
    });

    expect((await service.dismissFinding(ALICE, id)).ok).toBe(false);
  });

  it("refuses to dismiss a finding the system already auto-resolved", async () => {
    // Resolved is terminal. The condition cleared; there is nothing to dismiss.
    const id = seed({
      status: "resolved",
      resolved_by: "system",
      resolved_at: "2026-07-01T00:00:00.000Z",
    });

    expect((await service.dismissFinding(ALICE, id)).ok).toBe(false);
    expect(stored(id)?.resolved_by).toBe("system");
  });

  it("writes nothing at all when it refuses", async () => {
    // No timeline entry, no recalculation — a refused action did not happen.
    const id = seed({
      status: "resolved",
      resolved_by: "system",
      resolved_at: "2026-07-01T00:00:00.000Z",
    });

    await service.resolveFinding(ALICE, id, "reviewed");

    expect(activity()).toHaveLength(0);
    expect(scored).toHaveLength(0);
  });

  it("distinguishes a refused transition from a missing finding", async () => {
    // The codes differ because the situations differ: one is "you cannot do
    // that", the other is "there is nothing there".
    const closed = await service.resolveFinding(
      ALICE,
      seed({ status: "resolved", resolved_by: "user", resolved_at: "2026-07-01T00:00:00.000Z" }),
      "reviewed",
    );
    const missing = await service.resolveFinding(ALICE, randomUUID(), "reviewed");

    expect(closed.ok === false && closed.code).toBe("INVALID_REQUEST");
    expect(missing.ok === false && missing.code).toBe("NOT_FOUND");
  });
});

describe("the service never acts as the system", () => {
  it("exposes no way to write resolved_by = system", () => {
    /**
     * The structural half of the engine/user separation. Auto-resolution belongs
     * to `FindingsEngine`; if a method here could write `system`, ADR-004's
     * protective-actions factor could be moved by a user action pretending to be
     * one of Atlas's own conclusions.
     */
    const methods = Object.getOwnPropertyNames(FindingService.prototype).sort();

    expect(methods).toEqual([
      "afterUserAction",
      "calculateRecommendations",
      "close",
      "constructor",
      "dismissFinding",
      "getFinding",
      /**
       * ATL-041's read model. `getFindingDetail` is a read, and
       * `resolveEvidence` a private projection over ids the finding already
       * stores — neither widens what the service can do to a finding.
       */
      "getFindingDetail",
      "listFindings",
      /**
       * ATL-034's asset detail section. A read, like `listFindings` beside it:
       * it issues one scoped `select` and returns the rows through the same two
       * presentation helpers. It writes nothing, so it cannot assert `system`
       * — and it takes no status argument at all, so it cannot even observe a
       * finding the engine closed.
       */
      "listFindingsForAsset",
      "resolveEvidence",
      "resolveFinding",
      "storeFailure",
      /**
       * ATL-043's undo. It writes `status = 'open'` and clears the resolver, so
       * it cannot assert `system` either — the value it writes to `resolved_by`
       * is null and nothing else.
       */
      "undismissFinding",
      // ATL-040's read-model enrichment. A private projection that adds a
      // display label; it writes nothing, which is why it can be here without
      // widening what the service can do to a finding.
      "withImpactedAsset",
    ]);
  });
});

describe("the impacted asset label (ATL-040)", () => {
  it("names the service a finding is about", async () => {
    // The card shows a name, never an id: a UUID tells a user nothing and
    // exposes an internal identifier in the UI.
    const assetId = seedAsset("Spotify");
    seed({ asset_id: assetId });

    const [listed] = unwrap(await service.listFindings(ALICE));

    expect(listed?.impactedAsset).toBe("Spotify");
  });

  it("labels footprint-wide findings rather than leaving the field blank", async () => {
    // R-008 is a statement about the whole footprint; `asset_id` stays null in
    // the database and the label is resolved here, not in the UI.
    seed({ asset_id: null });

    const [listed] = unwrap(await service.listFindings(ALICE));

    expect(listed?.impactedAsset).toBe(FOOTPRINT_WIDE_LABEL);
    expect(listed?.assetId).toBeNull();
  });

  it("uses the same value in detail and recommendations", async () => {
    const assetId = seedAsset("Monzo");
    const id = seed({ asset_id: assetId });

    const detail = unwrap(await service.getFinding(ALICE, id));
    const [recommended] = unwrap(await service.calculateRecommendations(ALICE));

    expect(detail.impactedAsset).toBe("Monzo");
    expect(recommended?.impactedAsset).toBe("Monzo");
  });

  it("resolves names for several findings in one read", async () => {
    const spotify = seedAsset("Spotify");
    const monzo = seedAsset("Monzo");
    seed({ asset_id: spotify, severity: "high" });
    seed({ asset_id: monzo, severity: "low" });
    seed({ asset_id: null, severity: "medium" });

    const listed = unwrap(await service.listFindings(ALICE));

    expect(listed.map((finding) => finding.impactedAsset)).toEqual([
      "Spotify",
      FOOTPRINT_WIDE_LABEL,
      "Monzo",
    ]);
  });

  it("leaves the stored row untouched", async () => {
    // Presentation, not persistence: nothing writes this field.
    const assetId = seedAsset("Spotify");
    const id = seed({ asset_id: assetId });

    await service.listFindings(ALICE);

    expect(stored(id)).not.toHaveProperty("impactedAsset");
  });

  it("does not change what a mutation returns", async () => {
    // Resolve returns what changed, not what to draw.
    const id = seed({ asset_id: seedAsset("Spotify") });

    const resolved = unwrap(await service.resolveFinding(ALICE, id, "reviewed"));

    expect(resolved).not.toHaveProperty("impactedAsset");
  });
});

describe("the detail read model (ATL-041)", () => {
  /**
   * `getFindingDetail` is additive: same ownership predicate, same non-oracle
   * `NOT_FOUND`, plus the evidence records the panel needs and the list does
   * not. Nothing here writes, and no lifecycle changes.
   */

  const seedCategory = (assetId: string, category: string): string => {
    const id = randomUUID();
    tableOf("asset_data_categories").set(id, {
      id,
      user_id: ALICE,
      asset_id: assetId,
      category,
      sensitivity: "standard",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    return id;
  };

  const seedPermission = (assetId: string, permissionType: string): string => {
    const id = randomUUID();
    tableOf("asset_permissions").set(id, {
      id,
      user_id: ALICE,
      asset_id: assetId,
      permission_type: permissionType,
      scope: "broad",
      status: "active",
      last_verified_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    return id;
  };

  it("returns the same view fields as getFinding", async () => {
    const assetId = seedAsset("Spotify");
    const id = seed({ asset_id: assetId });

    const detail = unwrap(await service.getFindingDetail(ALICE, id));

    expect(detail.impactedAsset).toBe("Spotify");
    expect(detail.id).toBe(id);
  });

  it("resolves an asset reference to a name and a destination", async () => {
    // The ids are identifiers in the database; a UUID explains nothing to a
    // reader, so the service names them.
    const assetId = seedAsset("Spotify");
    const id = seed({ asset_id: assetId, evidence_refs_json: { assetIds: [assetId] } });

    const detail = unwrap(await service.getFindingDetail(ALICE, id));

    expect(detail.evidenceRecords).toEqual([
      { id: assetId, kind: "asset", label: "Spotify", href: `/assets/${assetId}` },
    ]);
  });

  it("points a category and a permission at the asset page where they are visible", async () => {
    const assetId = seedAsset("Monzo");
    const categoryId = seedCategory(assetId, "financial");
    const permissionId = seedPermission(assetId, "data_sharing");
    const id = seed({
      asset_id: assetId,
      evidence_refs_json: { dataCategoryIds: [categoryId], permissionIds: [permissionId] },
    });

    const detail = unwrap(await service.getFindingDetail(ALICE, id));

    expect(detail.evidenceRecords.map((record) => record.href)).toEqual([
      `/assets/${assetId}/edit`,
      `/assets/${assetId}/edit`,
    ]);
    expect(detail.evidenceRecords[0]?.label).toContain("financial");
    expect(detail.evidenceRecords[1]?.label).toContain("data_sharing");
  });

  it("keeps a reference that no longer resolves, without a destination", async () => {
    // Omitting it would make the finding look better founded than it is.
    const id = seed({ evidence_refs_json: { assetIds: [randomUUID()] } });

    const [record] = unwrap(await service.getFindingDetail(ALICE, id)).evidenceRecords;

    expect(record?.href).toBeNull();
    expect(record?.label).toContain("no longer exists");
  });

  it("resolves nothing for another user's record id", async () => {
    /**
     * The ids arrive as data rather than as arguments, so the ownership
     * predicate is restated on every lookup. A planted id must not name a
     * record belonging to somebody else.
     */
    const bobAsset = randomUUID();
    tableOf("digital_assets").set(bobAsset, {
      id: bobAsset,
      user_id: BOB,
      service_name: "Bob's Bank",
      category: "finance",
      status: "active",
      source_type: "manual",
      confidence: "medium",
      last_verified_at: null,
      service_domain: null,
      source_label: null,
      notes: null,
      metadata_json: {},
      account_identifier_encrypted: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const id = seed({ evidence_refs_json: { assetIds: [bobAsset] } });

    const [record] = unwrap(await service.getFindingDetail(ALICE, id)).evidenceRecords;

    expect(record?.href).toBeNull();
    expect(record?.label).not.toContain("Bob");
  });

  it("returns an empty list when the finding cites nothing", async () => {
    const id = seed({ evidence_refs_json: {} });

    expect(unwrap(await service.getFindingDetail(ALICE, id)).evidenceRecords).toEqual([]);
  });

  it("tolerates a malformed evidence payload rather than throwing", async () => {
    // `evidence_refs_json` is jsonb; a row could carry anything.
    const id = seed({ evidence_refs_json: { assetIds: "not-an-array", other: 7 } });

    expect(unwrap(await service.getFindingDetail(ALICE, id)).evidenceRecords).toEqual([]);
  });

  it("answers NOT_FOUND for another user's finding, the same as getFinding", async () => {
    const id = seed({ user_id: BOB });

    const result = await service.getFindingDetail(ALICE, id);

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("answers NOT_FOUND for a finding that does not exist", async () => {
    expect(await service.getFindingDetail(ALICE, randomUUID())).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("writes nothing", async () => {
    const id = seed({});
    const before = JSON.stringify(stored(id));

    await service.getFindingDetail(ALICE, id);

    expect(JSON.stringify(stored(id))).toBe(before);
  });
});

/** An hour ago: safely inside `privacy_findings_resolved_not_future`. */
const PAST = new Date(Date.now() - 3_600_000).toISOString();

describe("recording what the user did (ATL-042)", () => {
  /**
   * ATL-042: "resolution requires selecting or confirming the action taken".
   * `resolved_by` and the trigger-written `resolved_at` say *who* and *when*;
   * this column is the only place that says *what*.
   */

  it("persists the selected action", async () => {
    const id = seed({});

    unwrap(await service.resolveFinding(ALICE, id, "permission_revoked"));

    expect(stored(id)?.resolution_action).toBe("permission_revoked");
  });

  it.each(["reviewed", "permission_revoked", "data_removed", "account_closed", "other"] as const)(
    "accepts %s from the closed vocabulary",
    async (action) => {
      const id = seed({});

      unwrap(await service.resolveFinding(ALICE, id, action));

      expect(stored(id)?.resolution_action).toBe(action);
    },
  );

  it("still records the user as the resolver", async () => {
    // ADR-004 credits the protective action to the user, never the system.
    const id = seed({});

    unwrap(await service.resolveFinding(ALICE, id, "reviewed"));

    expect(stored(id)?.resolved_by).toBe("user");
  });

  it("sends no timestamp of its own", async () => {
    // ATL-113's triggers own `resolved_at` and `updated_at`; the patch carries
    // status, resolver and action, and nothing else.
    const patches: Row[] = [];
    const id = seed({});

    await serviceSpying(patches).resolveFinding(ALICE, id, "reviewed");

    expect(Object.keys(patches[0] ?? {}).sort()).toEqual([
      "resolution_action",
      "resolved_by",
      "status",
    ]);
  });

  it("records no action when the engine auto-resolves", async () => {
    /**
     * `resolved_by = 'system'` means nobody chose anything. The engine reaches
     * the repository directly and omits the action, so the patch must not carry
     * the column at all — sending `null` explicitly would be the same value by a
     * route that also lets a caller erase an action that was recorded.
     */
    const patches: Row[] = [];
    const id = seed({});

    const closed = await new PrivacyFindingRepository(dbWithUpdateSpy(patches)).close(
      ALICE,
      id,
      "resolved",
      "system",
    );

    expect(patches[0]).not.toHaveProperty("resolution_action");
    expect(closed?.resolutionAction).toBeNull();
  });
});

describe("the resolution audit event (ATL-042)", () => {
  /**
   * ADR-006's inventory is amended for this ticket, so the event is written
   * from the same place as the activity event and cannot drift from it.
   *
   * The three cases below are the post-commit policy in full: the mutation and
   * the audit write are separate transactions, so the only coherent rule is
   * that the audit describes what committed, and its failure never unwinds a
   * committed user action.
   */

  it("writes finding.resolved after a successful resolution", async () => {
    const id = seed({});

    unwrap(await service.resolveFinding(ALICE, id, "data_removed"));

    const events = [...tableOf("audit_events").values()];
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("finding.resolved");
    expect(events[0]?.actor_type).toBe("user");
    expect(events[0]?.entity_type).toBe("finding");
    expect(events[0]?.entity_id).toBe(id);
  });

  it("carries only allowlisted context, and the action as the reason", async () => {
    // Every key is already in AUDIT_CONTEXT_POLICY; none is free text, an
    // identifier, or a personal value.
    const id = seed({ rule_version: "rules-v1" });

    unwrap(await service.resolveFinding(ALICE, id, "account_closed"));

    const context = [...tableOf("audit_events").values()][0]?.context_json as Record<
      string,
      unknown
    >;
    expect(context).toMatchObject({
      toStatus: "resolved",
      reason: "account_closed",
      ruleVersion: "rules-v1",
    });
  });

  it("succeeds for the user even when the audit write fails", async () => {
    /**
     * The finding is already resolved and durable by the time the audit runs.
     * Reporting failure would be false, and the user could not retry — the
     * finding is terminal. The resolution stands.
     */
    const id = seed({});
    const failing = new FindingService(
      createDb(),
      new ActivityWriter(createDb()),
      { enqueue: () => Promise.resolve() },
      { write: () => Promise.reject(new Error("audit down")) } as never,
    );

    const result = await failing.resolveFinding(ALICE, id, "reviewed");

    expect(result.ok).toBe(true);
  });

  it("logs the audit failure rather than swallowing it", async () => {
    // The one place a missing audit record can be noticed at all.
    const id = seed({});
    const failing = new FindingService(
      createDb(),
      new ActivityWriter(createDb()),
      { enqueue: () => Promise.resolve() },
      { write: () => Promise.reject(new Error("audit down")) } as never,
    );

    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });

    await failing.resolveFinding(ALICE, id, "reviewed");
    spy.mockRestore();

    expect(logged.join(" ")).toContain("audit.write_failed");
  });

  it("does not revert the finding when the audit write fails", async () => {
    const id = seed({});
    const db = createDb();
    const failing = new FindingService(
      db,
      new ActivityWriter(db),
      { enqueue: () => Promise.resolve() },
      { write: () => Promise.reject(new Error("audit down")) } as never,
    );

    await failing.resolveFinding(ALICE, id, "reviewed");

    expect(stored(id)?.status).toBe("resolved");
    expect(stored(id)?.resolution_action).toBe("reviewed");
  });

  it("writes no audit event when the resolution fails", async () => {
    // A record of a resolution that never happened would be worse than none:
    // tamper-evidence is only meaningful if it records facts.
    const closed = seed({ status: "resolved", resolved_by: "user", resolved_at: PAST });

    const result = await service.resolveFinding(ALICE, closed, "reviewed");

    expect(result.ok).toBe(false);
    expect([...tableOf("audit_events").values()]).toHaveLength(0);
  });

  it("writes no audit event for a finding that is not the user's", async () => {
    const id = seed({ user_id: BOB });

    await service.resolveFinding(ALICE, id, "reviewed");

    expect([...tableOf("audit_events").values()]).toHaveLength(0);
  });

  it("audits resolution only, never dismissal", async () => {
    // ADR-006's amended inventory covers resolution; ATL-043 owns dismissal
    // and would need its own decision.
    unwrap(await service.dismissFinding(ALICE, seed({})));

    expect([...tableOf("audit_events").values()]).toHaveLength(0);
  });
});

/**
 * ATL-034 M1 — the asset detail page's findings section.
 *
 * Four exclusions decide what this section shows, and each is asserted against a
 * record that genuinely exists: an absence proves nothing unless the thing could
 * have been present. The predicates run through the real repository and the real
 * `.eq`/`.in` chain, so what is exercised is the query the page will issue.
 */
describe("listing one asset's findings", () => {
  it("returns only findings for the requested asset", async () => {
    const subject = seedAsset("Subject Service");
    const other = seedAsset("Other Service");

    const wanted = seed({ asset_id: subject });
    const unwanted = seed({ asset_id: other });

    const listed = unwrap(await service.listFindingsForAsset(ALICE, subject));

    expect(listed.map((finding) => finding.id)).toEqual([wanted]);
    expect(listed.map((finding) => finding.id)).not.toContain(unwanted);
  });

  it("excludes another user's findings, even on an asset id they own", async () => {
    const theirs = seedAsset("Bob Service", { user_id: BOB });
    seed({ user_id: BOB, asset_id: theirs });

    /**
     * Alice naming Bob's asset id gets nothing. `user_id` is an explicit
     * predicate rather than an assumption about who is asking, which is what
     * matters on a path that runs as `service_role` with RLS bypassed.
     */
    expect(unwrap(await service.listFindingsForAsset(ALICE, theirs))).toEqual([]);
  });

  it("excludes footprint-wide findings that belong to no asset", async () => {
    const subject = seedAsset("Subject Service");
    const attached = seed({ asset_id: subject });

    /** `seed` defaults `asset_id` to null — the R-008 shape. */
    const footprintWide = seed();

    const listed = unwrap(await service.listFindingsForAsset(ALICE, subject));

    /**
     * Excluded structurally: equality never matches null, in SQL or here. A
     * footprint-wide finding attributed to one service would misstate what the
     * rule actually found.
     */
    expect(listed.map((finding) => finding.id)).toEqual([attached]);
    expect(listed.map((finding) => finding.id)).not.toContain(footprintWide);
  });

  it("excludes resolved and dismissed findings", async () => {
    const subject = seedAsset("Subject Service");
    const live = seed({ asset_id: subject });

    const closed = {
      asset_id: subject,
      resolved_by: "user",
      resolved_at: "2026-07-01T00:00:00.000Z",
    };
    const done = seed({ ...closed, status: "resolved" });
    const waved = seed({ ...closed, status: "dismissed" });

    const listed = unwrap(await service.listFindingsForAsset(ALICE, subject));

    /**
     * The partial index says why: "a resolved finding does not belong in that
     * section". This is the assertion that keeps the service in step with it.
     */
    expect(listed.map((finding) => finding.id)).toEqual([live]);
    expect(listed.map((finding) => finding.id)).not.toContain(done);
    expect(listed.map((finding) => finding.id)).not.toContain(waved);
  });

  it("keeps in_progress, which is still live exposure", async () => {
    const subject = seedAsset("Subject Service");
    const started = seed({ asset_id: subject, status: "in_progress" });

    /**
     * The other half of the status rule. A section that showed `open` alone
     * would hide a finding the moment someone started working on it, which is
     * precisely when they are most likely to come looking for it.
     */
    expect(unwrap(await service.listFindingsForAsset(ALICE, subject)).map((f) => f.id)).toEqual([
      started,
    ]);
  });

  it("applies the same recommended order as the insights list", async () => {
    const subject = seedAsset("Subject Service");

    const low = seed({ asset_id: subject, severity: "low" });
    const critical = seed({ asset_id: subject, severity: "critical" });
    const high = seed({ asset_id: subject, severity: "high" });

    const onAsset = unwrap(await service.listFindingsForAsset(ALICE, subject));
    const onInsights = unwrap(await service.listFindings(ALICE, { status: "open" }));

    expect(onAsset.map((finding) => finding.id)).toEqual([critical, high, low]);

    /**
     * Compared against the other surface rather than a literal, so the two
     * cannot drift: a finding must not reorder itself depending on which page is
     * showing it.
     */
    expect(onAsset.map((finding) => finding.id)).toEqual(onInsights.map((finding) => finding.id));
  });

  it("resolves the impacted service name, as the insights list does", async () => {
    const subject = seedAsset("Subject Service");
    seed({ asset_id: subject });

    const [listed] = unwrap(await service.listFindingsForAsset(ALICE, subject));

    expect(listed?.impactedAsset).toBe("Subject Service");
  });

  it("returns an empty list rather than failing when the service has none", async () => {
    const subject = seedAsset("Subject Service");

    /** Drives the "No open findings for this service." empty state (M2). */
    expect(unwrap(await service.listFindingsForAsset(ALICE, subject))).toEqual([]);
  });
});
