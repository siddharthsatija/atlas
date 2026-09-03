import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * ATL-044 — `PrivacyScoreService.calculateScore`, against the real repositories.
 *
 * The factor arithmetic is covered purely in `src/lib/score/`. What is asserted
 * here is everything the *service* decides: which records reach the factors,
 * cold start, demo isolation, and that the service writes nothing.
 *
 * It is also where the three claims ATL-042 and ATL-043 had to defer finally
 * become assertable — resolution moves the score, dismissal does not, and
 * dismiss/undo is not a lever.
 *
 * Only PostgREST is faked; the repositories, the factors and the combiner all
 * run for real.
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

/** Fixed, because three factors are time-windowed (testing skill: inject time). */
const NOW = new Date("2026-08-09T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

type Row = Record<string, unknown>;

const tables = new Map<string, Map<string, Row>>();
const tableOf = (name: string) => {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name) as Map<string, Row>;
};

/** Makes each inserted `recorded_at` distinct — see the note in `insert`. */
let insertSequence = 0;

/**
 * A PostgREST double.
 *
 * Ordering and `limit` are modelled rather than stubbed, because `findLatest`
 * depends on them: a fake that ignored `order` would return an arbitrary
 * snapshot and the write-on-change tests would pass while comparing against the
 * wrong row.
 *
 * `recorded_at` is defaulted here the way the column defaults it, so no test can
 * accidentally assert that the application supplies a timestamp.
 */
function createDb(): SupabaseClient<Database> {
  const builder = (tableName: string) => {
    const store = tableOf(tableName);
    let operation: "select" | "insert" | "delete" = "select";
    let pending: Row = {};
    const filters: { column: string; value: unknown }[] = [];
    const inFilters: { column: string; values: unknown[] }[] = [];
    const ltFilters: { column: string; value: string }[] = [];
    const orders: { column: string; ascending: boolean }[] = [];
    let rowLimit: number | null = null;

    const matching = () => {
      const rows = [...store.values()].filter(
        (row) =>
          filters.every((f) => row[f.column] === f.value) &&
          inFilters.every((f) => f.values.includes(row[f.column])) &&
          ltFilters.every((f) => String(row[f.column]) < f.value),
      );

      for (const order of [...orders].reverse()) {
        rows.sort((a, b) => {
          const left = String(a[order.column]);
          const right = String(b[order.column]);
          const cmp = left < right ? -1 : left > right ? 1 : 0;
          return order.ascending ? cmp : -cmp;
        });
      }

      return rowLimit === null ? rows : rows.slice(0, rowLimit);
    };

    const run = () => {
      if (operation === "insert") return { data: [{ ...pending }], error: null };
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
      lt: (column: string, value: string) => {
        ltFilters.push({ column, value });
        return self;
      },
      or: () => self,
      order: (column: string, options?: { ascending?: boolean }) => {
        orders.push({ column, ascending: options?.ascending ?? true });
        return self;
      },
      limit: (count: number) => {
        rowLimit = count;
        return self;
      },
      insert: (values: Row) => {
        operation = "insert";
        pending = {
          id: randomUUID(),
          /**
           * The column's own default (ATL-113): the database stamps this and
           * the repository never sends it.
           *
           * Strictly increasing, because Postgres `now()` is
           * `transaction_timestamp()` at *microsecond* precision — successive
           * inserts get distinct values. `Date.now()` has millisecond
           * resolution, so several snapshots written in one test tick would tie
           * and "latest" would fall to the random-UUID tiebreak, making the
           * write-on-change tests compare against an arbitrary row. The
           * sequence models the resolution the real column has.
           */
          recorded_at: new Date(NOW.getTime() + insertSequence++).toISOString(),
          ...values,
        };
        store.set(String(pending.id), { ...pending });
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

const { PrivacyScoreService } = await import("./privacy-score-service");

let service: InstanceType<typeof PrivacyScoreService>;

beforeEach(() => {
  tables.clear();
  insertSequence = 0;
  service = new PrivacyScoreService(createDb());
});

const seedAsset = (overrides: Row = {}): string => {
  const id = randomUUID();
  tableOf("digital_assets").set(id, {
    id,
    user_id: ALICE,
    service_name: `Service ${id.slice(0, 4)}`,
    category: "entertainment",
    status: "active",
    source_type: "manual",
    confidence: "medium",
    last_verified_at: daysAgo(10),
    service_domain: null,
    source_label: null,
    notes: null,
    metadata_json: {},
    account_identifier_encrypted: null,
    deleted_at: null,
    candidate_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
  return id;
};

const seedFinding = (overrides: Row = {}): string => {
  const id = randomUUID();
  tableOf("privacy_findings").set(id, {
    id,
    user_id: ALICE,
    asset_id: null,
    finding_type: "hygiene",
    rule_id: "R-001",
    rule_version: "rules-v1",
    dedup_key: `key-${id}`,
    title: "t",
    description: "d",
    severity: "medium",
    confidence: "medium",
    source_type: "manual",
    source_reference: "R-001@rules-v1",
    evidence_summary: "e",
    evidence_refs_json: {},
    recommended_action: "a",
    input_hash: null,
    status: "open",
    resolved_by: null,
    resolved_at: null,
    resolution_action: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  });
  return id;
};

const seedCategory = (assetId: string, category: string) => {
  const id = randomUUID();
  tableOf("asset_data_categories").set(id, {
    id,
    user_id: ALICE,
    asset_id: assetId,
    category,
    sensitivity: category === "financial" ? "high" : "standard",
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
};

const seedPermission = (assetId: string, scope: string, status = "active") => {
  const id = randomUUID();
  tableOf("asset_permissions").set(id, {
    id,
    user_id: ALICE,
    asset_id: assetId,
    permission_type: "data_sharing",
    scope,
    status,
    granted_at: null,
    last_verified_at: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
};

/**
 * Every stored row, canonically.
 *
 * Tables with no rows are skipped: reading from a table the fixtures never
 * seeded creates an empty map in the double, which is an artefact of the fake
 * rather than a write, and comparing raw table lists would fail on it.
 */
const rowsSnapshot = (): string =>
  JSON.stringify(
    [...tables]
      .filter(([, rows]) => rows.size > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, rows]) => [name, [...rows.values()]]),
  );

const score = async (userId = ALICE) => {
  const result = await service.calculateScore(userId, NOW);
  if (!result.ok) throw new Error(`expected a calculation, got ${result.code}`);
  return result.data;
};

const scored = async (userId = ALICE) => {
  const result = await score(userId);
  if (result.status !== "scored") throw new Error("expected a scored result");
  return result;
};

describe("cold start", () => {
  it("does not score a user with no assets", async () => {
    expect((await score()).status).toBe("not_yet_scored");
  });

  it("scores once a real active asset exists", async () => {
    seedAsset();

    expect((await score()).status).toBe("scored");
  });

  it("scores a user whose only asset is inactive", async () => {
    // Inactive is still a service they hold; it is archived and removed that end
    // the relationship.
    seedAsset({ status: "inactive" });

    expect((await score()).status).toBe("scored");
  });

  it.each(["archived", "removed"] as const)("does not end cold start for a %s asset", async (s) => {
    /**
     * Someone who added a service and then removed it has no current footprint.
     * Scoring an empty one would be a number about nothing.
     */
    seedAsset({ status: s });

    expect((await score()).status).toBe("not_yet_scored");
  });

  it("names the version even when it does not score", async () => {
    expect((await score()).scoreVersion).toBe("score-v1");
  });
});

describe("demo isolation", () => {
  it("scores demo records and flags the result when only demo assets exist", async () => {
    seedAsset({ source_type: "demo" });

    expect(await scored()).toMatchObject({ isDemo: true });
  });

  it("takes the real state over as soon as a real asset exists", async () => {
    seedAsset({ source_type: "demo" });
    seedAsset();

    expect((await scored()).isDemo).toBe(false);
  });

  it("excludes demo findings from a real score", async () => {
    /**
     * The sharpest edge of the isolation rule: a demo finding deducting from a
     * real score would mean an illustration made the user's number worse.
     */
    seedAsset();
    seedFinding({ severity: "critical", source_type: "demo" });

    const findings = (await scored()).factors.find((f) => f.id === "open_findings");
    expect(findings?.value).toBe(100);
  });

  it("excludes real findings from a demo score", async () => {
    seedAsset({ source_type: "demo" });
    seedFinding({ severity: "critical" });

    const findings = (await scored()).factors.find((f) => f.id === "open_findings");
    expect(findings?.value).toBe(100);
  });

  it("excludes a demo asset's categories from a real score", async () => {
    const demo = seedAsset({ source_type: "demo" });
    seedAsset();
    seedCategory(demo, "financial");

    const sensitivity = (await scored()).factors.find((f) => f.id === "data_sensitivity");
    expect(sensitivity?.value).toBe(100);
  });
});

describe("authorization", () => {
  it("scores only the requested user's records", async () => {
    seedAsset();
    seedFinding({ user_id: BOB, severity: "critical" });

    const findings = (await scored()).factors.find((f) => f.id === "open_findings");
    expect(findings?.value).toBe(100);
  });

  it("treats another user's account as cold start rather than reading ours", async () => {
    seedAsset();

    expect((await score(BOB)).status).toBe("not_yet_scored");
  });
});

describe("the breakdown", () => {
  it("records the countable inputs behind each factor", async () => {
    // ADR-004 requires "factor-level inputs"; ATL-046 shows exact contributors.
    const asset = seedAsset({ last_verified_at: daysAgo(10) });
    seedAsset({ last_verified_at: daysAgo(400) });
    seedCategory(asset, "financial");

    const result = await scored();

    expect(result.factors.find((f) => f.id === "account_hygiene")?.inputs).toMatchObject({
      activeAssets: 2,
      activeReviewed: 1,
    });
    expect(result.factors.find((f) => f.id === "data_sensitivity")?.inputs).toMatchObject({
      sensitivePairs: 1,
    });
  });

  it("excludes permission exposure and reports reduced coverage", async () => {
    seedAsset();

    const result = await scored();
    const permissions = result.factors.find((f) => f.id === "permission_exposure");

    expect(permissions?.excluded).toBe(true);
    expect(result.coverage).toBe(85);
  });

  it("includes permission exposure once a permission is recorded", async () => {
    const asset = seedAsset();
    seedPermission(asset, "broad");

    const result = await scored();

    expect(result.factors.find((f) => f.id === "permission_exposure")?.value).toBe(0);
    expect(result.coverage).toBe(100);
  });
});

describe("the deferred claims from ATL-042 and ATL-043", () => {
  /**
   * These three could not be asserted when their tickets shipped, because no
   * score existed. They are the reason the score model has to be honest, so they
   * are asserted against the model rather than against the services' intentions.
   */

  const openFinding = (overrides: Row = {}) => seedFinding({ severity: "high", ...overrides });

  it("a user resolution improves the score", async () => {
    seedAsset();
    const findingId = openFinding();
    const before = (await scored()).score;

    tableOf("privacy_findings").set(findingId, {
      ...(tableOf("privacy_findings").get(findingId) as Row),
      status: "resolved",
      resolved_by: "user",
      resolved_at: daysAgo(1),
    });

    expect((await scored()).score).toBeGreaterThan(before);
  });

  it("a dismissal by itself does not improve the score", async () => {
    /**
     * ADR-004's integrity rule and the OQ-04 sign-off, asserted numerically at
     * last: the deduction stays until the underlying condition clears.
     */
    seedAsset();
    const findingId = openFinding();
    const before = (await scored()).score;

    tableOf("privacy_findings").set(findingId, {
      ...(tableOf("privacy_findings").get(findingId) as Row),
      status: "dismissed",
      resolved_by: "user",
      resolved_at: daysAgo(1),
    });

    expect((await scored()).score).toBe(before);
  });

  it("dismiss and undo is not a lever on the score", async () => {
    /**
     * The property OQ-04's rejection of reduced-weight dismissals was
     * protecting: a user must not be able to move their own number without
     * changing the records behind it.
     */
    seedAsset();
    const findingId = openFinding();
    const stored = () => tableOf("privacy_findings").get(findingId) as Row;

    const before = (await scored()).score;

    tableOf("privacy_findings").set(findingId, {
      ...stored(),
      status: "dismissed",
      resolved_by: "user",
      resolved_at: daysAgo(1),
    });
    const dismissed = (await scored()).score;

    tableOf("privacy_findings").set(findingId, {
      ...stored(),
      status: "open",
      resolved_by: null,
      resolved_at: null,
    });
    const restored = (await scored()).score;

    expect([dismissed, restored]).toEqual([before, before]);
  });

  it("the engine's auto-resolution clears the deduction but earns no credit", async () => {
    // Distinguishes the two halves: the condition genuinely cleared, so the
    // finding stops deducting — but nobody acted, so nothing is credited.
    seedAsset();
    const findingId = openFinding();

    tableOf("privacy_findings").set(findingId, {
      ...(tableOf("privacy_findings").get(findingId) as Row),
      status: "resolved",
      resolved_by: "system",
      resolved_at: daysAgo(1),
    });

    const result = await scored();
    expect(result.factors.find((f) => f.id === "open_findings")?.value).toBe(100);
    expect(result.factors.find((f) => f.id === "protective_actions")?.value).toBe(0);
  });
});

describe("calculateScore writes nothing", () => {
  it("leaves every table untouched", async () => {
    // ATL-044 computes; ATL-045 persists. `calculateScore` remains a pure read
    // even now that a snapshot path exists next to it.
    seedAsset();
    const before = rowsSnapshot();

    await scored();

    expect(rowsSnapshot()).toBe(before);
  });
});

const snapshots = () => [...tableOf("privacy_score_snapshots").values()];

const snapshot = async (reason = "asset.updated", now: Date = NOW) => {
  const result = await service.createSnapshot(ALICE, reason, now);
  if (!result.ok) throw new Error(`expected a snapshot outcome, got ${result.code}`);
  return result.data;
};

describe("write-on-change (ATL-045)", () => {
  it("records a snapshot the first time a user is scored", async () => {
    seedAsset();

    const outcome = await snapshot();

    expect(outcome.status).toBe("written");
    expect(snapshots()).toHaveLength(1);
  });

  it("writes nothing when nothing changed", async () => {
    /**
     * ADR-004: "recalculation is idempotent; a snapshot is written only when the
     * score or factor breakdown changes." This is that rule, and it is what
     * makes recalculating after an unrelated mutation free.
     */
    seedAsset();
    await snapshot();

    const second = await snapshot();

    expect(second.status).toBe("unchanged");
    expect(snapshots()).toHaveLength(1);
  });

  it("writes again when the score actually moves", async () => {
    seedAsset();
    await snapshot();

    seedFinding({ severity: "critical" });
    const after = await snapshot("finding.changed");

    expect(after.status).toBe("written");
    expect(snapshots()).toHaveLength(2);
  });

  it("records a return to a previous score as its own snapshot", async () => {
    /**
     * 56 → 60 → 56 is three snapshots, not two. This is precisely why the
     * fingerprint is not used as an idempotency key: keying on it would suppress
     * the third write and lose a real event from the user's history.
     */
    seedAsset();
    const findingId = seedFinding({ severity: "critical" });
    await snapshot();

    tableOf("privacy_findings").set(findingId, {
      ...(tableOf("privacy_findings").get(findingId) as Row),
      status: "resolved",
      resolved_by: "system",
      resolved_at: daysAgo(1),
    });
    await snapshot("finding.changed");

    tableOf("privacy_findings").set(findingId, {
      ...(tableOf("privacy_findings").get(findingId) as Row),
      status: "open",
      resolved_by: null,
      resolved_at: null,
    });
    const third = await snapshot("finding.changed");

    expect(third.status).toBe("written");
    expect(snapshots()).toHaveLength(3);
  });

  it("stores the version, the demo flag, the reason and the breakdown", async () => {
    seedAsset();

    await snapshot("asset.created");

    const row = snapshots()[0] as Row;
    expect(row.score_version).toBe("score-v1");
    expect(row.is_demo).toBe(false);
    expect(row.reason).toBe("asset.created");
    expect((row.factor_breakdown_json as { factors: unknown[] }).factors).toHaveLength(6);
    expect(row.score).toEqual(expect.any(Number));
  });

  it("sends no timestamp of its own", async () => {
    // ATL-113: `recorded_at` is the database's, defaulted, never the caller's.
    seedAsset();

    await snapshot();

    expect(snapshots()[0]).toHaveProperty("recorded_at");
    expect(Number.isNaN(Date.parse(String((snapshots()[0] as Row).recorded_at)))).toBe(false);
  });

  it("writes nothing at cold start", async () => {
    // ADR-004 says so outright: "No snapshot is written."
    const outcome = await snapshot();

    expect(outcome.status).toBe("not_scored");
    expect(snapshots()).toHaveLength(0);
  });

  it("writes nothing when a scored user returns to cold start", async () => {
    /**
     * The history is left alone rather than closed off with a synthetic marker.
     * Nothing in the documentation describes one, so ATL-046 must read current
     * state rather than assume the latest snapshot is current.
     */
    const assetId = seedAsset();
    await snapshot();

    tableOf("digital_assets").delete(assetId);
    const after = await snapshot("asset.deleted");

    expect(after.status).toBe("not_scored");
    expect(snapshots()).toHaveLength(1);
  });

  it("flags a demo snapshot", async () => {
    seedAsset({ source_type: "demo" });

    await snapshot();

    expect((snapshots()[0] as Row).is_demo).toBe(true);
  });

  it("treats a demo score and a real score as different states", async () => {
    // Even were the numbers equal, one describes records the other cannot see.
    seedAsset({ source_type: "demo" });
    await snapshot();

    seedAsset();
    const real = await snapshot("asset.created");

    expect(real.status).toBe("written");
    expect(snapshots()).toHaveLength(2);
  });

  it("writes when a stored breakdown cannot be read", async () => {
    /**
     * Failing towards recording: a redundant snapshot is noise compaction
     * removes, while a skipped one is a hole in the history.
     */
    seedAsset();
    await snapshot();

    const stored = snapshots()[0] as Row;
    tableOf("privacy_score_snapshots").set(String(stored.id), {
      ...stored,
      factor_breakdown_json: { factors: "not an array" },
    });

    expect((await snapshot()).status).toBe("written");
  });
});

describe("compaction (ATL-045, §14)", () => {
  const seedSnapshot = (recordedAt: string, overrides: Row = {}) => {
    const id = randomUUID();
    tableOf("privacy_score_snapshots").set(id, {
      id,
      user_id: ALICE,
      score: 50,
      score_version: "score-v1",
      is_demo: false,
      factor_breakdown_json: { factors: [], coverage: 100 },
      reason: "asset.updated",
      recorded_at: recordedAt,
      ...overrides,
    });
    return id;
  };

  const compact = async (batchSize = 1000) => {
    const result = await service.compactSnapshots(NOW, batchSize);
    if (!result.ok) throw new Error(`compaction failed with ${result.code}`);
    return result.data;
  };

  it("leaves everything inside the 90-day window alone", async () => {
    seedSnapshot(daysAgo(1));
    seedSnapshot(daysAgo(1));
    seedSnapshot(daysAgo(89));

    expect(await compact()).toBe(0);
    expect(snapshots()).toHaveLength(3);
  });

  it("keeps one snapshot per day beyond the window", async () => {
    const day = "2026-01-05";
    seedSnapshot(`${day}T01:00:00.000Z`);
    seedSnapshot(`${day}T09:00:00.000Z`);
    const last = seedSnapshot(`${day}T23:00:00.000Z`);

    expect(await compact()).toBe(2);
    expect(snapshots()).toHaveLength(1);
    expect((snapshots()[0] as Row).id).toBe(last);
  });

  it("keeps the last of each day, which is the state the user ended it in", async () => {
    seedSnapshot("2026-01-05T01:00:00.000Z");
    const firstDayLast = seedSnapshot("2026-01-05T20:00:00.000Z");
    seedSnapshot("2026-01-06T01:00:00.000Z");
    const secondDayLast = seedSnapshot("2026-01-06T20:00:00.000Z");

    await compact();

    expect(
      snapshots()
        .map((row) => row.id)
        .sort(),
    ).toEqual([firstDayLast, secondDayLast].sort());
  });

  it("compacts each user's days separately", async () => {
    seedSnapshot("2026-01-05T01:00:00.000Z");
    seedSnapshot("2026-01-05T02:00:00.000Z");
    seedSnapshot("2026-01-05T01:00:00.000Z", { user_id: BOB });
    seedSnapshot("2026-01-05T02:00:00.000Z", { user_id: BOB });

    expect(await compact()).toBe(2);
    expect(snapshots()).toHaveLength(2);
  });

  it("is idempotent: a second pass finds nothing left to drop", async () => {
    seedSnapshot("2026-01-05T01:00:00.000Z");
    seedSnapshot("2026-01-05T02:00:00.000Z");

    await compact();

    expect(await compact()).toBe(0);
  });

  it("respects the batch size, so a large history compacts across calls", async () => {
    for (let hour = 0; hour < 6; hour++) {
      seedSnapshot(`2026-01-05T0${hour}:00:00.000Z`);
    }

    const first = await compact(3);

    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(5);
  });
});

describe("the demo purge capability (ATL-045, wired by ATL-083)", () => {
  const seedSnapshot = (overrides: Row = {}) => {
    const id = randomUUID();
    tableOf("privacy_score_snapshots").set(id, {
      id,
      user_id: ALICE,
      score: 50,
      score_version: "score-v1",
      is_demo: false,
      factor_breakdown_json: { factors: [], coverage: 100 },
      reason: "asset.updated",
      recorded_at: daysAgo(1),
      ...overrides,
    });
    return id;
  };

  it("removes a user's demo snapshots", async () => {
    seedSnapshot({ is_demo: true });
    seedSnapshot({ is_demo: true });

    const result = await service.deleteDemoSnapshots(ALICE);

    expect(result).toEqual({ ok: true, data: 2 });
    expect(snapshots()).toHaveLength(0);
  });

  it("leaves the real history untouched", async () => {
    const real = seedSnapshot();
    seedSnapshot({ is_demo: true });

    await service.deleteDemoSnapshots(ALICE);

    expect(snapshots().map((row) => row.id)).toEqual([real]);
  });

  it("leaves another user's demo snapshots alone", async () => {
    seedSnapshot({ is_demo: true, user_id: BOB });

    const result = await service.deleteDemoSnapshots(ALICE);

    expect(result).toEqual({ ok: true, data: 0 });
    expect(snapshots()).toHaveLength(1);
  });
});

describe("explainScore (ATL-046)", () => {
  const explain = async () => {
    const result = await service.explainScore(ALICE, NOW);
    if (!result.ok) throw new Error(`expected an explanation, got ${result.code}`);
    return result.data;
  };

  it("calculates the current score rather than reading the latest snapshot", async () => {
    /**
     * The distinction ATL-045 made necessary. A stale snapshot is deliberately
     * left in place, and the current score must not come from it.
     */
    seedAsset();
    await snapshot();

    seedFinding({ severity: "critical" });

    const { current } = await explain();
    if (current.status !== "scored") throw new Error("expected a scored result");

    const stored = snapshots()[0] as Row;
    expect(current.score).not.toBe(stored.score);
  });

  it("returns history newest first, bounded to 20", async () => {
    seedAsset();
    for (let i = 0; i < 25; i++) {
      tableOf("privacy_score_snapshots").set(randomUUID(), {
        id: randomUUID(),
        user_id: ALICE,
        score: i,
        score_version: "score-v1",
        is_demo: false,
        factor_breakdown_json: { factors: [], coverage: 100 },
        reason: "asset.updated",
        recorded_at: new Date(NOW.getTime() - i * 86_400_000).toISOString(),
      });
    }

    const { history } = await explain();

    expect(history).toHaveLength(20);
    expect(history[0]?.score).toBe(0);
  });

  it("computes the delta from the two newest recorded scores", async () => {
    // Not current minus latest: write-on-change makes those the same number.
    seedAsset();
    const older = randomUUID();
    const newer = randomUUID();
    tableOf("privacy_score_snapshots").set(older, {
      id: older,
      user_id: ALICE,
      score: 52,
      score_version: "score-v1",
      is_demo: false,
      factor_breakdown_json: { factors: [], coverage: 100 },
      reason: "asset.updated",
      recorded_at: daysAgo(10),
    });
    tableOf("privacy_score_snapshots").set(newer, {
      id: newer,
      user_id: ALICE,
      score: 56,
      score_version: "score-v1",
      is_demo: false,
      factor_breakdown_json: { factors: [], coverage: 100 },
      reason: "asset.updated",
      recorded_at: daysAgo(1),
    });

    const { delta } = await explain();

    expect(delta).toMatchObject({ from: 52, to: 56, change: 4 });
  });

  it("shows no delta with a single recorded score", async () => {
    seedAsset();
    await snapshot();

    expect((await explain()).delta).toBeNull();
  });

  it("keeps history when the user has returned to cold start", async () => {
    /**
     * No snapshot is written at cold start and no marker closes the history, so
     * the past scores remain and the surface must not present them as current.
     */
    const assetId = seedAsset();
    await snapshot();
    tableOf("digital_assets").delete(assetId);

    const { current, history } = await explain();

    expect(current.status).toBe("not_yet_scored");
    expect(history).toHaveLength(1);
  });

  it("reads only the requested user's history", async () => {
    seedAsset();
    tableOf("privacy_score_snapshots").set(randomUUID(), {
      id: randomUUID(),
      user_id: BOB,
      score: 99,
      score_version: "score-v1",
      is_demo: false,
      factor_breakdown_json: { factors: [], coverage: 100 },
      reason: "asset.updated",
      recorded_at: daysAgo(1),
    });

    expect((await explain()).history).toHaveLength(0);
  });

  it("writes nothing", async () => {
    // ATL-046 is read-only: explaining a score must not record one.
    seedAsset();
    const before = rowsSnapshot();

    await explain();

    expect(rowsSnapshot()).toBe(before);
  });
});
