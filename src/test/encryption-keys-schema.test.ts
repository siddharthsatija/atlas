import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ATL-084 — `user_encryption_keys` schema guarantees, asserted against the
 * migration source.
 *
 * Not a substitute for `tests/integration/user-encryption-keys-rls.test.ts`,
 * which exercises the deny-all model against a real database. These exist
 * because the migration is append-only: a missing revoke or a stray policy
 * becomes permanent the moment it is applied, and this file runs on every pull
 * request without Docker.
 */

const ROOT = join(__dirname, "../..");
const MIGRATION = "supabase/migrations/20260731090000_create_user_encryption_keys.sql";

const sql = execFileSync("cat", [join(ROOT, MIGRATION)], { encoding: "utf8" });
/** Statements only — a comment must never satisfy a security assertion. */
const statements = sql.replace(/--[^\n]*/g, "");

describe("deny-all authorization model", () => {
  it("enables row level security", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.user_encryption_keys\s+enable\s+row\s+level\s+security/i,
    );
  });

  it("creates no policy of any kind", () => {
    // RLS on with no policy denies every client role every row. There is no
    // predicate to get wrong because there is no predicate (security §7).
    expect(statements).not.toMatch(/create\s+policy/i);
  });

  it("declares the deny-all intent for the migration validator", () => {
    // The `-- rls: deny-all` marker is how the ATL-004 gate distinguishes a
    // deliberate internal table from a table someone forgot to write policies
    // for. It lives in a comment, so this reads the raw file.
    expect(sql).toMatch(/--\s*rls:\s*deny-all/i);
  });

  it.each(["anon", "authenticated"])("revokes everything from %s", (role) => {
    expect(statements).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+public\\.user_encryption_keys[\\s\\S]{0,40}?from[\\s\\S]{0,20}?${role}`,
        "i",
      ),
    );
  });

  it.each(["anon", "authenticated"])("never grants anything to %s", (role) => {
    expect(statements).not.toMatch(
      new RegExp(
        `grant[\\s\\S]{0,200}?on\\s+public\\.user_encryption_keys\\s+to\\s+${role}\\b`,
        "i",
      ),
    );
  });

  it("grants service_role only what the key lifecycle needs", () => {
    const grant =
      /grant[\s\S]{0,200}?on\s+public\.user_encryption_keys\s+to\s+service_role\b/i.exec(
        statements,
      )?.[0] ?? "";

    expect(grant).toBeTruthy();
    for (const privilege of ["select", "insert", "update"]) {
      expect(grant.toLowerCase()).toContain(privilege);
    }
    // No DELETE: a destroyed key row is retained as evidence, and final removal
    // happens through the auth.users cascade, which does not consult grants.
    expect(grant.toLowerCase()).not.toContain("delete");
  });

  it("hands no schema-shaping rights to any role", () => {
    expect(statements).not.toMatch(/grant\s+all[\s\S]{0,80}?on\s+public\.user_encryption_keys/i);
  });
});

describe("key material integrity", () => {
  it("owns the row through user_id with a cascade", () => {
    expect(statements).toMatch(
      /user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\s*\(\s*id\s*\)\s*on\s+delete\s+cascade/i,
    );
  });

  it("allows at most one active key per user", () => {
    // Two active DEKs would split a user's data, and half would survive a
    // crypto-shred that destroyed only one.
    expect(statements).toMatch(
      /create\s+unique\s+index[\s\S]{0,160}?on\s+public\.user_encryption_keys[\s\S]{0,80}?where[\s\S]{0,60}?status\s*=\s*'active'/i,
    );
  });

  it("constrains status to the documented lifecycle", () => {
    expect(statements).toMatch(
      /status\s+text\s+not\s+null[\s\S]{0,120}?'active'[\s\S]{0,40}?'retired'[\s\S]{0,40}?'destroyed'/i,
    );
  });

  it("makes destruction all-or-nothing", () => {
    // Without this a half-shredded row — destroyed but still holding material,
    // or material cleared while still reading as active — is indistinguishable
    // from a healthy one.
    const constraint =
      /constraint\s+user_encryption_keys_destruction_is_complete\s+check\s*\(([\s\S]*?)\)\s*\n?\s*\);/i.exec(
        statements,
      )?.[0] ?? "";

    expect(constraint).toBeTruthy();
    expect(constraint).toMatch(/status\s*=\s*'destroyed'/i);
    expect(constraint).toMatch(/wrapped_dek\s+is\s+null/i);
    expect(constraint).toMatch(/destroyed_at\s+is\s+not\s+null/i);
  });

  it("requires a positive kek_version", () => {
    expect(statements).toMatch(
      /kek_version\s+integer\s+not\s+null\s+check\s*\(\s*kek_version\s*>\s*0\s*\)/i,
    );
  });

  it("indexes the foreign key and the rotation sweep", () => {
    expect(statements).toMatch(/create\s+index\s+user_encryption_keys_user_id_idx/i);
    expect(statements).toMatch(/create\s+index\s+user_encryption_keys_kek_version_idx/i);
  });

  it("reuses the shared updated_at trigger rather than redefining it", () => {
    // The profiles migration created `public.set_updated_at` to be shared.
    // Redefining it here would alter behaviour for an already-applied migration.
    expect(statements).toMatch(/execute\s+function\s+public\.set_updated_at\s*\(\s*\)/i);
    expect(statements).not.toMatch(/create\s+or\s+replace\s+function\s+public\.set_updated_at/i);
  });
});

describe("the profiles migration is untouched", () => {
  it("does not alter, drop, or re-policy profiles", () => {
    // Append-only: corrections to an applied migration arrive as new forward
    // migrations, never as edits, and this migration touches only its own table.
    expect(statements).not.toMatch(/\bprofiles\b/i);
  });
});

describe("generated types agree with the migration", () => {
  const types = execFileSync("cat", [join(ROOT, "src/types/database.generated.ts")], {
    encoding: "utf8",
  });

  it("exposes the table", () => {
    expect(types).toContain("user_encryption_keys:");
  });

  it.each(["wrapped_dek", "kek_version", "status", "destroyed_at", "user_id"])(
    "exposes %s",
    (column) => {
      expect(types).toContain(`${column}:`);
    },
  );

  it("types the shreddable material as nullable", () => {
    expect(types).toContain("wrapped_dek: string | null");
  });
});
