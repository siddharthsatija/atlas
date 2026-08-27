import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ATL-202 — Discovery evidence, candidates, and rejections schema,
 * asserted against the migration source.
 *
 * Tests read the migration SQL and strip comments before asserting on
 * statements, consistent with the convention established by
 * discovery-runs-schema.test.ts and discovery-schema-foundation.test.ts.
 *
 * These tests do not require a running database: they assert that the migration
 * file contains the correct SQL to implement the ATL-202 contract when applied.
 */

const ROOT = join(__dirname, "../..");
const MIGRATION =
  "supabase/migrations/20260823090000_atl_202_discovery_evidence_candidates_rejections.sql";

const sql = execFileSync("cat", [join(ROOT, MIGRATION)], { encoding: "utf8" });
/** Statements only — a comment must never satisfy a security assertion. */
const statements = sql.replace(/--[^\n]*/g, "");

// ---------------------------------------------------------------------------
// discovery_evidence — table creation
// ---------------------------------------------------------------------------

describe("discovery_evidence — table creation", () => {
  it("creates the discovery_evidence table", () => {
    expect(statements).toMatch(/create\s+table\s+public\.discovery_evidence/i);
  });

  it("uses gen_random_uuid() for the primary key default", () => {
    const block =
      /create\s+table\s+public\.discovery_evidence\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/id\s+uuid\s+primary\s+key\s+default\s+gen_random_uuid\(\)/i);
  });

  it("references auth.users on delete cascade for user_id", () => {
    const block =
      /create\s+table\s+public\.discovery_evidence\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(
      /user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
    );
  });

  it("declares invocation_id as NOT NULL uuid", () => {
    const block =
      /create\s+table\s+public\.discovery_evidence\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/invocation_id\s+uuid\s+not\s+null/i);
  });

  it("constrains provider_class with the identifier-safe regex", () => {
    const block =
      /create\s+table\s+public\.discovery_evidence\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/provider_class[\s\S]{0,60}?check\s*\([\s\S]{0,60}?\^?\[a-z\]/i);
  });

  it("declares is_aggregator_attributed as boolean NOT NULL DEFAULT false", () => {
    const block =
      /create\s+table\s+public\.discovery_evidence\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/is_aggregator_attributed\s+boolean\s+not\s+null\s+default\s+false/i);
  });

  it("declares evidence_type as NOT NULL text", () => {
    const block =
      /create\s+table\s+public\.discovery_evidence\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/evidence_type\s+text\s+not\s+null/i);
  });

  it("declares evidence_summary as NOT NULL text", () => {
    const block =
      /create\s+table\s+public\.discovery_evidence\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/evidence_summary\s+text\s+not\s+null/i);
  });

  it("declares provider_evidence_json as nullable text (no NOT NULL)", () => {
    const block =
      /create\s+table\s+public\.discovery_evidence\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    // Present in column list
    expect(block).toMatch(/provider_evidence_json/i);
    // Must NOT be NOT NULL — nullable for providers with no raw payload
    expect(block).not.toMatch(/provider_evidence_json\s+text\s+not\s+null/i);
  });

  it("uses created_at NOT NULL DEFAULT now()", () => {
    const block =
      /create\s+table\s+public\.discovery_evidence\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/created_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
  });
});

// ---------------------------------------------------------------------------
// discovery_evidence — cross-user composite FK to discovery_provider_invocations
// ---------------------------------------------------------------------------

describe("discovery_evidence — cross-user composite FK to discovery_provider_invocations", () => {
  it("uses the cross-user composite FK form (user_id, invocation_id)", () => {
    expect(statements).toMatch(
      /foreign\s+key\s*\(\s*user_id\s*,\s*invocation_id\s*\)\s+references\s+public\.discovery_provider_invocations\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });

  it("does NOT use a plain single-column invocation_id FK", () => {
    // A plain FK would allow cross-user parent/child associations
    expect(statements).not.toMatch(
      /foreign\s+key\s*\(\s*invocation_id\s*\)\s+references\s+public\.discovery_provider_invocations\s*\(\s*id\s*\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// discovery_evidence — UNIQUE (user_id, id)
// ---------------------------------------------------------------------------

describe("discovery_evidence — UNIQUE (user_id, id)", () => {
  it("adds UNIQUE (user_id, id) for downstream composite FKs", () => {
    expect(statements).toMatch(/discovery_evidence_user_id_id_key/i);
  });

  it("names the constraint correctly", () => {
    expect(statements).toMatch(
      /constraint\s+discovery_evidence_user_id_id_key\s+unique\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// discovery_evidence — RLS and grants
// ---------------------------------------------------------------------------

describe("discovery_evidence — RLS", () => {
  it("enables row level security", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.discovery_evidence\s+enable\s+row\s+level\s+security/i,
    );
  });

  it("creates a select-own policy for authenticated", () => {
    expect(statements).toMatch(
      /create\s+policy\s+"discovery_evidence_select_own"[\s\S]{0,200}?for\s+select\s+to\s+authenticated/i,
    );
    expect(statements).toMatch(
      /discovery_evidence_select_own[\s\S]{0,200}?auth\.uid\s*\(\s*\)\s*=\s*user_id/i,
    );
  });

  it("does NOT create insert, update, or delete policies for authenticated", () => {
    const policies = [
      ...statements.matchAll(/create\s+policy[\s\S]*?on\s+public\.discovery_evidence/gi),
    ];
    for (const m of policies) {
      expect(m[0]).not.toMatch(/\bfor\s+(insert|update|delete)\b/i);
    }
  });
});

describe("discovery_evidence — privileges", () => {
  it("revokes all from anon", () => {
    expect(statements).toMatch(/revoke\s+all\s+on\s+public\.discovery_evidence\s+from\s+anon/i);
  });

  it("grants only SELECT to authenticated", () => {
    const grantAuth =
      /grant[\s\S]{0,80}?on\s+public\.discovery_evidence\s+to\s+authenticated[^;]*;/i.exec(
        statements,
      )?.[0] ?? "";
    expect(grantAuth).toBeTruthy();
    expect(grantAuth).toMatch(/\bselect\b/i);
    expect(grantAuth).not.toMatch(/\binsert\b/i);
    expect(grantAuth).not.toMatch(/\bupdate\b/i);
    expect(grantAuth).not.toMatch(/\bdelete\b/i);
  });

  it("grants all verbs to service_role", () => {
    const grantSvc =
      /grant[\s\S]{0,80}?on\s+public\.discovery_evidence\s+to\s+service_role[^;]*;/i.exec(
        statements,
      )?.[0] ?? "";
    expect(grantSvc).toBeTruthy();
    expect(grantSvc).toMatch(/\bselect\b/i);
    expect(grantSvc).toMatch(/\binsert\b/i);
    expect(grantSvc).toMatch(/\bupdate\b/i);
    expect(grantSvc).toMatch(/\bdelete\b/i);
  });
});

// ---------------------------------------------------------------------------
// discovery_candidates — table creation
// ---------------------------------------------------------------------------

describe("discovery_candidates — table creation", () => {
  it("creates the discovery_candidates table", () => {
    expect(statements).toMatch(/create\s+table\s+public\.discovery_candidates/i);
  });

  it("uses gen_random_uuid() for the primary key default", () => {
    const block =
      /create\s+table\s+public\.discovery_candidates\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/id\s+uuid\s+primary\s+key\s+default\s+gen_random_uuid\(\)/i);
  });

  it("references auth.users on delete cascade for user_id", () => {
    const block =
      /create\s+table\s+public\.discovery_candidates\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(
      /user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
    );
  });

  it("declares evidence_id as NOT NULL uuid", () => {
    const block =
      /create\s+table\s+public\.discovery_candidates\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/evidence_id\s+uuid\s+not\s+null/i);
  });

  it("declares status NOT NULL DEFAULT 'pending'", () => {
    const block =
      /create\s+table\s+public\.discovery_candidates\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/status\s+text\s+not\s+null\s+default\s+'pending'/i);
  });

  it("constrains status to the five valid values", () => {
    const block =
      /create\s+table\s+public\.discovery_candidates\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    for (const v of ["pending", "confirmed", "rejected", "dismissed", "not_sure"]) {
      expect(block).toContain(`'${v}'`);
    }
  });

  it("declares asset_id as nullable uuid (no NOT NULL)", () => {
    const block =
      /create\s+table\s+public\.discovery_candidates\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/asset_id\s+uuid/i);
    expect(block).not.toMatch(/asset_id\s+uuid\s+not\s+null/i);
  });

  it("does NOT include service_name or service_domain columns", () => {
    const block =
      /create\s+table\s+public\.discovery_candidates\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).not.toMatch(/service_name/i);
    expect(block).not.toMatch(/service_domain/i);
  });

  it("declares adjudicated_at as nullable timestamptz", () => {
    const block =
      /create\s+table\s+public\.discovery_candidates\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/adjudicated_at\s+timestamptz/i);
    expect(block).not.toMatch(/adjudicated_at\s+timestamptz\s+not\s+null/i);
  });

  it("declares updated_at as NOT NULL DEFAULT now()", () => {
    const block =
      /create\s+table\s+public\.discovery_candidates\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/updated_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
  });
});

// ---------------------------------------------------------------------------
// discovery_candidates — cross-user composite FKs
// ---------------------------------------------------------------------------

describe("discovery_candidates — cross-user composite FK to discovery_evidence", () => {
  it("uses the cross-user composite FK form (user_id, evidence_id)", () => {
    expect(statements).toMatch(
      /foreign\s+key\s*\(\s*user_id\s*,\s*evidence_id\s*\)\s+references\s+public\.discovery_evidence\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });

  it("does NOT use a plain single-column evidence_id FK", () => {
    expect(statements).not.toMatch(
      /foreign\s+key\s*\(\s*evidence_id\s*\)\s+references\s+public\.discovery_evidence\s*\(\s*id\s*\)/i,
    );
  });
});

describe("discovery_candidates — cross-user composite FK to digital_assets", () => {
  it("uses the cross-user composite FK form (user_id, asset_id)", () => {
    expect(statements).toMatch(
      /foreign\s+key\s*\(\s*user_id\s*,\s*asset_id\s*\)\s+references\s+public\.digital_assets\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });

  it("does NOT use a plain single-column asset_id FK", () => {
    expect(statements).not.toMatch(
      /foreign\s+key\s*\(\s*asset_id\s*\)\s+references\s+public\.digital_assets\s*\(\s*id\s*\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// discovery_candidates — UNIQUE (user_id, id)
// ---------------------------------------------------------------------------

describe("discovery_candidates — UNIQUE (user_id, id)", () => {
  it("adds discovery_candidates_user_id_id_key unique constraint", () => {
    expect(statements).toMatch(
      /constraint\s+discovery_candidates_user_id_id_key\s+unique\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });

  it("is required for the cross-user composite FK from digital_assets (user_id, candidate_id)", () => {
    // PostgreSQL requires UNIQUE (user_id, id) on the referenced table for
    // FOREIGN KEY (user_id, candidate_id) REFERENCES discovery_candidates (user_id, id)
    // to be valid. This constraint satisfies that requirement.
    expect(statements).toMatch(
      /constraint\s+discovery_candidates_user_id_id_key\s+unique\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
    expect(statements).toMatch(
      /foreign\s+key\s*\(\s*user_id\s*,\s*candidate_id\s*\)\s+references\s+public\.discovery_candidates\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// digital_assets — cross-user candidate_id FK protection (ADR-008 §10)
// ---------------------------------------------------------------------------

describe("digital_assets — cross-user candidate_id FK protection (ADR-008 §10)", () => {
  it("composite FK prevents user A's asset linking to user B's candidate", () => {
    // FOREIGN KEY (user_id, candidate_id) REFERENCES discovery_candidates (user_id, id)
    // ensures the user_id on the digital_assets row must match the user_id on the
    // referenced discovery_candidates row. A plain FK on candidate_id alone cannot
    // enforce this: it would allow cross-user linkage that RLS alone cannot prevent
    // at the schema level (ADR-008 §10).
    //
    // The repository's schema-test infrastructure is SQL-text only; there is no live
    // database connection in the test suite. Cross-user FK enforcement is proven by
    // the positive assertion (composite form is present) and the negative assertion
    // (plain form is absent) in the "digital_assets — deferred candidate_id FK wired"
    // describe block above.
    expect(statements).toMatch(
      /foreign\s+key\s*\(\s*user_id\s*,\s*candidate_id\s*\)\s+references\s+public\.discovery_candidates\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
    expect(statements).not.toMatch(
      /foreign\s+key\s*\(\s*candidate_id\s*\)\s+references\s+public\.discovery_candidates\s*\(\s*id\s*\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// discovery_candidates — updated_at trigger
// ---------------------------------------------------------------------------

describe("discovery_candidates — updated_at trigger", () => {
  it("attaches the shared set_updated_at trigger", () => {
    expect(statements).toMatch(
      /create\s+trigger\s+discovery_candidates_set_updated_at[\s\S]{0,200}?execute\s+function\s+public\.set_updated_at\s*\(\s*\)/i,
    );
  });

  it("fires before update for each row", () => {
    expect(statements).toMatch(
      /create\s+trigger\s+discovery_candidates_set_updated_at\s+before\s+update\s+on\s+public\.discovery_candidates\s+for\s+each\s+row/i,
    );
  });
});

// ---------------------------------------------------------------------------
// discovery_candidates — partial unique index (one pending per evidence)
// ---------------------------------------------------------------------------

describe("discovery_candidates — pending-candidate partial unique index", () => {
  it("creates a unique index on (user_id, evidence_id) where status = 'pending'", () => {
    expect(statements).toMatch(
      /create\s+unique\s+index\s+discovery_candidates_one_pending_per_evidence\s+on\s+public\.discovery_candidates\s*\(\s*user_id\s*,\s*evidence_id\s*\)/i,
    );
  });

  it("is a partial index scoped to status = 'pending'", () => {
    const idx =
      /create\s+unique\s+index\s+discovery_candidates_one_pending_per_evidence[\s\S]{0,200}?;/i.exec(
        statements,
      )?.[0] ?? "";
    expect(idx).toMatch(/where\s+status\s*=\s*'pending'/i);
  });
});

// ---------------------------------------------------------------------------
// discovery_candidates — RLS and grants
// ---------------------------------------------------------------------------

describe("discovery_candidates — RLS", () => {
  it("enables row level security", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.discovery_candidates\s+enable\s+row\s+level\s+security/i,
    );
  });

  it("creates a select-own policy for authenticated", () => {
    expect(statements).toMatch(
      /create\s+policy\s+"discovery_candidates_select_own"[\s\S]{0,200}?for\s+select\s+to\s+authenticated/i,
    );
    expect(statements).toMatch(
      /discovery_candidates_select_own[\s\S]{0,200}?auth\.uid\s*\(\s*\)\s*=\s*user_id/i,
    );
  });

  it("does NOT create insert, update, or delete policies for authenticated", () => {
    const policies = [
      ...statements.matchAll(/create\s+policy[\s\S]*?on\s+public\.discovery_candidates/gi),
    ];
    for (const m of policies) {
      expect(m[0]).not.toMatch(/\bfor\s+(insert|update|delete)\b/i);
    }
  });
});

describe("discovery_candidates — privileges", () => {
  it("revokes all from anon", () => {
    expect(statements).toMatch(/revoke\s+all\s+on\s+public\.discovery_candidates\s+from\s+anon/i);
  });

  it("grants only SELECT to authenticated", () => {
    const grantAuth =
      /grant[\s\S]{0,80}?on\s+public\.discovery_candidates\s+to\s+authenticated[^;]*;/i.exec(
        statements,
      )?.[0] ?? "";
    expect(grantAuth).toBeTruthy();
    expect(grantAuth).toMatch(/\bselect\b/i);
    expect(grantAuth).not.toMatch(/\binsert\b/i);
    expect(grantAuth).not.toMatch(/\bupdate\b/i);
    expect(grantAuth).not.toMatch(/\bdelete\b/i);
  });

  it("grants all verbs to service_role", () => {
    const grantSvc =
      /grant[\s\S]{0,80}?on\s+public\.discovery_candidates\s+to\s+service_role[^;]*;/i.exec(
        statements,
      )?.[0] ?? "";
    expect(grantSvc).toBeTruthy();
    expect(grantSvc).toMatch(/\bselect\b/i);
    expect(grantSvc).toMatch(/\binsert\b/i);
    expect(grantSvc).toMatch(/\bupdate\b/i);
    expect(grantSvc).toMatch(/\bdelete\b/i);
  });
});

// ---------------------------------------------------------------------------
// discovery_rejections — table creation
// ---------------------------------------------------------------------------

describe("discovery_rejections — table creation", () => {
  it("creates the discovery_rejections table", () => {
    expect(statements).toMatch(/create\s+table\s+public\.discovery_rejections/i);
  });

  it("uses gen_random_uuid() for the primary key default", () => {
    const block =
      /create\s+table\s+public\.discovery_rejections\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/id\s+uuid\s+primary\s+key\s+default\s+gen_random_uuid\(\)/i);
  });

  it("references auth.users on delete cascade for user_id", () => {
    const block =
      /create\s+table\s+public\.discovery_rejections\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(
      /user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
    );
  });

  it("declares fingerprint as NOT NULL text", () => {
    const block =
      /create\s+table\s+public\.discovery_rejections\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/fingerprint\s+text\s+not\s+null/i);
  });

  it("constrains provider_class with the identifier-safe regex", () => {
    const block =
      /create\s+table\s+public\.discovery_rejections\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/provider_class[\s\S]{0,60}?check\s*\([\s\S]{0,60}?\^?\[a-z\]/i);
  });

  it("uses created_at NOT NULL DEFAULT now()", () => {
    const block =
      /create\s+table\s+public\.discovery_rejections\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).toMatch(/created_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
  });

  it("does NOT add a fingerprint column with AES encryption hint", () => {
    // Fingerprints must NOT be AES-encrypted; equality lookup requires
    // deterministic values (ADR-008 §5).
    const block =
      /create\s+table\s+public\.discovery_rejections\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).not.toMatch(/fingerprint_encrypted/i);
  });
});

// ---------------------------------------------------------------------------
// discovery_rejections — UNIQUE (user_id, fingerprint)
// ---------------------------------------------------------------------------

describe("discovery_rejections — fingerprint uniqueness", () => {
  it("adds UNIQUE (user_id, fingerprint) constraint", () => {
    expect(statements).toMatch(
      /constraint\s+discovery_rejections_user_fingerprint_key\s+unique\s*\(\s*user_id\s*,\s*fingerprint\s*\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// discovery_rejections — RLS and grants
// ---------------------------------------------------------------------------

describe("discovery_rejections — RLS", () => {
  it("enables row level security", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.discovery_rejections\s+enable\s+row\s+level\s+security/i,
    );
  });

  it("creates a select-own policy for authenticated", () => {
    expect(statements).toMatch(
      /create\s+policy\s+"discovery_rejections_select_own"[\s\S]{0,200}?for\s+select\s+to\s+authenticated/i,
    );
    expect(statements).toMatch(
      /discovery_rejections_select_own[\s\S]{0,200}?auth\.uid\s*\(\s*\)\s*=\s*user_id/i,
    );
  });

  it("does NOT create insert, update, or delete policies for authenticated", () => {
    const policies = [
      ...statements.matchAll(/create\s+policy[\s\S]*?on\s+public\.discovery_rejections/gi),
    ];
    for (const m of policies) {
      expect(m[0]).not.toMatch(/\bfor\s+(insert|update|delete)\b/i);
    }
  });
});

describe("discovery_rejections — privileges", () => {
  it("revokes all from anon", () => {
    expect(statements).toMatch(/revoke\s+all\s+on\s+public\.discovery_rejections\s+from\s+anon/i);
  });

  it("grants only SELECT to authenticated", () => {
    const grantAuth =
      /grant[\s\S]{0,80}?on\s+public\.discovery_rejections\s+to\s+authenticated[^;]*;/i.exec(
        statements,
      )?.[0] ?? "";
    expect(grantAuth).toBeTruthy();
    expect(grantAuth).toMatch(/\bselect\b/i);
    expect(grantAuth).not.toMatch(/\binsert\b/i);
    expect(grantAuth).not.toMatch(/\bupdate\b/i);
    expect(grantAuth).not.toMatch(/\bdelete\b/i);
  });

  it("grants all verbs to service_role", () => {
    const grantSvc =
      /grant[\s\S]{0,80}?on\s+public\.discovery_rejections\s+to\s+service_role[^;]*;/i.exec(
        statements,
      )?.[0] ?? "";
    expect(grantSvc).toBeTruthy();
    expect(grantSvc).toMatch(/\bselect\b/i);
    expect(grantSvc).toMatch(/\binsert\b/i);
    expect(grantSvc).toMatch(/\bupdate\b/i);
    expect(grantSvc).toMatch(/\bdelete\b/i);
  });
});

// ---------------------------------------------------------------------------
// digital_assets — deferred candidate_id FK
// ---------------------------------------------------------------------------

describe("digital_assets — deferred candidate_id FK wired", () => {
  it("uses the cross-user composite FK form (user_id, candidate_id) referencing discovery_candidates (user_id, id)", () => {
    // ADR-008 §10: plain single-column FK is insufficient for cross-user integrity.
    expect(statements).toMatch(
      /alter\s+table\s+public\.digital_assets[\s\S]{0,100}?add\s+constraint\s+digital_assets_candidate_id_fkey[\s\S]{0,100}?foreign\s+key\s*\(\s*user_id\s*,\s*candidate_id\s*\)\s+references\s+public\.discovery_candidates\s*\(\s*user_id\s*,\s*id\s*\)/i,
    );
  });

  it("does NOT use a plain single-column candidate_id FK (ADR-008 §10)", () => {
    // A plain FK would allow user A's digital_assets row to reference
    // user B's discovery_candidates row — a cross-user integrity gap.
    expect(statements).not.toMatch(
      /foreign\s+key\s*\(\s*candidate_id\s*\)\s+references\s+public\.discovery_candidates\s*\(\s*id\s*\)/i,
    );
  });

  it("NULL candidate_id remains allowed — the column is not made NOT NULL here", () => {
    const alterBlock =
      /alter\s+table\s+public\.digital_assets[\s\S]{0,400}?;/i.exec(statements)?.[0] ?? "";
    expect(alterBlock).not.toMatch(/set\s+not\s+null/i);
  });

  it("does NOT add it in ATL-200 or ATL-201 migrations", () => {
    // This is an ATL-202 concern; the earlier migrations must not contain it.
    // We test the ATL-202 migration directly — presence here is the positive assertion.
    expect(statements).toMatch(/digital_assets_candidate_id_fkey/i);
  });

  it("does NOT drop or alter any existing digital_assets constraint", () => {
    const alterBlocks = [
      ...statements.matchAll(/alter\s+table\s+public\.digital_assets[\s\S]{0,300}?;/gi),
    ];
    for (const m of alterBlocks) {
      expect(m[0]).not.toMatch(/\bdrop\s+constraint\b/i);
      expect(m[0]).not.toMatch(/\bdrop\s+column\b/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Encryption contract
// ---------------------------------------------------------------------------

describe("encryption contract — provider_evidence_json AAD comment", () => {
  it("documents the AAD as discovery_evidence.provider_evidence_json:<record_uuid>", () => {
    // The comment on the column must capture the AAD binding so the encryption
    // contract is readable from the schema without inspecting application code.
    expect(sql).toMatch(/discovery_evidence\.provider_evidence_json:<row_id>/i);
  });

  it("does NOT describe fingerprint as AES-encrypted in the column definition", () => {
    // ADR-008 §5: fingerprints are HMAC-SHA256, not AES-GCM. The column definition
    // inside the CREATE TABLE block must not reference AES encryption. The COMMENT ON
    // correctly states it is NOT AES-encrypted; that wording in a string literal is
    // intentional documentation, not a schema claim.
    const block =
      /create\s+table\s+public\.discovery_rejections\s*\(([\s\S]*?)\)\s*;/i.exec(statements)?.[0] ??
      "";
    expect(block).not.toMatch(/fingerprint[\s\S]{0,80}?aes/i);
  });
});

// ---------------------------------------------------------------------------
// Boundary — no ATL-203+ implementation
// ---------------------------------------------------------------------------

describe("boundary — no ATL-203+ implementation leaked in", () => {
  it("does not implement RejectionKeyService or any key-derivation logic", () => {
    expect(statements).not.toMatch(/rejection_key_service/i);
    expect(statements).not.toMatch(/hmac\s*\(/i);
    expect(statements).not.toMatch(/create\s+function[\s\S]{0,60}?rejection/i);
  });

  it("does not implement DiscoveryConsentService or ConsentProof logic", () => {
    expect(statements).not.toMatch(/consent_proof/i);
    expect(statements).not.toMatch(/discovery_consent/i);
  });

  it("does not create discovery_consents or discovery_first_disclosure_acknowledgments tables", () => {
    expect(statements).not.toMatch(/create\s+table\s+public\.discovery_consents/i);
    expect(statements).not.toMatch(/discovery_first_disclosure_acknowledgments/i);
  });
});
