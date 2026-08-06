import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSET_CATEGORIES } from "@/lib/assets/categories";
import {
  ASSET_CONFIDENCE_LEVELS,
  ASSET_SOURCE_TYPES,
  ASSET_STATUSES,
} from "@/lib/assets/asset-fields";

/**
 * ATL-027 — `digital_assets` schema guarantees, asserted against the migration
 * source.
 *
 * **Not** a substitute for `tests/integration/digital-assets-rls.test.ts`, which
 * exercises the policies against a real database and is the authority on whether
 * they work. These exist because the migration is append-only: once applied it
 * can never be edited, so a missing policy or a stray `for delete` becomes
 * permanent and can only be corrected by a forward migration. Unlike the
 * database tests, these run on every pull request without Docker.
 */

const ROOT = join(__dirname, "../..");
const MIGRATION = "supabase/migrations/20260806090000_create_digital_assets.sql";

const sql = readFileSync(join(ROOT, MIGRATION), "utf8");
/** Statements only — comments explain intent and must not satisfy an assertion. */
const statements = sql.replace(/--[^\n]*/g, "");

describe("ownership", () => {
  it("carries user_id, as architecture §8 requires of every user-owned table", () => {
    expect(statements).toMatch(
      /user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\s*\(\s*id\s*\)/i,
    );
  });

  it("cascades from the auth user, so deletion cannot orphan assets", () => {
    expect(statements).toMatch(/references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i);
  });

  it("enables row level security", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.digital_assets\s+enable\s+row\s+level\s+security/i,
    );
  });

  it.each(["select", "insert", "update"])("scopes the %s policy to auth.uid()", (command) => {
    const policy = new RegExp(
      `create\\s+policy\\s+"digital_assets_${command}_own"[\\s\\S]*?;`,
      "i",
    );
    const match = policy.exec(statements);

    expect(match, `no ${command} policy found`).not.toBeNull();
    expect(match?.[0]).toMatch(/auth\.uid\s*\(\s*\)\s*=\s*user_id/i);
  });

  it("grants no client DELETE", () => {
    /**
     * Removal is a status transition (§7.2 `archived`, `removed`; ATL-036 owns
     * archive and restore). A client DELETE would also destroy the findings,
     * permissions, and activity referencing the asset — the history that explains
     * the user's own score. Hard deletion is server-side only: demo removal
     * (ATL-083) and the account cascade.
     */
    expect(statements).not.toMatch(/create\s+policy[^;]*for\s+delete/i);
    expect(statements).not.toMatch(/grant[^;]*delete[^;]*to\s+authenticated/i);
  });

  it("revokes everything from anon", () => {
    expect(statements).toMatch(/revoke\s+all\s+on\s+public\.digital_assets\s+from\s+anon/i);
  });

  it("grants service_role the delete the server-side paths need", () => {
    // ATL-083 demo removal is the only application delete.
    expect(statements).toMatch(
      /grant[\s\S]*delete[\s\S]*on\s+public\.digital_assets\s+to\s+service_role/i,
    );
  });
});

describe("encryption", () => {
  it("stores the account identifier only in an encrypted column", () => {
    // Security §8's inventory names exactly this column for this table.
    expect(statements).toMatch(/account_identifier_encrypted\s+text/i);
  });

  it("has no plaintext identifier column alongside it", () => {
    // Two columns could disagree about which one is authoritative, and the
    // plaintext one would win by being easier to read.
    expect(statements).not.toMatch(/\baccount_identifier\s+text/i);
  });
});

describe("vocabularies match the application", () => {
  /**
   * The migration and `src/lib/assets/asset-fields.ts` state these lists twice,
   * deliberately — two gates against a value the rules engine cannot interpret
   * (§11). These assertions are what keep the two copies honest.
   */
  const constraintValues = (column: string): string[] => {
    const match = new RegExp(
      `${column}\\s+text[^,]*?check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`,
      "i",
    ).exec(statements);
    if (!match?.[1]) throw new Error(`no check constraint found for ${column}`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1] as string).sort();
  };

  it("status", () => {
    expect(constraintValues("status")).toEqual([...ASSET_STATUSES].sort());
  });

  it("source_type", () => {
    expect(constraintValues("source_type")).toEqual([...ASSET_SOURCE_TYPES].sort());
  });

  it("confidence", () => {
    expect(constraintValues("confidence")).toEqual([...ASSET_CONFIDENCE_LEVELS].sort());
  });

  it("does not fork the category list into SQL", () => {
    /**
     * `categories.ts` is documented as the single definition ATL-027 inherits.
     * A check constraint listing the values would fork it, and — the migration
     * being append-only — every future category would need a forward migration
     * racing an application constant.
     */
    for (const category of ASSET_CATEGORIES) {
      expect(statements).not.toContain(`'${category.id}'`);
    }
    // Shape is still constrained, so the column cannot hold arbitrary text.
    expect(statements).toMatch(/category\s+text\s+not\s+null\s+check\s*\(\s*category\s*~/i);
  });
});

describe("indexes named by the acceptance criteria", () => {
  it("indexes (user_id, status)", () => {
    expect(statements).toMatch(
      /create\s+index\s+digital_assets_status_idx[\s\S]*?\(\s*user_id,\s*status/i,
    );
  });

  it("indexes (user_id, category)", () => {
    expect(statements).toMatch(
      /create\s+index\s+digital_assets_category_idx[\s\S]*?\(\s*user_id,\s*category/i,
    );
  });

  it("gives both a total ordering, so cursor pagination cannot repeat a row", () => {
    // The ATL-068 lesson: a tie on the sort column makes a page boundary
    // ambiguous, and the tiebreak has to be in the index to be free.
    expect(statements).toMatch(/digital_assets_status_idx[\s\S]*?created_at\s+desc,\s*id\s+desc/i);
    expect(statements).toMatch(
      /digital_assets_category_idx[\s\S]*?created_at\s+desc,\s*id\s+desc/i,
    );
  });

  it("indexes demo rows separately, for isolation and removal", () => {
    // §11.2 demo scoring, ATL-018 seeding, ATL-083 removal.
    expect(statements).toMatch(
      /create\s+index\s+digital_assets_demo_idx[\s\S]*?where[\s\S]*?source_type\s*=\s*'demo'/i,
    );
  });
});

describe("column constraints", () => {
  it("bounds every free-text column", () => {
    expect(statements).toMatch(
      /service_name[\s\S]*?char_length\s*\(\s*service_name\s*\)\s+between\s+1\s+and\s+200/i,
    );
    expect(statements).toMatch(
      /source_label[\s\S]*?char_length\s*\(\s*source_label\s*\)\s+between\s+1\s+and\s+120/i,
    );
    expect(statements).toMatch(/notes[\s\S]*?char_length\s*\(\s*notes\s*\)\s*<=\s*2000/i);
  });

  it("requires metadata_json to be a bounded object", () => {
    expect(statements).toMatch(/jsonb_typeof\s*\(\s*metadata_json\s*\)\s*=\s*'object'/i);
    expect(statements).toMatch(/length\s*\(\s*metadata_json::text\s*\)\s*<=\s*4096/i);
  });

  it("rejects a verification date in the future", () => {
    expect(statements).toMatch(/digital_assets_last_verified_not_future/i);
  });

  it("defaults status, source, and confidence rather than leaving them null", () => {
    expect(statements).toMatch(/status\s+text\s+not\s+null\s+default\s+'active'/i);
    expect(statements).toMatch(/source_type\s+text\s+not\s+null\s+default\s+'manual'/i);
    expect(statements).toMatch(/confidence\s+text\s+not\s+null\s+default\s+'medium'/i);
  });
});

describe("append-only", () => {
  it("touches no existing table", () => {
    // The migration rule: once shared, a migration is never edited, and it must
    // not reach backwards either.
    for (const table of [
      "profiles",
      "user_encryption_keys",
      "audit_events",
      "idempotency_keys",
      "consents",
      "activity_events",
    ]) {
      expect(statements).not.toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}`, "i"));
      expect(statements).not.toMatch(new RegExp(`drop\\s+[a-z]+\\s+[\\s\\S]*${table}`, "i"));
    }
  });
});
