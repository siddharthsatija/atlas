import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ATL-015 — profiles schema guarantees, asserted against the migration source.
 *
 * These are **not** a substitute for the two-user RLS tests in
 * `tests/integration/profiles-rls.test.ts`, which exercise the policies against a
 * real database and are the authority on whether they work.
 *
 * They exist because the migration is append-only: once applied it can never be
 * edited, so a missing policy or a stray `for delete` becomes permanent and can
 * only be corrected by a forward migration. Catching it in the same commit is
 * worth a great deal, and unlike the database tests these run on every pull
 * request without Docker.
 */

const ROOT = join(__dirname, "../..");
const MIGRATION = "supabase/migrations/20260730120000_create_profiles.sql";

const sql = execFileSync("cat", [join(ROOT, MIGRATION)], { encoding: "utf8" });
/** Statements only — comments explain intent and must not satisfy an assertion. */
const statements = sql.replace(/--[^\n]*/g, "");

describe("ownership model", () => {
  it("uses the primary key as the owner column", () => {
    // Architecture §8: the one permitted exception to the user_id rule.
    expect(statements).toMatch(
      /id\s+uuid\s+primary\s+key\s+references\s+auth\.users\s*\(\s*id\s*\)/i,
    );
  });

  it("does not add a redundant user_id column", () => {
    // Two ownership columns could disagree about who owns the row.
    expect(statements).not.toMatch(/\buser_id\b/i);
  });

  it("cascades from the auth user so deletion cannot orphan the profile", () => {
    expect(statements).toMatch(/on\s+delete\s+cascade/i);
  });
});

describe("row level security", () => {
  it("enables RLS on the table", () => {
    expect(statements).toMatch(
      /alter\s+table\s+public\.profiles\s+enable\s+row\s+level\s+security/i,
    );
  });

  it.each(["select", "insert", "update"])("defines a %s policy", (operation) => {
    expect(statements).toMatch(new RegExp(`create\\s+policy[\\s\\S]*?for\\s+${operation}`, "i"));
  });

  it("defines no delete policy", () => {
    // Deliberate: a profile is removed only by deleting the auth user. Client
    // DELETE would strand a user's records with no profile governing them.
    expect(statements).not.toMatch(/create\s+policy[\s\S]{0,300}?for\s+delete/i);
  });

  it("scopes every policy to authenticated users", () => {
    const policies = statements.match(/create\s+policy[\s\S]*?;/gi) ?? [];
    expect(policies.length).toBeGreaterThanOrEqual(3);
    for (const policy of policies) {
      expect(policy).toMatch(/to\s+authenticated/i);
    }
  });

  it("compares against auth.uid() in every policy, never a client value", () => {
    const policies = statements.match(/create\s+policy[\s\S]*?;/gi) ?? [];
    for (const policy of policies) {
      // `\s*` before the parens: prettier-plugin-sql renders this as
      // `auth.uid ()`. The assertion is about the predicate, not the spacing.
      expect(policy).toMatch(/auth\.uid\s*\(\s*\)\s*=\s*id/i);
    }
  });

  it("pairs using and with check on the update policy", () => {
    // `using` alone would let a row be updated *out* of the caller's ownership.
    const update = /create\s+policy\s+"profiles_update_own"[\s\S]*?;/i.exec(statements)?.[0] ?? "";
    expect(update).toMatch(/using\s*\(/i);
    expect(update).toMatch(/with\s+check\s*\(/i);
  });

  it("grants the anonymous role nothing", () => {
    expect(statements).toMatch(/revoke\s+all\s+on\s+public\.profiles\s+from\s+anon/i);
    expect(statements).not.toMatch(/grant[^;]*\bto\s+anon\b/i);
  });
});

describe("table privileges", () => {
  /**
   * Postgres has two independent gates: GRANT (may this role touch the table?)
   * and RLS (which rows?). A correct policy with no grant yields
   * `42501 permission denied` before RLS is ever evaluated.
   *
   * That is exactly what shipped: every policy was right, `service_role` had no
   * grant, and the RLS suite failed seven assertions with null data. These tests
   * exist so the grant gate is checked as deliberately as the policy gate.
   */
  const grantFor = (role: string) =>
    new RegExp(`grant[\\s\\S]{0,200}?on\\s+public\\.profiles\\s+to\\s+${role}\\b`, "i").exec(
      statements,
    )?.[0] ?? "";

  it("grants authenticated exactly the operations its policies cover", () => {
    const grant = grantFor("authenticated");
    expect(grant).toBeTruthy();
    for (const privilege of ["select", "insert", "update"]) {
      expect(grant.toLowerCase()).toContain(privilege);
    }
  });

  it("withholds delete from authenticated", () => {
    // The second half of the "no DELETE policy" decision: with neither grant nor
    // policy, a client cannot delete even if a policy were added by mistake.
    expect(grantFor("authenticated").toLowerCase()).not.toContain("delete");
  });

  it("grants service_role the privileges server modules need", () => {
    // service_role bypasses RLS by role attribute, so this grant is the only
    // gate in front of it — and its absence is what broke the suite.
    const grant = grantFor("service_role");
    expect(grant).toBeTruthy();
    for (const privilege of ["select", "insert", "update", "delete"]) {
      expect(grant.toLowerCase()).toContain(privilege);
    }
  });

  it("hands no schema-shaping rights to any role", () => {
    // `grant all` would include TRUNCATE, REFERENCES and TRIGGER, which no data
    // role needs.
    expect(statements).not.toMatch(/grant\s+all[\s\S]{0,80}?on\s+public\.profiles/i);
    for (const privilege of ["truncate", "references", "trigger"]) {
      expect(statements.toLowerCase()).not.toContain(`${privilege} on public.profiles`);
    }
  });
});

describe("security definer functions", () => {
  it("pins an empty search_path on every function", () => {
    // A `security definer` function with a caller-controlled search_path is a
    // privilege-escalation primitive.
    const functions = statements.match(/create\s+or\s+replace\s+function[\s\S]*?\$\$;/gi) ?? [];
    expect(functions.length).toBeGreaterThanOrEqual(2);
    for (const fn of functions) {
      expect(fn).toMatch(/set\s+search_path\s*=\s*''/i);
    }
  });

  it("uses security definer only for the auth.users trigger", () => {
    const definers =
      statements.match(/create\s+or\s+replace\s+function[\s\S]*?security\s+definer/gi) ?? [];
    expect(definers).toHaveLength(1);
    expect(definers[0]).toMatch(/handle_new_user/i);
  });

  it("creates the profile idempotently on sign-in", () => {
    // A re-run trigger or a linked identity must not fail the sign-in.
    expect(statements).toMatch(/on\s+conflict\s*\(\s*id\s*\)\s*do\s+nothing/i);
  });
});

describe("columns and defaults", () => {
  it.each([
    "display_name",
    "timezone",
    "locale",
    "onboarding_completed_at",
    "onboarding_state_json",
    "privacy_goal",
    "selected_categories",
    "demo_data_enabled",
  ])("declares the documented column %s", (column) => {
    expect(statements).toMatch(new RegExp(`\\b${column}\\b`));
  });

  it("carries both timestamps", () => {
    expect(statements).toMatch(/created_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
    expect(statements).toMatch(/updated_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
  });

  it("maintains updated_at by trigger rather than by caller", () => {
    expect(statements).toMatch(
      /create\s+trigger\s+profiles_set_updated_at[\s\S]*?before\s+update/i,
    );
  });

  it("defaults timezone and locale rather than leaving them null", () => {
    expect(statements).toMatch(/timezone\s+text\s+not\s+null\s+default\s+'UTC'/i);
    expect(statements).toMatch(/locale\s+text\s+not\s+null\s+default\s+'en'/i);
  });

  it("bounds every free-text column", () => {
    for (const column of ["display_name", "timezone", "locale", "privacy_goal"]) {
      expect(statements).toMatch(new RegExp(`${column}[\\s\\S]{0,200}?char_length`, "i"));
    }
  });

  it("constrains onboarding state to a JSON object", () => {
    expect(statements).toMatch(/jsonb_typeof\(onboarding_state_json\)\s*=\s*'object'/i);
  });
});

describe("generated types agree with the migration", () => {
  const types = execFileSync("cat", [join(ROOT, "src/types/database.generated.ts")], {
    encoding: "utf8",
  });

  it.each([
    "id",
    "display_name",
    "timezone",
    "locale",
    "onboarding_completed_at",
    "onboarding_state_json",
    "privacy_goal",
    "selected_categories",
    "demo_data_enabled",
    "created_at",
    "updated_at",
  ])("exposes %s", (column) => {
    // Without a database in every environment, this is what catches
    // `pnpm db:types` not having been re-run after a schema change.
    expect(types).toContain(`${column}:`);
  });

  it("declares no relationships, because the foreign key crosses schemas", () => {
    /**
     * `supabase gen types` introspects only the `public` schema, so the foreign
     * key to `auth.users` produces `Relationships: []` rather than an entry.
     *
     * An earlier hand-written version of the generated file claimed a
     * `profiles_id_fkey` relationship and this test asserted it. Both were wrong:
     * the assertion was describing what the author expected the generator to do
     * rather than what it does, so it passed against the hand-written file and
     * failed the moment `pnpm db:types` produced the real output.
     *
     * The cascade itself is verified where it is actually observable — against a
     * live database, in `tests/integration/profiles-rls.test.ts`.
     */
    expect(types).toContain("Relationships: []");
    expect(types).not.toContain("profiles_id_fkey");
  });
});
