import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";

/**
 * ATL-027 — encryption round trip through the repository layer.
 *
 * Uses the **real** `EncryptionService`, envelope, and AAD binding against a fake
 * key store and a fake PostgREST client. Mocking the crypto would test the mock;
 * the acceptance criterion is specifically that the round trip works through
 * this layer, which means the ciphertext must really be produced and really be
 * opened again.
 *
 * Two-user RLS lives in `tests/integration/digital-assets-rls.test.ts` against a
 * real database.
 */

const KEK = Buffer.alloc(32, 9).toString("base64");

vi.mock("@/config/env", () => ({
  env: {
    ATLAS_KEK: KEK,
    ATLAS_KEK_VERSION: 1,
    AUDIT_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
  },
}));

interface AssetRow {
  id: string;
  user_id: string;
  service_name: string;
  service_domain: string | null;
  category: string;
  account_identifier_encrypted: string | null;
  status: string;
  source_type: string;
  source_label: string | null;
  confidence: string;
  last_verified_at: string | null;
  notes: string | null;
  metadata_json: unknown;
  created_at: string;
  updated_at: string;
}

const assets = new Map<string, AssetRow>();
/** Stands in for `user_encryption_keys`, which the real service reads and writes. */
const keys = new Map<string, Record<string, unknown>>();

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

/** A fake PostgREST builder covering the two tables the repository path touches. */
function createDb(): SupabaseClient<Database> {
  const builder = (table: string) => {
    const store: Map<string, Record<string, unknown>> = table === "digital_assets"
      ? (assets as unknown as Map<string, Record<string, unknown>>)
      : keys;

    let operation: "select" | "insert" | "update" = "select";
    let pending: Record<string, unknown> = {};
    const filters: { column: string; value: unknown }[] = [];

    const matching = () =>
      [...store.values()].filter((row) => filters.every((f) => row[f.column] === f.value));

    const run = () => {
      if (operation === "insert") return { data: [{ ...pending }], error: null };
      if (operation === "update") {
        const matched = matching();
        for (const row of matched) Object.assign(row, pending);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      return { data: matching().map((r) => ({ ...r })), error: null };
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
      /**
       * Applies the column defaults the real tables declare.
       *
       * `user_encryption_keys` generates `id`, `status`, and `created_at` in the
       * database, and the encryption service reads all three back. A fake that
       * returned the bare insert payload would hand the service a key row with no
       * id and no status, which it correctly refuses to use — so the fake has to
       * model the defaults or it tests the wrong thing.
       */
      insert: (values: Record<string, unknown>) => {
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
      upsert: (values: Record<string, unknown>) => {
        operation = "insert";
        pending = values;
        if (!store.has(String(values.id))) store.set(String(values.id), { ...values });
        return self;
      },
      update: (values: Record<string, unknown>) => {
        operation = "update";
        pending = values;
        return self;
      },
      single: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
      // Mirrors `single` for a write, so an insert reads back what it wrote
      // rather than whatever happened to be first in the store.
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

const { DigitalAssetRepository } = await import("./digital-asset-repository");

let repository: InstanceType<typeof DigitalAssetRepository>;

beforeEach(() => {
  assets.clear();
  keys.clear();
  repository = new DigitalAssetRepository(createDb());
});

const create = (overrides: Record<string, unknown> = {}) =>
  repository.create({
    userId: ALICE,
    serviceName: "Spotify",
    category: "entertainment",
    accountIdentifier: "dana.scully@example.com",
    ...overrides,
  });

describe("the encryption round trip", () => {
  it("returns the identifier it was given", async () => {
    const asset = await create();

    await expect(repository.readAccountIdentifier(ALICE, asset.id)).resolves.toBe(
      "dana.scully@example.com",
    );
  });

  it("stores ciphertext, never the plaintext", async () => {
    const asset = await create();

    const stored = assets.get(asset.id);
    expect(stored?.account_identifier_encrypted).toBeTruthy();
    expect(stored?.account_identifier_encrypted).not.toContain("dana.scully");
    expect(JSON.stringify([...assets.values()])).not.toContain("dana.scully");
  });

  it("produces a different ciphertext each time, so equal identifiers are not linkable", async () => {
    // A random nonce per value (ADR-003). Deterministic ciphertext would let
    // anyone with table access tell which two accounts share an identifier.
    const first = await create();
    const second = await create();

    expect(assets.get(first.id)?.account_identifier_encrypted).not.toBe(
      assets.get(second.id)?.account_identifier_encrypted,
    );
  });

  it("does not expose the identifier on the record returned by create", async () => {
    // §8 masks identifiers by default; ATL-035 owns reveal. A field that were
    // sometimes populated would invite rendering whatever happened to be there.
    const asset = await create();

    expect(asset).not.toHaveProperty("accountIdentifier");
    expect(asset.hasAccountIdentifier).toBe(true);
    expect(JSON.stringify(asset)).not.toContain("dana.scully");
  });

  it("does not expose it on find either", async () => {
    const asset = await create();

    const found = await repository.find(ALICE, asset.id);

    expect(found?.hasAccountIdentifier).toBe(true);
    expect(JSON.stringify(found)).not.toContain("dana.scully");
  });

  it("trims before encrypting, so a stray space is not part of the secret", async () => {
    const asset = await create({ accountIdentifier: "  dana@example.com  " });

    await expect(repository.readAccountIdentifier(ALICE, asset.id)).resolves.toBe(
      "dana@example.com",
    );
  });
});

describe("assets without an identifier", () => {
  it("stores null rather than an envelope over an empty string", async () => {
    const asset = await create({ accountIdentifier: null });

    expect(assets.get(asset.id)?.account_identifier_encrypted).toBeNull();
    expect(asset.hasAccountIdentifier).toBe(false);
  });

  it.each([undefined, null, "", "   "])("treats %p as no identifier", async (value) => {
    // Recording an identifier is optional (ATL-032). Blank must not become a
    // stored secret that decrypts to nothing.
    const asset = await create({ accountIdentifier: value });

    expect(asset.hasAccountIdentifier).toBe(false);
    await expect(repository.readAccountIdentifier(ALICE, asset.id)).resolves.toBeNull();
  });

  it("creates no encryption key for a user who stores no restricted value", async () => {
    // ADR-003 lazy creation: a user who never stores a restricted value never
    // gets a key, so there is nothing to rotate, shred, or leak.
    await create({ accountIdentifier: null });

    expect(keys.size).toBe(0);
  });
});

describe("ownership is a predicate, not an assumption", () => {
  it("does not return another user's asset", async () => {
    // The repository runs as service-role, which bypasses RLS entirely — so the
    // `user_id` filter here is the only gate at this layer.
    const asset = await create();

    await expect(repository.find(BOB, asset.id)).resolves.toBeNull();
  });

  it("does not decrypt another user's identifier", async () => {
    const asset = await create();

    await expect(repository.readAccountIdentifier(BOB, asset.id)).resolves.toBeNull();
  });

  it("gives the same answer for someone else's asset and one that does not exist", async () => {
    // ATL-034 returns 404 rather than 403 for exactly this reason: distinguishing
    // them confirms the asset exists.
    const asset = await create();

    const foreign = await repository.find(BOB, asset.id);
    const missing = await repository.find(BOB, "33333333-3333-4333-8333-333333333333");

    expect(foreign).toBe(missing);
  });
});

describe("metadata", () => {
  it("filters to the allowlist before storing", async () => {
    const asset = await create({ metadata: { plan: "premium", email: "dana@example.com" } });

    expect(asset.metadata).toEqual({ plan: "premium" });
    expect(JSON.stringify(assets.get(asset.id)?.metadata_json)).not.toContain("example.com");
  });

  it("re-filters on read, so a row written outside this repository cannot widen it", async () => {
    const asset = await create({ metadata: {} });
    // Simulates a row from before the policy narrowed, or a direct write.
    const row = assets.get(asset.id);
    if (row) row.metadata_json = { plan: "free", smuggled: "dana@example.com" };

    const found = await repository.find(ALICE, asset.id);

    expect(found?.metadata).toEqual({ plan: "free" });
  });
});

describe("column defaults", () => {
  it("applies the same defaults the migration does", async () => {
    const asset = await create();

    expect(asset.status).toBe("active");
    expect(asset.sourceType).toBe("manual");
    expect(asset.confidence).toBe("medium");
  });

  it("records a demo asset as demo, which is what keeps it out of a real score", async () => {
    // §11.2: demo and real records never mix in one calculation.
    const asset = await create({ sourceType: "demo" });

    expect(asset.sourceType).toBe("demo");
    expect(assets.get(asset.id)?.source_type).toBe("demo");
  });
});
