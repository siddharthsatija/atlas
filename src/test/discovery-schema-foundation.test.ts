import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ATL-200 — Discovery schema foundation, asserted against the migration source.
 *
 * Tests read the migration SQL and strip comments before asserting on
 * statements, consistent with the convention established by
 * encryption-keys-schema.test.ts and digital-assets-schema.test.ts.
 *
 * These tests do not require a running database: they assert that the migration
 * file contains the correct SQL to implement the ATL-200 contract when applied.
 * Integration tests against a live database are a separate concern.
 */

const ROOT = join(__dirname, "../..");
const MIGRATION = "supabase/migrations/20260821090000_atl_200_discovery_schema_foundation.sql";

const sql = execFileSync("cat", [join(ROOT, MIGRATION)], { encoding: "utf8" });
/** Statements only — a comment must never satisfy a security assertion. */
const statements = sql.replace(/--[^\n]*/g, "");

// ---------------------------------------------------------------------------
// digital_assets
// ---------------------------------------------------------------------------

describe("digital_assets — source_type extension", () => {
  it("drops the old source_type constraint before adding the replacement", () => {
    // Ensures there is no window where both the old and new constraints coexist
    // with conflicting vocabularies.
    expect(statements).toMatch(
      /drop\s+constraint[\s\S]{0,120}?digital_assets[\s\S]{0,40}?drop\s+constraint|do\s*\$\$[\s\S]{0,600}?digital_assets[\s\S]{0,200}?source_type[\s\S]{0,200}?drop\s+constraint/i,
    );
  });

  it("adds a named source_type constraint covering all five values", () => {
    // Named constraint so future migrations can drop it by name.
    const constraint =
      /add\s+constraint\s+digital_assets_source_type_check\s+check\s*\(([\s\S]*?)\)/i.exec(
        statements,
      )?.[0] ?? "";

    expect(constraint).toBeTruthy();
    for (const v of ["manual", "demo", "connector", "import", "discovery"]) {
      expect(constraint).toContain(`'${v}'`);
    }
  });
});

describe("digital_assets — candidate_id column", () => {
  it("adds candidate_id as a nullable uuid column", () => {
    expect(statements).toMatch(/add\s+column\s+candidate_id\s+uuid\b/i);
    // Must NOT be NOT NULL — the column is nullable (non-discovery rows carry NULL)
    expect(statements).not.toMatch(/add\s+column\s+candidate_id\s+uuid\s+not\s+null/i);
  });

  it("does NOT add a foreign key to discovery_candidates in ATL-200", () => {
    // discovery_candidates does not exist until ATL-202. The FK is deferred.
    expect(statements).not.toMatch(/references[\s\S]{0,40}?discovery_candidates/i);
  });
});

describe("digital_assets — deleted_at column", () => {
  it("adds deleted_at as a nullable timestamptz column", () => {
    expect(statements).toMatch(/add\s+column\s+deleted_at\s+timestamptz\b/i);
    expect(statements).not.toMatch(/add\s+column\s+deleted_at\s+timestamptz\s+not\s+null/i);
  });
});

describe("digital_assets — candidate pairing constraint", () => {
  it("adds the named pairing constraint", () => {
    expect(statements).toMatch(
      /add\s+constraint\s+digital_assets_discovery_candidate_pairing\s+check/i,
    );
  });

  it("requires candidate_id IS NOT NULL for discovery rows", () => {
    const constraint =
      /constraint\s+digital_assets_discovery_candidate_pairing\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";

    expect(constraint).toBeTruthy();
    expect(constraint).toMatch(/source_type\s*=\s*'discovery'/i);
    expect(constraint).toMatch(/candidate_id\s+is\s+not\s+null/i);
  });

  it("requires candidate_id IS NULL for non-discovery rows", () => {
    const constraint =
      /constraint\s+digital_assets_discovery_candidate_pairing\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";

    expect(constraint).toMatch(/source_type\s*!=\s*'discovery'/i);
    expect(constraint).toMatch(/candidate_id\s+is\s+null/i);
  });
});

// ---------------------------------------------------------------------------
// privacy_findings
// ---------------------------------------------------------------------------

describe("privacy_findings — source_type extension", () => {
  it("adds a named source_type constraint covering all five values", () => {
    const constraint =
      /add\s+constraint\s+privacy_findings_source_type_check\s+check\s*\(([\s\S]*?)\)/i.exec(
        statements,
      )?.[0] ?? "";

    expect(constraint).toBeTruthy();
    for (const v of ["manual", "demo", "connector", "import", "discovery"]) {
      expect(constraint).toContain(`'${v}'`);
    }
  });
});

describe("privacy_findings — C1-D constraint", () => {
  it("adds the named discovery-requires-asset constraint", () => {
    expect(statements).toMatch(
      /add\s+constraint\s+privacy_findings_discovery_requires_asset\s+check/i,
    );
  });

  it("rejects a discovery finding with null asset_id", () => {
    const constraint =
      /constraint\s+privacy_findings_discovery_requires_asset\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";

    expect(constraint).toBeTruthy();
    // source_type != 'discovery' OR asset_id IS NOT NULL
    expect(constraint).toMatch(/source_type\s*!=\s*'discovery'/i);
    expect(constraint).toMatch(/asset_id\s+is\s+not\s+null/i);
  });
});

describe("privacy_findings — evidence_refs_json constraint", () => {
  it("adds the named discovery-refs-valid constraint", () => {
    expect(statements).toMatch(/add\s+constraint\s+privacy_findings_discovery_refs_valid\s+check/i);
  });

  it("uses a CASE guard to protect jsonb_path_exists from non-array input", () => {
    const block =
      /constraint\s+privacy_findings_discovery_refs_valid\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";

    expect(block).toBeTruthy();
    expect(block).toMatch(/\bcase\b/i);
    expect(block).toMatch(/jsonb_typeof\s*\(\s*evidence_refs_json\s*\)/i);
    expect(block).toMatch(/jsonb_array_length\s*\(\s*evidence_refs_json\s*\)/i);
    expect(block).toMatch(/jsonb_path_exists\s*\(\s*evidence_refs_json/i);
  });

  it("passes non-discovery rows unconditionally", () => {
    // source_type != 'discovery' => true is the first WHEN
    const block =
      /constraint\s+privacy_findings_discovery_refs_valid\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";

    expect(block).toMatch(/source_type\s*!=\s*'discovery'[\s\S]{0,20}?true/i);
  });

  it("rejects a non-array evidence_refs_json on discovery findings", () => {
    const block =
      /constraint\s+privacy_findings_discovery_refs_valid\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";

    // jsonb_typeof != 'array' => false
    expect(block).toMatch(/jsonb_typeof[\s\S]{0,40}?!=\s*'array'[\s\S]{0,20}?false/i);
  });

  it("rejects an empty array on discovery findings", () => {
    const block =
      /constraint\s+privacy_findings_discovery_refs_valid\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";

    // jsonb_array_length < 1 => false
    expect(block).toMatch(/jsonb_array_length[\s\S]{0,40}?<\s*1[\s\S]{0,20}?false/i);
  });

  it("enforces the closed ADR-007 type vocabulary", () => {
    const block =
      /constraint\s+privacy_findings_discovery_refs_valid\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";

    expect(block).toContain('"discovery_evidence"');
    expect(block).toContain('"digital_asset"');
    // not_in check catches unsupported types
    expect(block).toMatch(
      /@\.type\s*!=\s*"discovery_evidence"[\s\S]{0,60}?@\.type\s*!=\s*"digital_asset"/i,
    );
  });

  it("rejects elements with a null type or null id", () => {
    const block =
      /constraint\s+privacy_findings_discovery_refs_valid\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(
        statements,
      )?.[0] ?? "";

    // null type rejected
    expect(block).toMatch(/@\.type\s*==\s*null/i);
    // null id rejected
    expect(block).toMatch(/@\.id\s*==\s*null/i);
  });
});

// ---------------------------------------------------------------------------
// user_encryption_keys
// ---------------------------------------------------------------------------

describe("user_encryption_keys — key_purpose column", () => {
  it("adds key_purpose as NOT NULL with default 'content'", () => {
    expect(statements).toMatch(
      /add\s+column\s+key_purpose\s+text\s+not\s+null\s+default\s+'content'/i,
    );
  });

  it("constrains key_purpose to the approved vocabulary", () => {
    const col =
      /add\s+column\s+key_purpose\s+text\s+not\s+null[\s\S]{0,120}?check\s*\(([\s\S]*?)\)/i.exec(
        statements,
      )?.[0] ?? "";

    expect(col).toBeTruthy();
    expect(col).toContain("'content'");
    expect(col).toContain("'rejection'");
  });
});

describe("user_encryption_keys — index replacement", () => {
  it("drops the old one-active-per-user index", () => {
    expect(statements).toMatch(
      /drop\s+index[\s\S]{0,20}?user_encryption_keys_one_active_per_user/i,
    );
  });

  it("creates the new one-active-per-purpose index on (user_id, key_purpose)", () => {
    expect(statements).toMatch(
      /create\s+unique\s+index\s+user_encryption_keys_one_active_per_purpose/i,
    );
  });

  it("scopes the new unique index to active rows only", () => {
    const idx =
      /create\s+unique\s+index\s+user_encryption_keys_one_active_per_purpose[\s\S]{0,200}?;/i.exec(
        statements,
      )?.[0] ?? "";

    expect(idx).toMatch(/\(\s*user_id\s*,\s*key_purpose\s*\)/i);
    expect(idx).toMatch(/where\s+status\s*=\s*'active'/i);
  });

  it("does NOT preserve the old one-active-per-user index", () => {
    // After dropping it, it must not be re-created under the same name.
    const creates = statements.match(
      /create\s+unique\s+index\s+user_encryption_keys_one_active_per_user\b/gi,
    );
    expect(creates).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// user_personal_fields
// ---------------------------------------------------------------------------

describe("user_personal_fields — include_in_discovery column", () => {
  it("adds include_in_discovery as boolean NOT NULL DEFAULT false", () => {
    expect(statements).toMatch(
      /add\s+column\s+include_in_discovery\s+boolean\s+not\s+null\s+default\s+false/i,
    );
  });

  it("does NOT add use_for_discovery (no rename attempted)", () => {
    // Audit confirmed column is absent; we add, not rename.
    expect(statements).not.toMatch(/use_for_discovery/i);
    expect(statements).not.toMatch(/rename\s+column[\s\S]{0,80}?include_in_discovery/i);
  });
});

// ---------------------------------------------------------------------------
// consents
// ---------------------------------------------------------------------------

describe("consents — consent_type extension", () => {
  it("adds a named consent_type constraint covering all seven values", () => {
    const constraint =
      /add\s+constraint\s+consents_consent_type_check\s+check\s*\(([\s\S]*?)\)/i.exec(
        statements,
      )?.[0] ?? "";

    expect(constraint).toBeTruthy();
    for (const v of [
      "ai_processing",
      "personal_fields_storage",
      "ai_conversation_history",
      "product_updates",
      "discovery_hashed_query",
      "discovery_identifying",
      "discovery_connected_sources",
    ]) {
      expect(constraint).toContain(`'${v}'`);
    }
  });

  it("preserves all four original MVP consent types", () => {
    const constraint =
      /add\s+constraint\s+consents_consent_type_check\s+check\s*\(([\s\S]*?)\)/i.exec(
        statements,
      )?.[0] ?? "";

    for (const v of [
      "ai_processing",
      "personal_fields_storage",
      "ai_conversation_history",
      "product_updates",
    ]) {
      expect(constraint).toContain(`'${v}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// Append-only guard: no historic migration file was edited
// ---------------------------------------------------------------------------

describe("migration hygiene", () => {
  it("migration file exists at the expected path", () => {
    // If the file was missing, execFileSync above would have thrown.
    expect(sql.length).toBeGreaterThan(100);
  });

  it("does not touch the original user_encryption_keys migration", () => {
    // ATL-200 must not edit historical migrations.
    const original = execFileSync(
      "cat",
      [join(ROOT, "supabase/migrations/20260731090000_create_user_encryption_keys.sql")],
      { encoding: "utf8" },
    );
    // The original index name must still be present in the original file.
    expect(original).toMatch(/user_encryption_keys_one_active_per_user/);
    // The new key_purpose column must NOT be in the original file.
    expect(original).not.toMatch(/key_purpose/i);
  });

  it("does not touch the original privacy_findings migration", () => {
    const original = execFileSync(
      "cat",
      [join(ROOT, "supabase/migrations/20260809090000_create_privacy_findings.sql")],
      { encoding: "utf8" },
    );
    expect(original).not.toMatch(/discovery_refs_valid/i);
    expect(original).not.toMatch(/discovery_requires_asset/i);
  });

  it("does not touch the original consents migration", () => {
    const original = execFileSync(
      "cat",
      [join(ROOT, "supabase/migrations/20260804160000_create_consents.sql")],
      { encoding: "utf8" },
    );
    expect(original).not.toMatch(/discovery_hashed_query/i);
  });
});
