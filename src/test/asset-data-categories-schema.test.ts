import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_CATEGORIES, HIGH_SENSITIVITY_CATEGORIES } from "@/lib/assets/data-categories";
import { ASSET_CONFIDENCE_LEVELS } from "@/lib/assets/asset-fields";

/**
 * ATL-028 — `asset_data_categories` schema guarantees, asserted against the
 * migration source.
 *
 * Not a substitute for `tests/integration/asset-data-categories-rls.test.ts`,
 * which exercises the policies and the composite foreign key against a real
 * database. These exist because the migration is append-only: once applied it
 * can never be edited, so a missing constraint becomes permanent and can only be
 * corrected by a forward migration.
 */

const ROOT = join(__dirname, "../..");
const MIGRATION = "supabase/migrations/20260807090000_create_asset_data_categories.sql";

const sql = readFileSync(join(ROOT, MIGRATION), "utf8");
/** Statements only — comments explain intent and must not satisfy an assertion. */
const statements = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("cross-user foreign key protection", () => {
  it("references the parent by (user_id, id), not by id alone", () => {
    /**
     * The acceptance criterion. A plain `references digital_assets (id)` would
     * satisfy referential integrity and still permit a row claiming one owner
     * while pointing at another's asset — invisible to both under RLS, and
     * counted by the rules engine reading with service-role.
     */
    expect(statements).toMatch(
      /foreign\s+key\s*\(\s*user_id,\s*asset_id\s*\)\s*references\s+public\.digital_assets\s*\(\s*user_id,\s*id\s*\)/i,
    );
  });

  it("adds the unique key the composite reference requires", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.digital_assets\s+add\s+constraint\s+\w+\s+unique\s*\(\s*user_id,\s*id\s*\)/i,
    );
  });

  it("never references digital_assets by id alone", () => {
    expect(statements).not.toMatch(/references\s+public\.digital_assets\s*\(\s*id\s*\)/i);
  });

  it("cascades from the asset, so a removed asset leaves no orphan categories", () => {
    expect(statements).toMatch(
      /references\s+public\.digital_assets\s*\([^)]*\)\s*on\s+delete\s+cascade/i,
    );
  });

  it("carries user_id, as architecture §8 requires of every user-owned table", () => {
    expect(statements).toMatch(/user_id\s+uuid\s+not\s+null/i);
  });
});

describe("sensitivity is generated, not supplied", () => {
  it("is a stored generated column", () => {
    // A check constraint would still require every caller to compute the right
    // value and would only catch the ones that got it wrong.
    expect(statements).toMatch(
      /sensitivity\s+text\s+generated\s+always\s+as\s*\([\s\S]*?\)\s*stored/i,
    );
  });

  it("uses exactly ADR-004's high-sensitivity set", () => {
    /**
     * The database copy of the mapping must agree with
     * `src/lib/assets/data-categories.ts`. If these drift, the score and the UI
     * disagree about which data is sensitive.
     */
    const generated =
      /generated\s+always\s+as\s*\(([\s\S]*?)\)\s*stored/i.exec(statements)?.[1] ?? "";
    const quoted = [...generated.matchAll(/'([a-z]+)'/g)]
      .map((match) => match[1] as string)
      .filter((value) => value !== "high" && value !== "standard");

    expect(quoted.sort()).toEqual([...HIGH_SENSITIVITY_CATEGORIES].sort());
  });
});

describe("vocabularies match the application", () => {
  it("constrains category to the §7.3 list", () => {
    const match =
      /category\s+text\s+not\s+null\s+check\s*\(\s*\n?\s*category\s+in\s*\(([\s\S]*?)\)\s*\)/i.exec(
        statements,
      );
    expect(match, "no category check constraint found").not.toBeNull();

    const values = [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
      (entry) => entry[1] as string,
    );
    expect(values.sort()).toEqual(DATA_CATEGORIES.map((entry) => entry.id).sort());
  });

  it("constrains confidence to the shared three levels", () => {
    const match = /confidence\s+text[^,]*?check\s*\(\s*confidence\s+in\s*\(([^)]*)\)/i.exec(
      statements,
    );
    const values = [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
      (entry) => entry[1] as string,
    );

    expect(values.sort()).toEqual([...ASSET_CONFIDENCE_LEVELS].sort());
  });
});

describe("duplicate protection", () => {
  it("allows one row per category per asset", () => {
    /**
     * ADR-004 counts active-asset × high-sensitivity-category pairs and R-008
     * counts assets holding a category. A duplicate would inflate both, so a
     * user's score would fall because one fact was recorded twice.
     */
    expect(statements).toMatch(/unique\s*\(\s*user_id,\s*asset_id,\s*category\s*\)/i);
  });
});

describe("row level security", () => {
  it("enables RLS", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.asset_data_categories\s+enable\s+row\s+level\s+security/i,
    );
  });

  it.each(["select", "insert", "update", "delete"])(
    "scopes the %s policy to auth.uid()",
    (command) => {
      const policy = new RegExp(
        `create\\s+policy\\s+"asset_data_categories_${command}_own"[\\s\\S]*?;`,
        "i",
      );
      const match = policy.exec(statements);

      expect(match, `no ${command} policy found`).not.toBeNull();
      expect(match?.[0]).toMatch(/auth\.uid\s*\(\s*\)\s*=\s*user_id/i);
    },
  );

  it("grants delete here, unlike digital_assets", () => {
    /**
     * Removing a category is ordinary editing (ATL-033), not the destruction of
     * a record with its own history. A user who mistakenly recorded that a
     * service holds their health data must be able to take that back.
     */
    expect(statements).toMatch(/grant[^;]*delete[^;]*to\s+authenticated/i);
  });

  it("revokes everything from anon", () => {
    expect(statements).toMatch(/revoke\s+all\s+on\s+public\.asset_data_categories\s+from\s+anon/i);
  });
});

describe("indexes", () => {
  it("serves the asset detail view", () => {
    expect(statements).toMatch(
      /create\s+index\s+asset_data_categories_asset_idx[\s\S]*?\(\s*user_id,\s*asset_id/i,
    );
  });

  it("serves R-008, which scans by category across assets", () => {
    expect(statements).toMatch(
      /create\s+index\s+asset_data_categories_category_idx[\s\S]*?\(\s*user_id,\s*category/i,
    );
  });

  it("serves the score's sensitivity factor with a partial index", () => {
    expect(statements).toMatch(
      /create\s+index\s+asset_data_categories_sensitive_idx[\s\S]*?where[\s\S]*?sensitivity\s*=\s*'high'/i,
    );
  });
});

describe("append-only", () => {
  it("adds to digital_assets without altering a column or dropping anything", () => {
    // A forward migration may extend a shipped table; it may not rewrite one.
    expect(statements).toMatch(/alter\s+table\s+public\.digital_assets\s+add\s+constraint/i);
    expect(statements).not.toMatch(/alter\s+table[\s\S]*?(drop|alter)\s+column/i);
    expect(statements).not.toMatch(/drop\s+(table|policy|index|constraint)/i);
  });

  it("touches no earlier table", () => {
    for (const table of [
      "profiles",
      "user_encryption_keys",
      "audit_events",
      "idempotency_keys",
      "consents",
      "activity_events",
    ]) {
      expect(statements).not.toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}`, "i"));
    }
  });
});
