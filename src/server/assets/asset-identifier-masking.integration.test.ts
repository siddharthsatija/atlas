import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { MASK_CHAR } from "@/lib/formatting/mask";

/**
 * ATL-032 — the masked-render assertion.
 *
 * The criterion is "identifier stored encrypted and masked immediately". Storage
 * is covered by ATL-027's round-trip tests; what is asserted here is the *read
 * path the detail page uses* — that the only way a surface obtains an identifier
 * returns it already masked, so plaintext never reaches a render.
 *
 * The real `AssetService`, `DigitalAssetRepository`, `EncryptionService`, and
 * mask helpers all run; only PostgREST is faked. Mocking the crypto or the mask
 * would test the mock, and the whole point is that the composition is safe.
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
    let operation: "select" | "insert" = "select";
    let pending: Row = {};
    const filters: { column: string; value: unknown }[] = [];

    const matching = () =>
      [...store.values()].filter((row) => filters.every((f) => row[f.column] === f.value));

    const run = () =>
      operation === "insert"
        ? { data: [{ ...pending }], error: null }
        : { data: matching().map((row) => ({ ...row })), error: null };

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
          ...values,
        };
        store.set(String(pending.id), { ...pending });
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

const { AssetService } = await import("./asset-service");

let service: InstanceType<typeof AssetService>;

beforeEach(() => {
  tables.clear();
  service = new AssetService(createDb());
});

const create = async (identifier: string | null) => {
  const result = await service.createAsset(ALICE, {
    serviceName: "Spotify",
    category: "entertainment",
    ...(identifier ? { accountIdentifier: identifier } : {}),
  });
  if (!result.ok) throw new Error(`create failed: ${result.code}`);
  return result.data;
};

const unwrapMasked = async (userId: string, assetId: string) => {
  const result = await service.readMaskedAccountIdentifier(userId, assetId);
  if (!result.ok) throw new Error(`read failed: ${result.code}`);
  return result.data;
};

describe("the identifier is masked, never returned whole", () => {
  it("masks an email identifier", async () => {
    const asset = await create("dana.scully@example.com");

    const masked = await unwrapMasked(ALICE, asset.id);

    expect(masked).toContain(MASK_CHAR);
    expect(masked).not.toContain("dana.scully");
  });

  it("masks a non-email identifier", async () => {
    const asset = await create("member-99182234");

    const masked = await unwrapMasked(ALICE, asset.id);

    expect(masked).toContain(MASK_CHAR);
    expect(masked).not.toBe("member-99182234");
  });

  it("masks a short identifier entirely rather than partially", async () => {
    // Keeping the last four of a five-character value reveals almost all of it.
    const asset = await create("ab12");

    const masked = await unwrapMasked(ALICE, asset.id);

    expect(masked).not.toContain("ab12");
  });

  it("returns null when no identifier was recorded", async () => {
    const asset = await create(null);

    expect(await unwrapMasked(ALICE, asset.id)).toBeNull();
  });

  it("stores ciphertext, so the mask is not the only protection", async () => {
    const asset = await create("dana.scully@example.com");

    const stored = tableOf("digital_assets").get(asset.id);
    expect(String(stored?.account_identifier_encrypted)).not.toContain("dana.scully");
  });

  it("has no unaudited path that returns the plaintext", () => {
    /**
     * The structural guarantee, as ATL-035 leaves it.
     *
     * When this was written the list held one entry, because reveal did not
     * exist yet and the comment said so. ATL-035 added exactly the method that
     * comment anticipated: `revealAccountIdentifier`, which writes an audit
     * event before it returns anything and is covered by
     * `asset-identifier-reveal.integration.test.ts`.
     *
     * The assertion is still exhaustive rather than relaxed — a *third*
     * identifier method, the unaudited plaintext read added for convenience,
     * is what it exists to catch.
     */
    const methods = Object.getOwnPropertyNames(AssetService.prototype)
      .filter((name) => /identifier/i.test(name))
      .sort();

    expect(methods).toEqual(["readMaskedAccountIdentifier", "revealAccountIdentifier"]);
  });
});

describe("ownership still applies to the masked read", () => {
  it("returns null for another user's asset", async () => {
    // Not a masked value, and not an error that would confirm the asset exists.
    const asset = await create("dana.scully@example.com");

    expect(await unwrapMasked(BOB, asset.id)).toBeNull();
  });

  it("returns null for an asset that does not exist", async () => {
    expect(await unwrapMasked(ALICE, randomUUID())).toBeNull();
  });
});
