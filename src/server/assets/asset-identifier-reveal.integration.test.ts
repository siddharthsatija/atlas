import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { MASK_CHAR } from "@/lib/formatting/mask";

/**
 * ATL-035 — deliberate, audited reveal.
 *
 * The criteria this file exists to hold to account:
 *
 *  - reveal is explicit and returns the value only to its owner;
 *  - **reveal actions emit audit events** — so a reveal that was not audited
 *    must not return a value at all;
 *  - the audit record carries no sensitive value.
 *
 * The real `AssetService`, `DigitalAssetRepository`, `EncryptionService`,
 * `AuditWriter` and hashing all run; only PostgREST is faked. Mocking the audit
 * writer would test the mock, and the ordering between "audited" and "returned"
 * is precisely the thing worth asserting.
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
const IDENTIFIER = "dana.scully@example.com";

type Row = Record<string, unknown>;
const tables = new Map<string, Map<string, Row>>();
const tableOf = (name: string) => {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name) as Map<string, Row>;
};

/** Tables whose writes should fail, so the audit outage can be simulated. */
const brokenTables = new Set<string>();

function createDb(): SupabaseClient<Database> {
  const builder = (tableName: string) => {
    const store = tableOf(tableName);
    let operation: "select" | "insert" = "select";
    let pending: Row = {};
    const filters: { column: string; value: unknown }[] = [];

    const matching = () =>
      [...store.values()].filter((row) => filters.every((f) => row[f.column] === f.value));

    const run = () => {
      if (operation === "insert") {
        if (brokenTables.has(tableName)) {
          return { data: null, error: { message: "store unavailable" } };
        }
        return { data: [{ ...pending }], error: null };
      }
      return { data: matching().map((row) => ({ ...row })), error: null };
    };

    const self = {
      select: () => self,
      eq: (column: string, value: unknown) => {
        filters.push({ column, value });
        return self;
      },
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
          deleted_at: null,
          candidate_id: null,
          ...values,
        };
        if (!brokenTables.has(tableName)) store.set(String(pending.id), { ...pending });
        return self;
      },
      single: () => {
        const result = run();
        return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error ?? null });
      },
      maybeSingle: () => {
        const result = run();
        return Promise.resolve({
          data: operation === "select" ? (matching()[0] ?? null) : (result.data?.[0] ?? null),
          error: result.error ?? null,
        });
      },
      then: (resolve: (result: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };

    return self;
  };

  return { from: (table: string) => builder(table) } as unknown as SupabaseClient<Database>;
}

const { AssetService } = await import("./asset-service");

let service: InstanceType<typeof AssetService>;

const auditRows = () => [...tableOf("audit_events").values()];

beforeEach(() => {
  tables.clear();
  brokenTables.clear();
  service = new AssetService(createDb());
});

const create = async (identifier: string | null = IDENTIFIER) => {
  const result = await service.createAsset(ALICE, {
    serviceName: "Spotify",
    category: "entertainment",
    ...(identifier ? { accountIdentifier: identifier } : {}),
  });
  if (!result.ok) throw new Error(`create failed: ${result.code}`);
  return result.data;
};

describe("revealing an identifier", () => {
  it("returns the full value to its owner", async () => {
    const asset = await create();

    const result = await service.revealAccountIdentifier(ALICE, asset.id);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(IDENTIFIER);
  });

  it("writes an audit event of the reserved type", async () => {
    // `personal_field.revealed` is already in AUDIT_EVENT_TYPES, commented for
    // this ticket. No new vocabulary and no migration were needed.
    const asset = await create();

    await service.revealAccountIdentifier(ALICE, asset.id);

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]?.event_type).toBe("personal_field.revealed");
  });

  it("records which asset was revealed, and nothing about the value", async () => {
    const asset = await create();

    await service.revealAccountIdentifier(ALICE, asset.id);

    const event = auditRows()[0];
    expect(event?.entity_type).toBe("asset");
    expect(event?.entity_id).toBe(asset.id);

    /**
     * The whole row, not just the context: ADR-006 forbids the audit trail
     * becoming a second copy of the data it protects, and a value could leak
     * through any column, not only the one intended to carry detail.
     */
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain(IDENTIFIER);
    expect(serialised).not.toContain("dana.scully");
    // Not even the masked form — a mask is still derived from the value.
    expect(serialised).not.toContain(MASK_CHAR);
  });

  it("identifies the user pseudonymously, never by id", async () => {
    // ADR-006's subject reference is an HMAC, so the audit table alone does not
    // map events back to a user id that appears in URLs and support tickets.
    const asset = await create();

    await service.revealAccountIdentifier(ALICE, asset.id);

    expect(JSON.stringify(auditRows()[0])).not.toContain(ALICE);
  });

  it("audits every reveal, not just the first", async () => {
    // One row per disclosure. Deduplicating would make the log understate how
    // often a value was exposed, which is the number an audit exists to answer.
    const asset = await create();

    await service.revealAccountIdentifier(ALICE, asset.id);
    await service.revealAccountIdentifier(ALICE, asset.id);

    expect(auditRows()).toHaveLength(2);
  });
});

describe("nothing recorded", () => {
  it("returns null rather than a value", async () => {
    const asset = await create(null);

    const result = await service.revealAccountIdentifier(ALICE, asset.id);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBeNull();
  });

  it("writes no audit event, because nothing was disclosed", async () => {
    // An entry here would assert a disclosure that did not happen.
    const asset = await create(null);

    await service.revealAccountIdentifier(ALICE, asset.id);

    expect(auditRows()).toHaveLength(0);
  });
});

describe("ownership", () => {
  it("refuses another user's asset", async () => {
    const asset = await create();

    const result = await service.revealAccountIdentifier(BOB, asset.id);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("NOT_FOUND");
  });

  it("answers a missing asset identically, so an id cannot be probed", async () => {
    const foreign = await service.revealAccountIdentifier(BOB, (await create()).id);
    const missing = await service.revealAccountIdentifier(BOB, randomUUID());

    expect(foreign.ok === false && foreign.code).toBe(missing.ok === false && missing.code);
  });

  it("decrypts nothing and audits nothing for a refused reveal", async () => {
    const asset = await create();

    await service.revealAccountIdentifier(BOB, asset.id);

    expect(auditRows()).toHaveLength(0);
  });
});

describe("an unaudited reveal is impossible", () => {
  it("returns no value when the audit append fails", async () => {
    /**
     * The criterion is "reveal actions emit audit events". If the value could be
     * returned when the append failed, that criterion would hold only while the
     * audit store was healthy — which is exactly when it does not matter.
     */
    const asset = await create();
    brokenTables.add("audit_events");

    const result = await service.revealAccountIdentifier(ALICE, asset.id);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("UNAVAILABLE");
  });

  it("leaves no audit row behind either, so the refusal is honest", async () => {
    const asset = await create();
    brokenTables.add("audit_events");

    await service.revealAccountIdentifier(ALICE, asset.id);

    expect(auditRows()).toHaveLength(0);
  });

  it("keeps refusing while the audit store is down", async () => {
    // Not a one-off: no retry path quietly gives up on auditing and succeeds.
    const asset = await create();
    brokenTables.add("audit_events");

    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await service.revealAccountIdentifier(ALICE, asset.id)).ok).toBe(false);
    }
  });

  it("recovers once the audit store returns", async () => {
    const asset = await create();
    brokenTables.add("audit_events");
    await service.revealAccountIdentifier(ALICE, asset.id);

    brokenTables.delete("audit_events");
    const result = await service.revealAccountIdentifier(ALICE, asset.id);

    expect(result.ok && result.data).toBe(IDENTIFIER);
    expect(auditRows()).toHaveLength(1);
  });
});

describe("the two identifier reads stay distinct", () => {
  it("exposes exactly one masked read and one audited reveal", () => {
    /**
     * The structural guarantee, updated for ATL-035. Before this ticket the only
     * identifier method was the masked read; now there is exactly one more, and
     * it is the audited one. A third — an unaudited plaintext read added for
     * convenience — would be caught here.
     */
    const methods = Object.getOwnPropertyNames(AssetService.prototype)
      .filter((name) => /identifier/i.test(name))
      .sort();

    expect(methods).toEqual(["readMaskedAccountIdentifier", "revealAccountIdentifier"]);
  });

  it("still masks on the default read after a reveal", async () => {
    // Revealing is a one-off disclosure, not a mode the record stays in.
    const asset = await create();
    await service.revealAccountIdentifier(ALICE, asset.id);

    const masked = await service.readMaskedAccountIdentifier(ALICE, asset.id);

    expect(masked.ok && masked.data).toContain(MASK_CHAR);
    expect(masked.ok && masked.data).not.toContain("dana.scully");
  });
});
