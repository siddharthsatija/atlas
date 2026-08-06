import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { parseAssetQuery } from "@/lib/assets/asset-query";
import type { FindingsRecomputeQueue, RecomputeRequest } from "@/server/findings/recompute-queue";

/**
 * ATL-030 — service-level authorization, plus the activity and recompute
 * obligations every mutation carries.
 *
 * The acceptance criteria are about *behaviour at this layer*, so the real
 * `AssetService` and the real `DigitalAssetRepository` run against a fake
 * PostgREST client. Faking the repository would test the fake; the point is that
 * the service passes the user id down and the repository turns it into a
 * predicate.
 *
 * The database's own gate — RLS — is covered separately in
 * `tests/integration/digital-assets-rls.test.ts`. This service runs as
 * service-role, which bypasses it, which is exactly why the ownership assertions
 * below matter.
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

interface Filter {
  column: string;
  value: unknown;
  op: "eq" | "in" | "or";
  raw?: string;
}

/**
 * A fake PostgREST builder.
 *
 * It honours `eq`, `in`, `order`, `limit`, and enough of `or` to evaluate the
 * keyset predicate — deliberately, because a fake that ignored filters would let
 * every ownership assertion below pass while the real query returned another
 * user's rows.
 */
function createDb(): SupabaseClient<Database> {
  const builder = (tableName: string) => {
    const store = tableOf(tableName);
    let operation: "select" | "insert" | "update" | "delete" = "select";
    let pending: Row = {};
    const filters: Filter[] = [];
    const orders: { column: string; ascending: boolean }[] = [];
    let max = Infinity;

    const matchesOr = (row: Row, expression: string): boolean =>
      expression.split(/,(?![^(]*\))/).some((clause) => {
        if (clause.startsWith("and(")) {
          return clause
            .slice(4, -1)
            .split(",")
            .every((inner) => matchesOr(row, inner));
        }
        const [column, op, ...rest] = clause.split(".");
        const value = rest.join(".");
        const actual = row[column as string];
        if (op === "is") return actual === null;
        if (op === "lt") return String(actual) < value;
        if (op === "eq") return String(actual) === value;
        if (op === "ilike") {
          // PostgREST translates `*` to `%`; the value arrives double-quoted.
          const pattern = value.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
          const needle = pattern.replace(/^\*|\*$/g, "").toLowerCase();
          return typeof actual === "string" && actual.toLowerCase().includes(needle);
        }
        return false;
      });

    const matching = () =>
      [...store.values()].filter((row) =>
        filters.every((filter) => {
          if (filter.op === "eq") return row[filter.column] === filter.value;
          if (filter.op === "in") return (filter.value as unknown[]).includes(row[filter.column]);
          return matchesOr(row, filter.raw as string);
        }),
      );

    /** Narrowed rather than coerced: every sortable column here is a string. */
    const sortKey = (row: Row, column: string): string => {
      const value = row[column];
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    };

    const sorted = () => {
      const rows = matching();
      for (const { column, ascending } of [...orders].reverse()) {
        rows.sort((a, b) => {
          const left = sortKey(a, column);
          const right = sortKey(b, column);
          return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      return rows.slice(0, max);
    };

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
      return { data: sorted().map((row) => ({ ...row })), error: null };
    };

    const self = {
      select: () => self,
      eq: (column: string, value: unknown) => {
        filters.push({ column, value, op: "eq" });
        return self;
      },
      in: (column: string, value: unknown[]) => {
        filters.push({ column, value, op: "in" });
        return self;
      },
      or: (raw: string) => {
        orExpressions.push(raw);
        filters.push({ column: "", value: null, op: "or", raw });
        return self;
      },
      is: (column: string, value: unknown) => {
        filters.push({ column, value, op: "eq" });
        return self;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        orders.push({ column, ascending: options?.ascending ?? true });
        return self;
      },
      limit: (count: number) => {
        max = count;
        return self;
      },
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
      upsert: (values: Row) => {
        operation = "insert";
        pending = { id: randomUUID(), status: "active", ...values };
        if (!store.has(String(pending.id))) store.set(String(pending.id), { ...pending });
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
          data: operation === "select" ? (sorted()[0] ?? null) : (run().data[0] ?? null),
          error: null,
        }),
      then: (resolve: (result: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };

    return self;
  };

  return { from: (table: string) => builder(table) } as unknown as SupabaseClient<Database>;
}

/** Every raw `or` expression the repository built, so escaping can be asserted. */
const orExpressions: string[] = [];

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

beforeEach(() => {
  tables.clear();
  recomputed.length = 0;
  orExpressions.length = 0;
  const db = createDb();
  service = new AssetService(db, new ActivityWriter(db), recomputeQueue);
});

const unwrap = <T>(result: { ok: true; data: T } | { ok: false; code: string }): T => {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.data;
};

const createFor = (userId: string, serviceName = "Spotify") =>
  service.createAsset(userId, { serviceName, category: "entertainment" });

const query = (input: Record<string, unknown> = {}) => parseAssetQuery(input).query;

describe("ownership is enforced in the service layer", () => {
  it.each([
    ["getAsset", (id: string) => service.getAsset(BOB, id)],
    ["updateAsset", (id: string) => service.updateAsset(BOB, id, { serviceName: "Renamed" })],
    ["archiveAsset", (id: string) => service.archiveAsset(BOB, id)],
    ["restoreAsset", (id: string) => service.restoreAsset(BOB, id)],
    ["deleteAsset", (id: string) => service.deleteAsset(BOB, id)],
  ])("%s refuses another user's asset", async (_label, call) => {
    const asset = unwrap(await createFor(ALICE));

    const result = await call(asset.id);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("NOT_FOUND");
  });

  it("answers identically for a foreign asset and one that does not exist", async () => {
    /**
     * ATL-034 requires 404 rather than 403 for a cross-user read. `FORBIDDEN` on
     * a record you do not own confirms it exists, which turns a guessed id into
     * an oracle.
     */
    const asset = unwrap(await createFor(ALICE));

    const foreign = await service.getAsset(BOB, asset.id);
    const missing = await service.getAsset(BOB, randomUUID());

    expect(foreign).toEqual(missing);
  });

  it("leaves another user's asset untouched after a refused update", async () => {
    const asset = unwrap(await createFor(ALICE, "Original"));

    await service.updateAsset(BOB, asset.id, { serviceName: "Renamed by Bob" });

    expect(unwrap(await service.getAsset(ALICE, asset.id)).serviceName).toBe("Original");
  });

  it("never lists another user's assets", async () => {
    await createFor(ALICE, "Alice Service");
    await createFor(BOB, "Bob Service");

    const page = unwrap(await service.listAssets(ALICE, query()));

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.serviceName).toBe("Alice Service");
  });

  it("attributes a created asset to the session user, whatever the input says", async () => {
    // Architecture §10: a client-supplied `user_id` is never authority. The
    // input type has no such field, and this asserts the value that is used.
    const smuggled = {
      serviceName: "Spotify",
      category: "entertainment",
      userId: BOB,
    } as unknown as Parameters<typeof service.createAsset>[1];

    const asset = unwrap(await service.createAsset(ALICE, smuggled));

    expect(asset.userId).toBe(ALICE);
  });
});

describe("mutations emit activity and enqueue recompute", () => {
  it.each([["create", async () => unwrap(await createFor(ALICE)), "asset.created"]])(
    "%s",
    async (_label, act, expected) => {
      await act();

      expect(activityRows()).toHaveLength(1);
      expect(activityRows()[0]?.event_type).toBe(expected);
      expect(recomputed).toEqual([{ userId: ALICE, reason: expected }]);
    },
  );

  it("emits on update, archive, restore, and delete", async () => {
    const asset = unwrap(await createFor(ALICE));

    await service.updateAsset(ALICE, asset.id, { notes: "Checked" });
    await service.archiveAsset(ALICE, asset.id);
    await service.restoreAsset(ALICE, asset.id);
    await service.deleteAsset(ALICE, asset.id);

    expect(activityRows().map((row) => row.event_type)).toEqual([
      "asset.created",
      "asset.updated",
      "asset.archived",
      "asset.restored",
      "asset.deleted",
    ]);
    expect(recomputed.map((request) => request.reason)).toEqual([
      "asset.created",
      "asset.updated",
      "asset.archived",
      "asset.restored",
      "asset.deleted",
    ]);
  });

  it("links the activity entry to the asset", async () => {
    const asset = unwrap(await createFor(ALICE));

    expect(activityRows()[0]?.entity_type).toBe("asset");
    expect(activityRows()[0]?.entity_id).toBe(asset.id);
  });

  it("emits nothing when a mutation was refused", async () => {
    // A timeline entry for something that did not happen is worse than none.
    const asset = unwrap(await createFor(ALICE));

    await service.updateAsset(BOB, asset.id, { serviceName: "Nope" });

    expect(activityRows()).toHaveLength(1);
    expect(recomputed).toHaveLength(1);
  });

  it("does not fail the mutation when the recompute queue throws", async () => {
    /**
     * The write already succeeded and is the user's. Failing their request
     * afterwards because a background hint could not be queued would lose the
     * change they actually asked for.
     */
    const db = createDb();
    const failing: FindingsRecomputeQueue = {
      enqueue: () => Promise.reject(new Error("queue down")),
    };
    const resilient = new AssetService(db, new ActivityWriter(db), failing);

    const result = await resilient.createAsset(ALICE, {
      serviceName: "Spotify",
      category: "entertainment",
    });

    expect(result.ok).toBe(true);
  });
});

describe("archive and restore", () => {
  it("archives an active asset and restores it", async () => {
    const asset = unwrap(await createFor(ALICE));

    expect(unwrap(await service.archiveAsset(ALICE, asset.id)).status).toBe("archived");
    expect(unwrap(await service.restoreAsset(ALICE, asset.id)).status).toBe("active");
  });

  it("refuses to archive twice", async () => {
    /**
     * The transition is conditional in SQL, so a repeat answers NOT_FOUND rather
     * than emitting a second event. A timeline claiming the same asset was
     * archived twice is a small lie nobody notices until they are reconstructing
     * what happened.
     */
    const asset = unwrap(await createFor(ALICE));
    await service.archiveAsset(ALICE, asset.id);

    const again = await service.archiveAsset(ALICE, asset.id);

    expect(again.ok).toBe(false);
    expect(activityRows().filter((row) => row.event_type === "asset.archived")).toHaveLength(1);
  });

  it("refuses to restore an asset that was never archived", async () => {
    const asset = unwrap(await createFor(ALICE));

    expect((await service.restoreAsset(ALICE, asset.id)).ok).toBe(false);
  });
});

describe("filters and pagination", () => {
  const seed = async (count: number, overrides: Record<string, unknown> = {}) => {
    for (let index = 0; index < count; index += 1) {
      unwrap(
        await service.createAsset(ALICE, {
          serviceName: `Service ${String(index).padStart(2, "0")}`,
          category: "social",
          ...overrides,
        }),
      );
      // Distinct created_at values, so the ordering is unambiguous without
      // relying on the tiebreak.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  it("filters by category", async () => {
    unwrap(await service.createAsset(ALICE, { serviceName: "A", category: "social" }));
    unwrap(await service.createAsset(ALICE, { serviceName: "B", category: "finance" }));

    const page = unwrap(await service.listAssets(ALICE, query({ category: ["finance"] })));

    expect(page.items.map((item) => item.serviceName)).toEqual(["B"]);
  });

  it("filters by status", async () => {
    const asset = unwrap(await createFor(ALICE, "Archived One"));
    unwrap(await createFor(ALICE, "Active One"));
    await service.archiveAsset(ALICE, asset.id);

    const page = unwrap(await service.listAssets(ALICE, query({ status: ["archived"] })));

    expect(page.items.map((item) => item.serviceName)).toEqual(["Archived One"]);
  });

  it("filters by source", async () => {
    unwrap(
      await service.createAsset(ALICE, {
        serviceName: "Demo One",
        category: "social",
        sourceType: "demo",
      }),
    );
    unwrap(await createFor(ALICE, "Manual One"));

    const page = unwrap(await service.listAssets(ALICE, query({ source: ["demo"] })));

    expect(page.items.map((item) => item.serviceName)).toEqual(["Demo One"]);
  });

  it("combines filters", async () => {
    unwrap(
      await service.createAsset(ALICE, {
        serviceName: "Match",
        category: "finance",
        sourceType: "demo",
      }),
    );
    unwrap(
      await service.createAsset(ALICE, {
        serviceName: "Wrong category",
        category: "social",
        sourceType: "demo",
      }),
    );

    const page = unwrap(
      await service.listAssets(ALICE, query({ category: ["finance"], source: ["demo"] })),
    );

    expect(page.items.map((item) => item.serviceName)).toEqual(["Match"]);
  });

  it("returns newest first by default", async () => {
    await seed(3);

    const page = unwrap(await service.listAssets(ALICE, query()));

    expect(page.items.map((item) => item.serviceName)).toEqual([
      "Service 02",
      "Service 01",
      "Service 00",
    ]);
  });

  it("reverses for the oldest sort", async () => {
    await seed(3);

    const page = unwrap(await service.listAssets(ALICE, query({ sort: "oldest" })));

    expect(page.items.map((item) => item.serviceName)).toEqual([
      "Service 00",
      "Service 01",
      "Service 02",
    ]);
  });

  it("pages without repeating or skipping a row", async () => {
    await seed(5);

    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 5; page += 1) {
      const result: { items: { serviceName: string }[]; nextCursor: string | null } = unwrap(
        await service.listAssets(ALICE, query({ limit: 2, ...(cursor ? { cursor } : {}) })),
      );
      seen.push(...result.items.map((item) => item.serviceName));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toEqual(["Service 04", "Service 03", "Service 02", "Service 01", "Service 00"]);
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeNull();
  });

  it("stops offering a cursor on the last page", async () => {
    await seed(2);

    const page = unwrap(await service.listAssets(ALICE, query({ limit: 2 })));

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("returns an empty page rather than failing when nothing matches", async () => {
    await seed(1);

    const page = unwrap(await service.listAssets(ALICE, query({ category: ["health"] })));

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("the account identifier never leaves the service", () => {
  it("is absent from a created asset and from a list", async () => {
    // §8 masks identifiers by default; ATL-035 owns reveal.
    const asset = unwrap(
      await service.createAsset(ALICE, {
        serviceName: "Spotify",
        category: "entertainment",
        accountIdentifier: "dana.scully@example.com",
      }),
    );
    const page = unwrap(await service.listAssets(ALICE, query()));

    expect(asset.hasAccountIdentifier).toBe(true);
    expect(JSON.stringify(asset)).not.toContain("dana.scully");
    expect(JSON.stringify(page)).not.toContain("dana.scully");
  });
});

describe("search (ATL-031)", () => {
  it("matches a service name, case-insensitively", async () => {
    unwrap(await service.createAsset(ALICE, { serviceName: "Spotify", category: "entertainment" }));
    unwrap(await service.createAsset(ALICE, { serviceName: "Monzo", category: "finance" }));

    const page = unwrap(await service.listAssets(ALICE, query({ search: "spot" })));

    expect(page.items.map((item) => item.serviceName)).toEqual(["Spotify"]);
  });

  it("matches a domain", async () => {
    unwrap(
      await service.createAsset(ALICE, {
        serviceName: "Streaming",
        category: "entertainment",
        serviceDomain: "spotify.com",
      }),
    );

    const page = unwrap(await service.listAssets(ALICE, query({ search: "spotify.com" })));

    expect(page.items).toHaveLength(1);
  });

  it("never searches notes or the account identifier", async () => {
    /**
     * Notes are the one field a user may type anything into, and the identifier
     * is Restricted. A search that reached either would make a private value
     * discoverable from a URL — §8 makes encrypted columns non-searchable by
     * design, and this asserts the same for notes.
     */
    unwrap(
      await service.createAsset(ALICE, {
        serviceName: "Spotify",
        category: "entertainment",
        notes: "shared with Dana",
        accountIdentifier: "dana.scully@example.com",
      }),
    );

    expect(unwrap(await service.listAssets(ALICE, query({ search: "Dana" }))).items).toEqual([]);
    expect(unwrap(await service.listAssets(ALICE, query({ search: "scully" }))).items).toEqual([]);
  });

  it("combines with filters and stays scoped to the owner", async () => {
    unwrap(await service.createAsset(ALICE, { serviceName: "Spotify", category: "entertainment" }));
    unwrap(await service.createAsset(BOB, { serviceName: "Spotify", category: "entertainment" }));

    const page = unwrap(
      await service.listAssets(ALICE, query({ search: "spotify", category: ["entertainment"] })),
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.userId).toBe(ALICE);
  });

  it("quotes and escapes the term so it cannot rewrite the filter", async () => {
    /**
     * An `or` expression is a comma-separated mini-language. On a service-role
     * client — which bypasses RLS — a raw term containing `,` or `)` would be
     * query injection rather than a formatting bug.
     */
    await service.listAssets(ALICE, query({ search: 'a,b)"c\\d' }));

    const expression = orExpressions.at(-1) as string;
    expect(expression).toContain('service_name.ilike."');
    // Every quote and backslash inside the value is escaped.
    expect(expression).toContain('\\"');
    // The term's commas and parens sit inside the quotes, not between clauses:
    // exactly two clauses, one per column.
    expect(expression.split(/,(?=service_)/)).toHaveLength(2);
  });

  it("returns the filtered empty state's population when nothing matches", async () => {
    unwrap(await service.createAsset(ALICE, { serviceName: "Spotify", category: "entertainment" }));

    const page = unwrap(await service.listAssets(ALICE, query({ search: "nothing here" })));

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
