import { describe, expect, it } from "vitest";
import {
  parseTimestamp,
  sortMigrations,
  validateMigrations,
  type MigrationFile,
} from "./migration-validation";

/**
 * ATL-004 — migration validation.
 *
 * The append-only rule (architecture §8) is the one repository invariant that
 * cannot be repaired after the fact, so every violation class is covered along with
 * the legitimate cases that must NOT be flagged.
 */

const file = (name: string, content = "select 1;"): MigrationFile => ({ name, content });

const rules = (opts: Parameters<typeof validateMigrations>[0]) =>
  validateMigrations(opts).map((v) => v.rule);

const withBaseline = (base: MigrationFile[], current: MigrationFile[]) => ({
  base,
  current,
  baselineAvailable: true,
});

describe("parseTimestamp", () => {
  it("extracts the timestamp prefix", () => {
    expect(parseTimestamp("20260801120000_create_profiles.sql")).toBe("20260801120000");
  });

  it.each([
    "create_profiles.sql",
    "2026080112_create_profiles.sql",
    "20260801120000_CreateProfiles.sql",
    "20260801120000_create-profiles.sql",
    "20260801120000_create_profiles.txt",
  ])("rejects %s", (name) => {
    expect(parseTimestamp(name)).toBeNull();
  });
});

describe("sortMigrations", () => {
  it("orders chronologically by filename", () => {
    const sorted = sortMigrations([file("20260802000000_b.sql"), file("20260801000000_a.sql")]);
    expect(sorted.map((f) => f.name)).toEqual(["20260801000000_a.sql", "20260802000000_b.sql"]);
  });
});

describe("append-only enforcement", () => {
  const committed = file("20260801120000_create_profiles.sql", "create table x;");

  it("accepts an unchanged baseline with a newer migration appended", () => {
    const current = [committed, file("20260802120000_add_index.sql")];
    expect(rules(withBaseline([committed], current))).toEqual([]);
  });

  it("detects a modified migration", () => {
    const edited = file(committed.name, "create table x; -- sneaky edit");
    expect(rules(withBaseline([committed], [edited]))).toContain("migration-modified");
  });

  it("detects a deleted migration", () => {
    expect(rules(withBaseline([committed], []))).toContain("migration-deleted");
  });

  it("detects a migration inserted before the latest committed one", () => {
    const inserted = file("20260701000000_earlier.sql");
    expect(rules(withBaseline([committed], [committed, inserted]))).toContain(
      "migration-inserted-out-of-order",
    );
  });

  it("detects a migration sharing an existing timestamp", () => {
    // Ordering would be ambiguous; `duplicate-timestamp` is the precise diagnosis.
    const sameInstant = file("20260801120000_other_change.sql");
    expect(rules(withBaseline([committed], [committed, sameInstant]))).toContain(
      "duplicate-timestamp",
    );
  });

  it("does not re-report content rules for migrations already in the baseline", () => {
    // A committed migration cannot be edited, so its content must not fail the gate.
    const legacy = file("20260101000000_legacy.sql", "create table public.old_table (id uuid);");
    expect(rules(withBaseline([legacy], [legacy]))).toEqual([]);
  });

  it("skips append-only comparison when no baseline is available", () => {
    // A missing baseline must not be reported as a modification.
    const result = validateMigrations({
      base: [],
      current: [committed],
      baselineAvailable: false,
    });
    expect(result.map((v) => v.rule)).not.toContain("migration-modified");
  });

  it("passes cleanly when there are no migrations at all", () => {
    expect(validateMigrations(withBaseline([], []))).toEqual([]);
  });
});

describe("filename validation", () => {
  it("rejects a malformed filename", () => {
    expect(rules(withBaseline([], [file("create_profiles.sql")]))).toContain("invalid-filename");
  });

  it("rejects two migrations sharing a timestamp", () => {
    const current = [file("20260801120000_a.sql"), file("20260801120000_b.sql")];
    expect(rules(withBaseline([], current))).toContain("duplicate-timestamp");
  });

  it("accepts a well-formed filename", () => {
    expect(rules(withBaseline([], [file("20260801120000_create_digital_assets.sql")]))).toEqual([]);
  });
});

describe("RLS enforcement on new tables", () => {
  const name = "20260801120000_create_digital_assets.sql";

  it("rejects a table created without RLS", () => {
    const sql = `create table public.digital_assets (id uuid primary key);`;
    expect(rules(withBaseline([], [file(name, sql)]))).toContain("table-without-rls");
  });

  it("rejects a table with RLS but no policies", () => {
    const sql = `
      create table public.digital_assets (id uuid primary key);
      alter table public.digital_assets enable row level security;
    `;
    expect(rules(withBaseline([], [file(name, sql)]))).toContain("table-without-policies");
  });

  it("accepts a table with RLS and a policy", () => {
    const sql = `
      create table public.digital_assets (id uuid primary key, user_id uuid not null);
      alter table public.digital_assets enable row level security;
      create policy "users_read_own" on public.digital_assets
        for select using (auth.uid() = user_id);
    `;
    expect(rules(withBaseline([], [file(name, sql)]))).toEqual([]);
  });

  it("accepts an internal table that declares deny-all intent", () => {
    // audit_events and user_encryption_keys have RLS with no policies by design (ADR-006).
    const sql = `
      create table public.audit_events (id uuid primary key);
      alter table public.audit_events enable row level security;
      -- rls: deny-all (internal table; server-only writer, ADR-006)
    `;
    expect(rules(withBaseline([], [file(name, sql)]))).toEqual([]);
  });

  it("does not treat commented-out SQL as a real RLS statement", () => {
    const sql = `
      create table public.digital_assets (id uuid primary key);
      -- alter table public.digital_assets enable row level security;
    `;
    expect(rules(withBaseline([], [file(name, sql)]))).toContain("table-without-rls");
  });

  it("handles multiple tables in one migration independently", () => {
    const sql = `
      create table public.good_table (id uuid primary key, user_id uuid);
      alter table public.good_table enable row level security;
      create policy "users_read_own" on public.good_table for select using (auth.uid() = user_id);

      create table public.bad_table (id uuid primary key);
    `;
    const violations = validateMigrations(withBaseline([], [file(name, sql)]));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("table-without-rls");
    expect(violations[0]?.message).toContain("bad_table");
  });

  it("recognises `create table if not exists`", () => {
    const sql = `create table if not exists public.digital_assets (id uuid primary key);`;
    expect(rules(withBaseline([], [file(name, sql)]))).toContain("table-without-rls");
  });
});

describe("violation reporting", () => {
  it("names the offending file and explains the rule", () => {
    const committed = file("20260801120000_create_profiles.sql", "original");
    const edited = file(committed.name, "edited");
    const [violation] = validateMigrations(withBaseline([committed], [edited]));

    expect(violation?.file).toBe(committed.name);
    expect(violation?.message).toMatch(/forward migration/i);
  });
});
