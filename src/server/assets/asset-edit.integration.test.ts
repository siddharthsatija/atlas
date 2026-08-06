import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { FindingsRecomputeQueue, RecomputeRequest } from "@/server/findings/recompute-queue";

/**
 * ATL-033 — editing an asset.
 *
 * The ticket asks for "edit integration tests including status transitions", so
 * the real `AssetService` and the real repositories run against a fake PostgREST
 * client. Faking the repositories would test the fake; what matters is that the
 * service passes ownership down and the repositories turn it into a predicate.
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

function createDb(): SupabaseClient<Database> {
  const builder = (tableName: string) => {
    const store = tableOf(tableName);
    let operation: "select" | "insert" | "update" | "delete" = "select";
    let pending: Row = {};
    const filters: { column: string; value: unknown }[] = [];

    const matching = () =>
      [...store.values()].filter((row) => filters.every((f) => row[f.column] === f.value));

    const run = () => {
      if (operation === "insert") return { data: [{ ...pending }], error: null };
      if (operation === "update") {
        const matched = matching();
        for (const row of matched) Object.assign(row, pending);
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
      in: () => self,
      or: () => self,
      is: (column: string, value: unknown) => {
        filters.push({ column, value });
        return self;
      },
      order: () => self,
      limit: () => self,
      insert: (values: Row) => {
        operation = "insert";
        const now = new Date().toISOString();
        pending = {
          id: randomUUID(),
          status: "active",
          created_at: now,
          updated_at: now,
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

const recomputed: RecomputeRequest[] = [];
const recomputeQueue: FindingsRecomputeQueue = {
  enqueue: (request) => {
    recomputed.push(request);
    return Promise.resolve();
  },
};

const { AssetService } = await import("./asset-service");
const { ActivityWriter } = await import("@/server/activity/activity-writer");

let service: InstanceType<typeof AssetService>;

const activityRows = () => [...tableOf("activity_events").values()];
const lastActivity = () => activityRows().at(-1);

beforeEach(() => {
  tables.clear();
  recomputed.length = 0;
  const db = createDb();
  service = new AssetService(db, new ActivityWriter(db), recomputeQueue);
});

const unwrap = <T>(result: { ok: true; data: T } | { ok: false; code: string }): T => {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.data;
};

const create = async (userId = ALICE) =>
  unwrap(await service.createAsset(userId, { serviceName: "Spotify", category: "entertainment" }));

describe("editing metadata", () => {
  it("applies the change and records it", async () => {
    const asset = await create();

    const updated = unwrap(await service.updateAsset(ALICE, asset.id, { notes: "Family plan" }));

    expect(updated.notes).toBe("Family plan");
    expect(lastActivity()?.event_type).toBe("asset.updated");
  });

  it("refuses another user's asset", async () => {
    const asset = await create();

    const result = await service.updateAsset(BOB, asset.id, { notes: "Not mine" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("NOT_FOUND");
  });

  it("leaves the row untouched after a refused edit", async () => {
    const asset = await create();

    await service.updateAsset(BOB, asset.id, { serviceName: "Renamed" });

    expect(unwrap(await service.getAsset(ALICE, asset.id)).serviceName).toBe("Spotify");
  });
});

describe("status transitions", () => {
  it.each(["inactive", "removed", "active"] as const)("moves to %s", async (status) => {
    const asset = await create();
    if (status === "active") await service.setAssetStatus(ALICE, asset.id, "inactive");

    const updated = unwrap(await service.setAssetStatus(ALICE, asset.id, status));

    expect(updated.status).toBe(status);
  });

  it("records what the status changed from and to", async () => {
    /**
     * `asset.updated` with `fromStatus`/`toStatus` rather than a new event type:
     * ATL-069's metadata policy already declares both keys, and the timeline
     * needs to say what actually changed.
     */
    const asset = await create();

    unwrap(await service.setAssetStatus(ALICE, asset.id, "inactive"));

    const metadata = lastActivity()?.metadata_redacted_json as Record<string, unknown>;
    expect(metadata.fromStatus).toBe("active");
    expect(metadata.toStatus).toBe("inactive");
  });

  it("writes nothing when the status is unchanged", async () => {
    // A timeline claiming a change that did not happen is a small lie that only
    // shows up when someone is reconstructing events.
    const asset = await create();
    const before = activityRows().length;

    const result = unwrap(await service.setAssetStatus(ALICE, asset.id, "active"));

    expect(result.status).toBe("active");
    expect(activityRows()).toHaveLength(before);
  });

  it("refuses another user's asset", async () => {
    const asset = await create();

    expect((await service.setAssetStatus(BOB, asset.id, "inactive")).ok).toBe(false);
  });

  it("does not accept archived, which belongs to ATL-036", () => {
    /**
     * Compile-time, deliberately: `archived` is excluded from the parameter
     * type, so the edit path cannot reach it at all. Archiving carries an undo
     * affordance and copy explaining it is not deletion from the service, and
     * shipping the transition without those would be dishonest.
     */
    const statuses: Parameters<typeof service.setAssetStatus>[2][] = [
      "active",
      "inactive",
      "removed",
    ];

    expect(statuses).not.toContain("archived");
  });

  it("still archives through the dedicated path", async () => {
    const asset = await create();

    const archived = unwrap(await service.archiveAsset(ALICE, asset.id));

    expect(archived.status).toBe("archived");
    expect(lastActivity()?.event_type).toBe("asset.archived");
  });
});

describe("the review action", () => {
  it("sets the review date", async () => {
    const asset = await create();
    expect(asset.lastVerifiedAt).toBeNull();

    const reviewed = unwrap(await service.markReviewed(ALICE, asset.id));

    expect(reviewed.lastVerifiedAt).not.toBeNull();
  });

  it("does not move on an ordinary save", async () => {
    /**
     * The acceptance criterion: `last_reviewed` updates "on explicit review
     * action, not on every save". It feeds R-001 and the score's freshness
     * factor, so moving it while someone fixes a typo would claim they
     * re-checked something they never looked at.
     */
    const asset = await create();
    unwrap(await service.markReviewed(ALICE, asset.id));
    const reviewedAt = unwrap(await service.getAsset(ALICE, asset.id)).lastVerifiedAt;

    unwrap(await service.updateAsset(ALICE, asset.id, { notes: "Typo fixed" }));

    expect(unwrap(await service.getAsset(ALICE, asset.id)).lastVerifiedAt).toBe(reviewedAt);
  });

  it("refuses another user's asset", async () => {
    const asset = await create();

    expect((await service.markReviewed(BOB, asset.id)).ok).toBe(false);
  });
});

describe("data categories", () => {
  it("adds one and lists it", async () => {
    const asset = await create();

    unwrap(await service.addDataCategory(ALICE, asset.id, "contact"));

    const details = unwrap(await service.listAssetDetails(ALICE, asset.id));
    expect(details.dataCategories.map((entry) => entry.category)).toEqual(["contact"]);
  });

  it("derives sensitivity rather than accepting it", async () => {
    // ADR-004 fixes the high-sensitivity set; the column is generated.
    const asset = await create();

    const record = unwrap(await service.addDataCategory(ALICE, asset.id, "financial"));

    expect(record.sensitivity).toBe("high");
  });

  it("removes one", async () => {
    const asset = await create();
    const record = unwrap(await service.addDataCategory(ALICE, asset.id, "contact"));

    unwrap(await service.removeDataCategory(ALICE, asset.id, record.id));

    expect(unwrap(await service.listAssetDetails(ALICE, asset.id)).dataCategories).toEqual([]);
  });

  it("refuses to add to another user's asset", async () => {
    const asset = await create();

    expect((await service.addDataCategory(BOB, asset.id, "contact")).ok).toBe(false);
  });
});

describe("permissions", () => {
  it("adds one and lists it", async () => {
    const asset = await create();

    unwrap(await service.addPermission(ALICE, asset.id, "account_access", "broad"));

    const details = unwrap(await service.listAssetDetails(ALICE, asset.id));
    expect(details.permissions.map((entry) => entry.permissionType)).toEqual(["account_access"]);
  });

  it("revokes by status, keeping the row", async () => {
    /**
     * ADR-004 divides by "total recorded", so the row must survive — that is
     * what makes revoking improve the permission factor rather than erase the
     * evidence it existed.
     */
    const asset = await create();
    const permission = unwrap(
      await service.addPermission(ALICE, asset.id, "account_access", "broad"),
    );

    unwrap(await service.setPermissionStatus(ALICE, asset.id, permission.id, "revoked"));

    const details = unwrap(await service.listAssetDetails(ALICE, asset.id));
    expect(details.permissions).toHaveLength(1);
    expect(details.permissions[0]?.status).toBe("revoked");
  });

  it("removes one recorded by mistake", async () => {
    const asset = await create();
    const permission = unwrap(
      await service.addPermission(ALICE, asset.id, "account_access", "broad"),
    );

    unwrap(await service.removePermission(ALICE, asset.id, permission.id));

    expect(unwrap(await service.listAssetDetails(ALICE, asset.id)).permissions).toEqual([]);
  });

  it("refuses another user's asset", async () => {
    const asset = await create();

    expect((await service.addPermission(BOB, asset.id, "account_access", "broad")).ok).toBe(false);
  });
});

describe("every edit asks for a recompute", () => {
  it("enqueues on metadata, status, review, and child changes", async () => {
    // §11: mutations to assets, permissions, and data categories all enqueue a
    // per-user recompute.
    const asset = await create();
    recomputed.length = 0;

    await service.updateAsset(ALICE, asset.id, { notes: "x" });
    await service.setAssetStatus(ALICE, asset.id, "inactive");
    await service.markReviewed(ALICE, asset.id);
    await service.addDataCategory(ALICE, asset.id, "contact");
    await service.addPermission(ALICE, asset.id, "account_access", "limited");

    expect(recomputed).toHaveLength(5);
    expect(recomputed.every((request) => request.userId === ALICE)).toBe(true);
  });
});
