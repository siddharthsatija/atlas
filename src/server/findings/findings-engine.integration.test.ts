import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * ATL-101 — the engine, against the real repositories.
 *
 * The rules themselves are covered exhaustively and purely in
 * `src/lib/findings/rules/catalog.test.ts`. What is asserted here is everything
 * the rules deliberately do not know about: dedup identity, idempotency, the
 * auto-resolution lifecycle, demo isolation, and the activity and score
 * side-effects §11.1 and §11.2 require.
 *
 * The real `FindingsEngine`, `PrivacyFindingRepository`, asset repositories and
 * `ActivityWriter` all run; only PostgREST is faked. Faking the repositories
 * would test the fake, and the reconciliation between "what fired" and "what is
 * already stored" is precisely the thing worth exercising.
 */

vi.mock("@/config/env", () => ({
  env: {
    ATLAS_KEK: Buffer.alloc(32, 9).toString("base64"),
    ATLAS_KEK_VERSION: 1,
    AUDIT_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
  },
}));

const ALICE = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

/** Column defaults the migrations declare, mirrored so the fake behaves like the schema. */
const COLUMN_DEFAULTS: Record<string, Row> = {
  privacy_findings: {
    status: "open",
    confidence: "medium",
    source_type: "manual",
    evidence_refs_json: {},
    resolved_by: null,
    resolved_at: null,
    input_hash: null,
  },
  digital_assets: { status: "active", source_type: "manual", confidence: "medium" },
  asset_data_categories: { sensitivity: "standard", confidence: "medium" },
  asset_permissions: { status: "active", scope: "limited" },
};
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
        /**
         * The column defaults the real schema applies. `status` matters most:
         * the repository does not send it, relying on the database's `open`
         * default, and a fake without it stores `undefined` — which silently
         * excludes every finding from the open population and makes
         * auto-resolution look broken when it is not.
         */
        pending = {
          id: randomUUID(),
          created_at: now,
          updated_at: now,
          ...COLUMN_DEFAULTS[tableName],
          ...values,
        };
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

const { FindingsEngine } = await import("./findings-engine");
const { ActivityWriter } = await import("@/server/activity/activity-writer");

const NOW = new Date("2026-08-09T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

let engine: InstanceType<typeof FindingsEngine>;
const scored: { userId: string; reason: string }[] = [];

const findings = () => [...tableOf("privacy_findings").values()];
const activity = () => [...tableOf("activity_events").values()];

beforeEach(() => {
  tables.clear();
  scored.length = 0;
  const db = createDb();
  engine = new FindingsEngine(db, new ActivityWriter(db), {
    enqueue: (request) => {
      scored.push(request);
      return Promise.resolve();
    },
  });
});

/** Seeds an asset directly, the way the rules engine will find it. */
const seedAsset = (overrides: Row = {}): string => {
  const id = randomUUID();
  tableOf("digital_assets").set(id, {
    id,
    user_id: ALICE,
    service_name: "Spotify",
    category: "entertainment",
    status: "active",
    source_type: "manual",
    confidence: "medium",
    last_verified_at: daysAgo(1),
    service_domain: null,
    source_label: null,
    notes: null,
    metadata_json: {},
    account_identifier_encrypted: null,
    created_at: daysAgo(400),
    updated_at: daysAgo(1),
    ...overrides,
  });
  return id;
};

const seedCategory = (assetId: string, overrides: Row = {}): string => {
  const id = randomUUID();
  tableOf("asset_data_categories").set(id, {
    id,
    user_id: ALICE,
    asset_id: assetId,
    category: "contact",
    sensitivity: "standard",
    description: null,
    source: null,
    confidence: "medium",
    created_at: daysAgo(10),
    updated_at: daysAgo(10),
    ...overrides,
  });
  return id;
};

describe("opening findings", () => {
  it("writes a finding when a rule fires", async () => {
    seedAsset({ last_verified_at: daysAgo(400) });

    const outcome = await engine.generateFindings(ALICE, NOW);

    expect(outcome.opened).toBe(1);
    expect(findings()).toHaveLength(1);
  });

  it("stamps the rule, its version, and the source reference", async () => {
    // ADR-001's explainability guarantee: every finding cites the rule and the
    // catalog version that produced it.
    seedAsset({ last_verified_at: daysAgo(400) });

    await engine.generateFindings(ALICE, NOW);

    const finding = findings()[0];
    expect(finding?.rule_id).toBe("R-001");
    expect(finding?.rule_version).toBe("rules-v1");
    expect(finding?.source_reference).toBe("R-001@rules-v1");
  });

  it("derives confidence rather than accepting one", async () => {
    // §11.1: an asset unverified for over a year caps confidence at low, however
    // trustworthy its source.
    seedAsset({ last_verified_at: daysAgo(400), source_type: "manual" });

    await engine.generateFindings(ALICE, NOW);

    expect(findings()[0]?.confidence).toBe("low");
  });

  it("records the evidence ids, and no values", async () => {
    const assetId = seedAsset({ status: "inactive" });
    const categoryId = seedCategory(assetId);

    await engine.generateFindings(ALICE, NOW);

    const finding = findings().find((row) => row.rule_id === "R-002");
    expect(finding?.evidence_refs_json).toEqual({
      assetIds: [assetId],
      dataCategoryIds: [categoryId],
    });
  });

  it("puts the finding on the user's timeline", async () => {
    seedAsset({ last_verified_at: daysAgo(400) });

    await engine.generateFindings(ALICE, NOW);

    expect(activity().map((row) => row.event_type)).toContain("finding.opened");
  });

  it("asks for a score recalculation when something changed", async () => {
    // §11.2 lists finding state changes among the recalculation triggers.
    seedAsset({ last_verified_at: daysAgo(400) });

    await engine.generateFindings(ALICE, NOW);

    expect(scored).toHaveLength(1);
    expect(scored[0]?.reason).toBe("finding.changed");
  });

  it("asks for nothing when nothing changed", async () => {
    seedAsset({ last_verified_at: daysAgo(1) });

    await engine.generateFindings(ALICE, NOW);

    expect(scored).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("does not duplicate a finding when run twice", async () => {
    // §14 requires jobs to be idempotent. The dedup key is what makes that true.
    seedAsset({ last_verified_at: daysAgo(400) });

    await engine.generateFindings(ALICE, NOW);
    const second = await engine.generateFindings(ALICE, NOW);

    expect(second.opened).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(findings()).toHaveLength(1);
  });

  it("writes one timeline entry, not one per run", async () => {
    seedAsset({ last_verified_at: daysAgo(400) });

    await engine.generateFindings(ALICE, NOW);
    await engine.generateFindings(ALICE, NOW);

    expect(activity().filter((row) => row.event_type === "finding.opened")).toHaveLength(1);
  });

  it("gives the same condition the same key across runs", async () => {
    seedAsset({ last_verified_at: daysAgo(400) });

    await engine.generateFindings(ALICE, NOW);
    const first = findings()[0]?.dedup_key;
    await engine.generateFindings(ALICE, NOW);

    expect(findings()[0]?.dedup_key).toBe(first);
  });
});

describe("auto-resolution", () => {
  it("resolves a finding whose condition has cleared", async () => {
    const assetId = seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);

    // The user reviews the asset: the predicate stops holding.
    const asset = tableOf("digital_assets").get(assetId);
    if (asset) asset.last_verified_at = daysAgo(1);

    const outcome = await engine.generateFindings(ALICE, NOW);

    expect(outcome.autoResolved).toBe(1);
    expect(findings()[0]?.status).toBe("resolved");
  });

  it("records the system as the resolver, not the user", async () => {
    /**
     * §11.1's distinction, and ADR-004 depends on it: the protective-actions
     * factor credits resolutions, so recording the user here would pay them for
     * a condition that simply expired.
     */
    const assetId = seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    const asset = tableOf("digital_assets").get(assetId);
    if (asset) asset.last_verified_at = daysAgo(1);

    await engine.generateFindings(ALICE, NOW);

    expect(findings()[0]?.resolved_by).toBe("system");
    expect(findings()[0]?.resolved_at).toBeTruthy();
  });

  it("announces it on the timeline", async () => {
    const assetId = seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    const asset = tableOf("digital_assets").get(assetId);
    if (asset) asset.last_verified_at = daysAgo(1);

    await engine.generateFindings(ALICE, NOW);

    expect(activity().map((row) => row.event_type)).toContain("finding.auto_resolved");
  });

  it("leaves a dismissed finding dismissed rather than resolving it", async () => {
    // A dismissed finding's condition clearing is not a second ending, and
    // ADR-004 keeps deducting for it until the condition actually clears.
    const assetId = seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    const finding = findings()[0];
    if (finding) {
      finding.status = "dismissed";
      finding.resolved_by = "user";
      finding.resolved_at = daysAgo(0);
    }

    const asset = tableOf("digital_assets").get(assetId);
    if (asset) asset.last_verified_at = daysAgo(1);
    await engine.generateFindings(ALICE, NOW);

    expect(findings()[0]?.status).toBe("dismissed");
    expect(findings()[0]?.resolved_by).toBe("user");
  });

  it("does not re-raise a dismissed finding while its inputs are unchanged", async () => {
    // §11.1: not re-raised for the same dedup key unless the inputs materially
    // change. Nothing about the user's records moved, so the dismissal stands.
    seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    dismiss();

    const outcome = await engine.generateFindings(ALICE, NOW);

    expect(outcome.opened).toBe(0);
    expect(outcome.reopened).toBe(0);
    expect(findings()).toHaveLength(1);
    expect(findings()[0]?.status).toBe("dismissed");
  });

  it("keeps it dismissed even as more time passes", async () => {
    /**
     * The decision a user feels. Time passing is not a change to their records,
     * so a dismissal is not quietly overridden on a timer — it takes an actual
     * edit to bring the finding back.
     */
    seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    dismiss();

    const muchLater = new Date(NOW.getTime() + 500 * 86_400_000);
    const outcome = await engine.generateFindings(ALICE, muchLater);

    expect(outcome.reopened).toBe(0);
    expect(findings()[0]?.status).toBe("dismissed");
  });
});

/** Dismisses the single seeded finding, the way ATL-040's service will. */
const dismiss = (): void => {
  const finding = findings()[0];
  if (!finding) throw new Error("expected a finding to dismiss");
  finding.status = "dismissed";
  finding.resolved_by = "user";
  finding.resolved_at = daysAgo(0);
};

describe("ATL-102 · re-fire after a material input change", () => {
  it("reopens a dismissed finding when the inputs change", async () => {
    /**
     * The lifecycle the ticket names: fire → dismiss → input change → re-fire.
     * The condition is still true *and* the records underneath it are different,
     * which is exactly what §11.1 means by materially changed.
     */
    const assetId = seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    dismiss();

    // The user reviews it, then lets it go stale again by a different route:
    // the asset changes status, which R-001 reads.
    const asset = tableOf("digital_assets").get(assetId);
    if (asset) asset.source_type = "import";

    const outcome = await engine.generateFindings(ALICE, NOW);

    expect(outcome.reopened).toBe(1);
    expect(findings()[0]?.status).toBe("open");
  });

  it("reopens the existing row rather than inserting a second", async () => {
    // ATL-038's `unique (user_id, dedup_key)` makes a duplicate impossible, and
    // ADR-004 counts open findings — a returning condition restores one
    // deduction rather than accumulating two.
    const assetId = seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    const originalId = findings()[0]?.id;
    dismiss();

    const asset = tableOf("digital_assets").get(assetId);
    if (asset) asset.source_type = "import";
    await engine.generateFindings(ALICE, NOW);

    expect(findings()).toHaveLength(1);
    expect(findings()[0]?.id).toBe(originalId);
  });

  it("clears the resolution when it reopens", async () => {
    // ATL-038's check constraint refuses an open finding that still names a
    // resolver, so this is enforced twice.
    const assetId = seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    dismiss();

    const asset = tableOf("digital_assets").get(assetId);
    if (asset) asset.source_type = "import";
    await engine.generateFindings(ALICE, NOW);

    expect(findings()[0]?.resolved_by).toBeNull();
    expect(findings()[0]?.resolved_at).toBeNull();
  });

  it("refreshes severity and confidence from the new inputs", async () => {
    // A finding that returned at its old severity would describe a state that no
    // longer exists. `import` caps confidence at medium (§11.1's source model).
    const assetId = seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    expect(findings()[0]?.confidence).toBe("low");
    dismiss();

    const asset = tableOf("digital_assets").get(assetId);
    if (asset) {
      asset.source_type = "import";
      asset.last_verified_at = daysAgo(200);
    }
    await engine.generateFindings(ALICE, NOW);

    expect(findings()[0]?.status).toBe("open");
    expect(findings()[0]?.confidence).toBe("medium");
  });

  it("announces the return and asks for a score recalculation", async () => {
    const assetId = seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    dismiss();
    scored.length = 0;

    const asset = tableOf("digital_assets").get(assetId);
    if (asset) asset.source_type = "import";
    await engine.generateFindings(ALICE, NOW);

    expect(activity().filter((row) => row.event_type === "finding.opened")).toHaveLength(2);
    expect(scored).toHaveLength(1);
  });

  it("stores the hash when a finding is first written", async () => {
    seedAsset({ last_verified_at: daysAgo(400) });

    await engine.generateFindings(ALICE, NOW);

    expect(findings()[0]?.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves a pre-ATL-102 dismissal alone, and records its hash once", async () => {
    /**
     * Findings written before this column existed have no hash. Reading absence
     * as "changed" would resurrect every dismissal the moment this shipped;
     * reading it as "unchanged" would suppress a finding that should return. The
     * engine does neither — it records the hash without touching the status, and
     * the next evaluation has something real to compare.
     */
    seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);
    dismiss();
    const finding = findings()[0];
    if (finding) finding.input_hash = null;

    const outcome = await engine.generateFindings(ALICE, NOW);

    expect(outcome.reopened).toBe(0);
    expect(findings()[0]?.status).toBe("dismissed");
    expect(findings()[0]?.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not reopen a finding that is already open", async () => {
    // Nothing to do: the finding is already saying what the rule is saying.
    seedAsset({ last_verified_at: daysAgo(400) });
    await engine.generateFindings(ALICE, NOW);

    const outcome = await engine.generateFindings(ALICE, NOW);

    expect(outcome.reopened).toBe(0);
    expect(outcome.unchanged).toBe(1);
  });
});

describe("demo isolation", () => {
  it("evaluates demo records only, and labels what it produces", async () => {
    // §11.1 and §11.2: demo and real records never mix in one calculation.
    seedAsset({ source_type: "demo", last_verified_at: daysAgo(400), service_name: "Demo Co" });

    await engine.generateFindings(ALICE, NOW);

    expect(findings()).toHaveLength(1);
    expect(findings()[0]?.source_type).toBe("demo");
  });

  it("ignores real records entirely while demo data is present", async () => {
    seedAsset({ source_type: "demo", last_verified_at: daysAgo(400), service_name: "Demo Co" });
    seedAsset({ source_type: "manual", last_verified_at: daysAgo(400), service_name: "Real Co" });

    await engine.generateFindings(ALICE, NOW);

    expect(findings()).toHaveLength(1);
    expect(findings().every((row) => row.source_type === "demo")).toBe(true);
  });

  it("labels findings from real records as manual", async () => {
    seedAsset({ source_type: "manual", last_verified_at: daysAgo(400) });

    await engine.generateFindings(ALICE, NOW);

    expect(findings()[0]?.source_type).toBe("manual");
  });
});

describe("the nightly sweep", () => {
  it("is the same evaluation at a later time", async () => {
    /**
     * §11.1's time-based predicates become true with the passage of time rather
     * than with a mutation, which is the whole reason the sweep exists. Nothing
     * fires today; the same records fire a year on.
     */
    seedAsset({ last_verified_at: daysAgo(10) });

    await engine.generateFindings(ALICE, NOW);
    expect(findings()).toHaveLength(0);

    const later = new Date(NOW.getTime() + 200 * 86_400_000);
    await engine.runNightlySweep([ALICE], later);

    expect(findings()).toHaveLength(1);
  });

  it("reports how many users it evaluated", async () => {
    seedAsset({ last_verified_at: daysAgo(400) });

    expect(await engine.runNightlySweep([ALICE], NOW)).toBe(1);
  });
});
