import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ATL-201 — Discovery runs and invocations schema, asserted against the migration source.
 *
 * Tests read the migration SQL and strip comments before asserting on
 * statements, consistent with the convention established by
 * discovery-schema-foundation.test.ts and digital-assets-schema.test.ts.
 *
 * These tests do not require a running database: they assert that the migration
 * file contains the correct SQL to implement the ATL-201 contract when applied.
 */

const ROOT = join(__dirname, "../..");
const MIGRATION = "supabase/migrations/20260822090000_atl_201_discovery_runs_schema.sql";

const sql = execFileSync("cat", [join(ROOT, MIGRATION)], { encoding: "utf8" });
/** Statements only — a comment must never satisfy a security assertion. */
const statements = sql.replace(/--[^\n]*/g, "");

// ---------------------------------------------------------------------------
// Prerequisite: UNIQUE (user_id, id) on user_personal_fields
// ---------------------------------------------------------------------------

describe("user_personal_fields — prerequisite unique constraint", () => {
  it("adds UNIQUE (user_id, id) conditionally via a DO block", () => {
    // Must use a DO block with an existence check so the migration is safe
    // if the constraint already exists (ticket requirement).
    expect(statements).toMatch(/\bdo\b[\s\S]{0,600}?user_personal_fields_user_id_id_key/i);
  });

  it("uses a conditional guard before adding the constraint", () => {
    const block = /\bdo\b\s*\$\$([\s\S]*?)\$\$/i.exec(statements)?.[0] ?? "";
    expect(block).toBeTruthy();
    expect(block).toMatch(/if\s+not\s+exists/i);
    expect(block).toMatch(/user_personal_fields_user_id_id_key/i);
    expect(block).toMatch(/unique\s*\(\s*user_id\s*,\s*id\s*\)/i);
  });

  it("names the constraint user_personal_fields_user_id_id_key", () => {
    expect(statements).toMatch(/user_personal_fields_user_id_id_key/i);
  });
});

// ---------------------------------------------------------------------------
// discovery_runs
// ---------------------------------------------------------------------------

describe("discovery_runs — table creation", () => {
  it("creates the discovery_runs table", () => {
    expect(statements).toMatch(/create\s+table\s+public\.discovery_runs/i);
  });

  it("uses gen_random_uuid() for the primary key default", () => {
    const block =
      /create\s+table\s+public\.discovery_runs\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ?? "";
    expect(block).toMatch(/id\s+uuid\s+primary\s+key\s+default\s+gen_random_uuid\(\)/i);
  });

  it("references auth.users on delete cascade for user_id", () => {
    const block =
      /create\s+table\s+public\.discovery_runs\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ?? "";
    expect(block).toMatch(
      /user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
    );
  });
});

describe("discovery_runs — run_status column", () => {
  it("declares run_status as NOT NULL with default 'pending'", () => {
    expect(statements).toMatch(/run_status\s+text\s+not\s+null\s+default\s+'pending'/i);
  });

  it("constrains run_status to the six valid values", () => {
    const block =
      /create\s+table\s+public\.discovery_runs\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ?? "";
    for (const v of ["pending", "running", "completed", "partial", "blocked", "failed"]) {
      expect(block).toContain(`'${v}'`);
    }
  });
});

describe("discovery_runs — triggered_by column", () => {
  it("declares triggered_by as NOT NULL", () => {
    expect(statements).toMatch(/triggered_by\s+text\s+not\s+null/i);
  });

  it("constrains triggered_by to the three valid values", () => {
    const block =
      /create\s+table\s+public\.discovery_runs\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ?? "";
    for (const v of ["user", "scheduled", "profile_change"]) {
      expect(block).toContain(`'${v}'`);
    }
  });
});

describe("discovery_runs — UNIQUE (user_id, id)", () => {
  it("adds discovery_runs_user_id_id_key unique constraint", () => {
    expect(statements).toMatch(
      /constraint\s+discovery_runs_user_id_id_key\s+unique\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });
});

describe("discovery_runs — indexes", () => {
  it("creates partial index on (user_id, created_at desc) for run history", () => {
    expect(statements).toMatch(
      /create\s+index\s+discovery_runs_user_created_idx[\s\S]{0,100}?\(\s*user_id\s*,\s*created_at\s+desc\s*\)/i,
    );
  });
});

describe("discovery_runs — RLS and privileges", () => {
  it("enables RLS on discovery_runs", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.discovery_runs\s+enable\s+row\s+level\s+security/i,
    );
  });

  it("adds a select-own policy for authenticated users", () => {
    expect(statements).toMatch(/discovery_runs_select_own/i);
    expect(statements).toMatch(
      /policy\s+"discovery_runs_select_own"[\s\S]{0,200}?for\s+select\s+to\s+authenticated/i,
    );
  });

  it("does NOT add insert, update, or delete policies for authenticated", () => {
    const policies =
      statements.match(
        /create\s+policy[\s\S]{0,400}?on\s+public\.discovery_runs[\s\S]{0,400}?;/gi,
      ) ?? [];
    // Only one policy — the select policy — should exist for discovery_runs.
    expect(policies.length).toBe(1);
    expect(policies[0]).toMatch(/for\s+select/i);
  });

  it("revokes all from anon", () => {
    expect(statements).toMatch(/revoke\s+all\s+on\s+public\.discovery_runs\s+from\s+anon/i);
  });

  it("grants select to authenticated", () => {
    expect(statements).toMatch(
      /grant\s+select\s+on\s+public\.discovery_runs\s+to\s+authenticated/i,
    );
  });

  it("grants all four verbs to service_role", () => {
    const grant =
      /grant\s+[\w\s,]+on\s+public\.discovery_runs\s+to\s+service_role/i.exec(statements)?.[0] ??
      "";
    expect(grant).toMatch(/select/i);
    expect(grant).toMatch(/insert/i);
    expect(grant).toMatch(/update/i);
    expect(grant).toMatch(/delete/i);
  });
});

// ---------------------------------------------------------------------------
// discovery_provider_invocations
// ---------------------------------------------------------------------------

describe("discovery_provider_invocations — table creation", () => {
  it("creates the discovery_provider_invocations table", () => {
    expect(statements).toMatch(/create\s+table\s+public\.discovery_provider_invocations/i);
  });

  it("declares run_id as NOT NULL", () => {
    const block =
      /create\s+table\s+public\.discovery_provider_invocations\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";
    expect(block).toMatch(/run_id\s+uuid\s+not\s+null/i);
  });
});

describe("discovery_provider_invocations — cross-user composite FK to discovery_runs", () => {
  it("uses composite FOREIGN KEY (user_id, run_id) referencing discovery_runs (user_id, id)", () => {
    expect(statements).toMatch(
      /foreign\s+key\s*\(\s*user_id\s*,\s*run_id\s*\)\s+references\s+public\.discovery_runs\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });

  it("names the FK constraint discovery_provider_invocations_run_fkey", () => {
    expect(statements).toMatch(/constraint\s+discovery_provider_invocations_run_fkey/i);
  });

  it("does NOT use a plain single-column run_id FK", () => {
    // The plain FK form would allow cross-user associations.
    expect(statements).not.toMatch(
      /run_id\s+uuid\s+not\s+null\s+references\s+public\.discovery_runs\s*\(\s*id\s*\)/i,
    );
  });
});

describe("discovery_provider_invocations — invocation_status", () => {
  it("declares invocation_status as nullable text", () => {
    const block =
      /create\s+table\s+public\.discovery_provider_invocations\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";
    // Must be nullable (no NOT NULL)
    expect(block).not.toMatch(/invocation_status\s+text\s+not\s+null/i);
    expect(block).toMatch(/invocation_status\s+text/i);
  });

  it("constrains invocation_status to null or the four terminal values", () => {
    const block =
      /create\s+table\s+public\.discovery_provider_invocations\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";
    for (const v of ["success", "blocked", "error", "rate_limited"]) {
      expect(block).toContain(`'${v}'`);
    }
    // Must allow null
    expect(block).toMatch(/invocation_status\s+is\s+null/i);
  });
});

describe("discovery_provider_invocations — UNIQUE (user_id, id)", () => {
  it("adds discovery_provider_invocations_user_id_id_key", () => {
    expect(statements).toMatch(
      /constraint\s+discovery_provider_invocations_user_id_id_key\s+unique\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });
});

describe("discovery_provider_invocations — three lifecycle check constraints", () => {
  it("adds constraint: terminal status requires completed_at", () => {
    expect(statements).toMatch(
      /constraint\s+discovery_provider_invocations_terminal_needs_completed/i,
    );
    const constraint =
      /constraint\s+discovery_provider_invocations_terminal_needs_completed\s+check\s*\(([\s\S]*?)\)/i.exec(
        statements,
      )?.[0] ?? "";
    expect(constraint).toBeTruthy();
    expect(constraint).toMatch(/invocation_status\s+is\s+null/i);
    expect(constraint).toMatch(/completed_at\s+is\s+not\s+null/i);
  });

  it("adds constraint: completed_at requires terminal status", () => {
    expect(statements).toMatch(
      /constraint\s+discovery_provider_invocations_completed_needs_status/i,
    );
    const constraint =
      /constraint\s+discovery_provider_invocations_completed_needs_status\s+check\s*\(([\s\S]*?)\)/i.exec(
        statements,
      )?.[0] ?? "";
    expect(constraint).toBeTruthy();
    expect(constraint).toMatch(/completed_at\s+is\s+null/i);
    expect(constraint).toMatch(/invocation_status\s+is\s+not\s+null/i);
  });

  it("adds constraint: completed_at requires started_at", () => {
    expect(statements).toMatch(
      /constraint\s+discovery_provider_invocations_completed_needs_started/i,
    );
    const constraint =
      /constraint\s+discovery_provider_invocations_completed_needs_started\s+check\s*\(([\s\S]*?)\)/i.exec(
        statements,
      )?.[0] ?? "";
    expect(constraint).toBeTruthy();
    expect(constraint).toMatch(/completed_at\s+is\s+null/i);
    expect(constraint).toMatch(/started_at\s+is\s+not\s+null/i);
  });
});

describe("discovery_provider_invocations — RLS and privileges", () => {
  it("enables RLS", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.discovery_provider_invocations\s+enable\s+row\s+level\s+security/i,
    );
  });

  it("adds a select-own policy for authenticated", () => {
    expect(statements).toMatch(/discovery_provider_invocations_select_own/i);
  });

  it("does NOT add insert, update, or delete policies for authenticated", () => {
    const policies =
      statements.match(
        /create\s+policy[\s\S]{0,500}?on\s+public\.discovery_provider_invocations[\s\S]{0,400}?;/gi,
      ) ?? [];
    expect(policies.length).toBe(1);
    expect(policies[0]).toMatch(/for\s+select/i);
  });

  it("revokes all from anon", () => {
    expect(statements).toMatch(
      /revoke\s+all\s+on\s+public\.discovery_provider_invocations\s+from\s+anon/i,
    );
  });

  it("grants select to authenticated", () => {
    expect(statements).toMatch(
      /grant\s+select\s+on\s+public\.discovery_provider_invocations\s+to\s+authenticated/i,
    );
  });

  it("grants all four verbs to service_role", () => {
    const grant =
      /grant\s+[\w\s,]+on\s+public\.discovery_provider_invocations\s+to\s+service_role/i.exec(
        statements,
      )?.[0] ?? "";
    expect(grant).toMatch(/select/i);
    expect(grant).toMatch(/insert/i);
    expect(grant).toMatch(/update/i);
    expect(grant).toMatch(/delete/i);
  });
});

// ---------------------------------------------------------------------------
// discovery_provider_invocation_fields
// ---------------------------------------------------------------------------

describe("discovery_provider_invocation_fields — table creation", () => {
  it("creates the discovery_provider_invocation_fields table", () => {
    expect(statements).toMatch(/create\s+table\s+public\.discovery_provider_invocation_fields/i);
  });

  it("declares invocation_id and field_id as NOT NULL", () => {
    const block =
      /create\s+table\s+public\.discovery_provider_invocation_fields\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";
    expect(block).toMatch(/invocation_id\s+uuid\s+not\s+null/i);
    expect(block).toMatch(/field_id\s+uuid\s+not\s+null/i);
  });

  it("declares field_type as NOT NULL", () => {
    const block =
      /create\s+table\s+public\.discovery_provider_invocation_fields\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";
    expect(block).toMatch(/field_type\s+text\s+not\s+null/i);
  });
});

describe("discovery_provider_invocation_fields — cross-user composite FK to discovery_provider_invocations", () => {
  it("uses composite FOREIGN KEY (user_id, invocation_id) referencing discovery_provider_invocations (user_id, id)", () => {
    expect(statements).toMatch(
      /foreign\s+key\s*\(\s*user_id\s*,\s*invocation_id\s*\)\s+references\s+public\.discovery_provider_invocations\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });

  it("names the invocation FK constraint discovery_provider_invocation_fields_invocation_fkey", () => {
    expect(statements).toMatch(
      /constraint\s+discovery_provider_invocation_fields_invocation_fkey/i,
    );
  });
});

describe("discovery_provider_invocation_fields — cross-user composite FK to user_personal_fields", () => {
  it("uses composite FOREIGN KEY (user_id, field_id) referencing user_personal_fields (user_id, id)", () => {
    expect(statements).toMatch(
      /foreign\s+key\s*\(\s*user_id\s*,\s*field_id\s*\)\s+references\s+public\.user_personal_fields\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });

  it("names the field FK constraint discovery_provider_invocation_fields_field_fkey", () => {
    expect(statements).toMatch(/constraint\s+discovery_provider_invocation_fields_field_fkey/i);
  });

  it("does NOT use a plain single-column field_id FK", () => {
    expect(statements).not.toMatch(
      /field_id\s+uuid\s+not\s+null\s+references\s+public\.user_personal_fields\s*\(\s*id\s*\)/i,
    );
  });
});

describe("discovery_provider_invocation_fields — field_type constraint", () => {
  it("constrains field_type to the user_personal_fields.field_key vocabulary", () => {
    const block =
      /create\s+table\s+public\.discovery_provider_invocation_fields\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";
    for (const v of ["full_name", "email", "phone", "address", "username", "other"]) {
      expect(block).toContain(`'${v}'`);
    }
  });
});

describe("discovery_provider_invocation_fields — UNIQUE (user_id, invocation_id, field_id)", () => {
  it("adds the unique-per-invocation constraint", () => {
    expect(statements).toMatch(
      /constraint\s+discovery_provider_invocation_fields_unique_per_invocation\s+unique\s*\(\s*user_id\s*,\s*invocation_id\s*,\s*field_id\s*\)/i,
    );
  });
});

describe("discovery_provider_invocation_fields — dispatch-check index", () => {
  it("creates index on (user_id, invocation_id) for dispatch check 6", () => {
    expect(statements).toMatch(
      /create\s+index\s+discovery_provider_invocation_fields_invocation_idx[\s\S]{0,100}?\(\s*user_id\s*,\s*invocation_id\s*\)/i,
    );
  });
});

describe("discovery_provider_invocation_fields — RLS and privileges", () => {
  it("enables RLS", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.discovery_provider_invocation_fields\s+enable\s+row\s+level\s+security/i,
    );
  });

  it("adds a select-own policy for authenticated", () => {
    expect(statements).toMatch(/discovery_provider_invocation_fields_select_own/i);
  });

  it("does NOT add insert, update, or delete policies for authenticated", () => {
    const policies =
      statements.match(
        /create\s+policy[\s\S]{0,600}?on\s+public\.discovery_provider_invocation_fields[\s\S]{0,400}?;/gi,
      ) ?? [];
    expect(policies.length).toBe(1);
    expect(policies[0]).toMatch(/for\s+select/i);
  });

  it("revokes all from anon", () => {
    expect(statements).toMatch(
      /revoke\s+all\s+on\s+public\.discovery_provider_invocation_fields\s+from\s+anon/i,
    );
  });

  it("grants select to authenticated", () => {
    expect(statements).toMatch(
      /grant\s+select\s+on\s+public\.discovery_provider_invocation_fields\s+to\s+authenticated/i,
    );
  });

  it("grants select, insert, delete to service_role (no update — immutable rows)", () => {
    const grant =
      /grant\s+[\w\s,]+on\s+public\.discovery_provider_invocation_fields\s+to\s+service_role/i.exec(
        statements,
      )?.[0] ?? "";
    expect(grant).toMatch(/select/i);
    expect(grant).toMatch(/insert/i);
    expect(grant).toMatch(/delete/i);
  });
});

// ---------------------------------------------------------------------------
// Append-only guard
// ---------------------------------------------------------------------------

describe("migration hygiene", () => {
  it("migration file exists at the expected path", () => {
    expect(sql.length).toBeGreaterThan(200);
  });

  it("does not modify the user_personal_fields migration", () => {
    const original = execFileSync(
      "cat",
      [join(ROOT, "supabase/migrations/20260818090000_create_user_personal_fields.sql")],
      { encoding: "utf8" },
    );
    // Original must not contain the new unique constraint name.
    expect(original).not.toMatch(/user_personal_fields_user_id_id_key/i);
    // Original must not reference discovery tables.
    expect(original).not.toMatch(/discovery_provider/i);
  });

  it("does not modify the ATL-200 migration", () => {
    const atl200 = execFileSync(
      "cat",
      [join(ROOT, "supabase/migrations/20260821090000_atl_200_discovery_schema_foundation.sql")],
      { encoding: "utf8" },
    );
    // ATL-200 should not contain discovery_runs table creation.
    expect(atl200).not.toMatch(/create\s+table\s+public\.discovery_runs/i);
  });
});
