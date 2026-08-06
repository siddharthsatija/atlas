import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSION_SCOPES, PERMISSION_STATUSES } from "@/lib/assets/permissions";

/**
 * ATL-029 — `asset_permissions` schema guarantees, asserted against the
 * migration source.
 *
 * Not a substitute for `tests/integration/asset-permissions-rls.test.ts`, which
 * exercises the policies and the composite foreign key against a real database.
 * These exist because the migration is append-only: once applied it can never be
 * edited, so a missing constraint becomes permanent and can only be corrected by
 * a forward migration.
 */

const ROOT = join(__dirname, "../..");
const MIGRATIONS = join(ROOT, "supabase/migrations");
const MIGRATION = "supabase/migrations/20260808090000_create_asset_permissions.sql";

const sql = readFileSync(join(ROOT, MIGRATION), "utf8");
/** Statements only — comments explain intent and must not satisfy an assertion. */
const statements = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("cross-user foreign key protection", () => {
  it("references the parent by (user_id, id), not by id alone", () => {
    /**
     * The ATL-028 pattern, reused. A single-column reference would satisfy
     * referential integrity and still permit a row claiming one owner while
     * pointing at another's asset — hidden from both by RLS, and counted by the
     * rules engine reading with service-role.
     */
    expect(statements).toMatch(
      /foreign\s+key\s*\(\s*user_id,\s*asset_id\s*\)\s*references\s+public\.digital_assets\s*\(\s*user_id,\s*id\s*\)/i,
    );
  });

  it("never references digital_assets by id alone", () => {
    expect(statements).not.toMatch(/references\s+public\.digital_assets\s*\(\s*id\s*\)/i);
  });

  it("cascades from the asset", () => {
    expect(statements).toMatch(
      /references\s+public\.digital_assets\s*\([^)]*\)\s*on\s+delete\s+cascade/i,
    );
  });

  it("does not re-add the unique key ATL-028 already created", () => {
    /**
     * The composite reference needs `unique (user_id, id)` on `digital_assets`,
     * and ATL-028's migration added it. Adding it again would fail on a fresh
     * `db:reset`, which is exactly when nobody is watching.
     */
    expect(statements).not.toMatch(/alter\s+table\s+public\.digital_assets/i);

    const owner = readdirSync(MIGRATIONS).find((file) => file.includes("asset_data_categories"));
    expect(owner, "ATL-028's migration should own that constraint").toBeDefined();
    expect(readFileSync(join(MIGRATIONS, owner as string), "utf8")).toMatch(
      /alter\s+table\s+public\.digital_assets\s+add\s+constraint\s+\w+\s+unique\s*\(\s*user_id,\s*id\s*\)/i,
    );
  });

  it("carries user_id, as architecture §8 requires", () => {
    expect(statements).toMatch(/user_id\s+uuid\s+not\s+null/i);
  });
});

describe("vocabularies match the application", () => {
  const constraintValues = (column: string): string[] => {
    const match = new RegExp(
      `${column}\\s+text[^,]*?check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`,
      "i",
    ).exec(statements);
    if (!match?.[1]) throw new Error(`no check constraint found for ${column}`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1] as string).sort();
  };

  it("constrains scope to broad and limited", () => {
    // The binary ADR-004's factor and R-004 both read.
    expect(constraintValues("scope")).toEqual([...PERMISSION_SCOPES].sort());
  });

  it("constrains status to active, revoked, and unknown", () => {
    expect(constraintValues("status")).toEqual([...PERMISSION_STATUSES].sort());
  });

  it("defaults status to active", () => {
    expect(statements).toMatch(/status\s+text\s+not\s+null\s+default\s+'active'/i);
  });

  it("constrains permission_type by shape, not by an enum", () => {
    /**
     * No document enumerates permission kinds. An append-only migration would
     * turn every future addition into a forward migration racing an application
     * constant — the same reasoning `digital_assets.category` records.
     */
    expect(statements).toMatch(
      /permission_type\s+text\s+not\s+null\s+check\s*\(\s*permission_type\s*~/i,
    );
    expect(statements).not.toMatch(/permission_type\s+in\s*\(/i);
  });
});

describe("no expiry", () => {
  it("declares no expiry column", () => {
    /**
     * §7.4 lists none, and no rule or score factor reads one — R-005 measures
     * staleness from `last_verified_at`. A column nothing populates and nothing
     * reads would be invented product behaviour.
     */
    expect(statements).not.toMatch(/\bexpires_at\b/i);
    expect(statements).not.toMatch(/\bexpiry\b/i);
    expect(statements).not.toMatch(/'expired'/i);
  });

  it("keeps last_verified_at, which R-005 does read", () => {
    expect(statements).toMatch(/last_verified_at\s+timestamptz/i);
    expect(statements).toMatch(/asset_permissions_last_verified_not_future/i);
  });
});

describe("duplicate protection", () => {
  it("allows one row per permission type per asset", () => {
    /**
     * ADR-004 divides by "total recorded permissions", so a duplicate would move
     * the denominator and change the score without the user's exposure changing.
     */
    expect(statements).toMatch(/unique\s*\(\s*user_id,\s*asset_id,\s*permission_type\s*\)/i);
  });
});

describe("indexes serve the rules that read this table", () => {
  it("serves the asset detail view", () => {
    expect(statements).toMatch(
      /create\s+index\s+asset_permissions_asset_idx[\s\S]*?\(\s*user_id,\s*asset_id/i,
    );
  });

  it("serves R-004 and ADR-004's numerator on both predicates", () => {
    // Broad *and* active — a partial index on only one would still scan the rest.
    expect(statements).toMatch(
      /create\s+index\s+asset_permissions_broad_active_idx[\s\S]*?where[\s\S]*?scope\s*=\s*'broad'[\s\S]*?status\s*=\s*'active'/i,
    );
  });

  it("serves R-005's staleness sweep", () => {
    expect(statements).toMatch(
      /create\s+index\s+asset_permissions_stale_idx[\s\S]*?\(\s*user_id,\s*last_verified_at\s*\)[\s\S]*?where[\s\S]*?status\s*=\s*'active'/i,
    );
  });
});

describe("row level security", () => {
  it("enables RLS", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.asset_permissions\s+enable\s+row\s+level\s+security/i,
    );
  });

  it.each(["select", "insert", "update", "delete"])(
    "scopes the %s policy to auth.uid()",
    (command) => {
      const policy = new RegExp(
        `create\\s+policy\\s+"asset_permissions_${command}_own"[\\s\\S]*?;`,
        "i",
      );
      const match = policy.exec(statements);

      expect(match, `no ${command} policy found`).not.toBeNull();
      expect(match?.[0]).toMatch(/auth\.uid\s*\(\s*\)\s*=\s*user_id/i);
    },
  );

  it("revokes everything from anon", () => {
    expect(statements).toMatch(/revoke\s+all\s+on\s+public\.asset_permissions\s+from\s+anon/i);
  });
});

describe("append-only", () => {
  it("touches no earlier table", () => {
    for (const table of [
      "profiles",
      "user_encryption_keys",
      "audit_events",
      "idempotency_keys",
      "consents",
      "activity_events",
      "digital_assets",
      "asset_data_categories",
    ]) {
      expect(statements).not.toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}`, "i"));
    }
    expect(statements).not.toMatch(/drop\s+(table|policy|index|constraint)/i);
  });
});
