/**
 * Migration validation (ATL-004).
 *
 * Migrations are **append-only after shared deployment** (architecture §8,
 * `CLAUDE.md`, database skill). That rule is unenforceable by review alone: editing
 * a deployed migration produces a repository that is silently inconsistent with
 * every database it has already been applied to.
 *
 * These are pure functions over file lists so they can be exhaustively unit-tested
 * without git or a database. The CLI wrapper (`scripts/validate-migrations.mts`)
 * supplies the committed baseline from git.
 */

/** A migration file as it exists in some revision. */
export interface MigrationFile {
  /** Basename, e.g. `20260801120000_create_profiles.sql`. */
  name: string;
  content: string;
}

export type ViolationRule =
  | "migration-modified"
  | "migration-deleted"
  | "migration-inserted-out-of-order"
  | "invalid-filename"
  | "duplicate-timestamp"
  | "table-without-rls"
  | "table-without-policies";

export interface MigrationViolation {
  rule: ViolationRule;
  file: string;
  message: string;
}

/** `YYYYMMDDHHMMSS_snake_case_description.sql` (database skill, naming table). */
const FILENAME_PATTERN = /^(\d{14})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/**
 * Marks a table as intentionally having no client policies — RLS enabled and deny
 * all. Required for internal tables such as `audit_events` and
 * `user_encryption_keys` (ADR-003, ADR-006). Declaring intent explicitly keeps a
 * missing policy from looking identical to a deliberate deny-all.
 */
const DENY_ALL_MARKER = /--\s*rls:\s*deny-all/i;

export function parseTimestamp(name: string): string | null {
  return FILENAME_PATTERN.exec(name)?.[1] ?? null;
}

/** Sorts by filename, which is chronological because names are timestamp-prefixed. */
export function sortMigrations<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name));
}

function validateFilenames(current: MigrationFile[]): MigrationViolation[] {
  const violations: MigrationViolation[] = [];
  const seen = new Map<string, string>();

  for (const file of current) {
    const timestamp = parseTimestamp(file.name);
    if (timestamp === null) {
      violations.push({
        rule: "invalid-filename",
        file: file.name,
        message:
          "Migration filenames must be YYYYMMDDHHMMSS_snake_case_description.sql " +
          "so ordering is unambiguous (database skill, naming conventions).",
      });
      continue;
    }

    const existing = seen.get(timestamp);
    if (existing !== undefined) {
      violations.push({
        rule: "duplicate-timestamp",
        file: file.name,
        message: `Shares timestamp ${timestamp} with ${existing}. Apply order would be ambiguous.`,
      });
    } else {
      seen.set(timestamp, file.name);
    }
  }
  return violations;
}

/**
 * Detects edits to migrations that already exist in the baseline revision, and new
 * migrations inserted *before* an existing one.
 */
function validateAppendOnly(base: MigrationFile[], current: MigrationFile[]): MigrationViolation[] {
  const violations: MigrationViolation[] = [];
  const currentByName = new Map(current.map((f) => [f.name, f]));

  for (const committed of base) {
    const live = currentByName.get(committed.name);

    if (live === undefined) {
      violations.push({
        rule: "migration-deleted",
        file: committed.name,
        message:
          "This migration exists in the base revision but not here. Deployed migrations " +
          "are never deleted — correct it with a new forward migration (architecture §8).",
      });
      continue;
    }

    if (live.content !== committed.content) {
      violations.push({
        rule: "migration-modified",
        file: committed.name,
        message:
          "This migration was modified after being committed. Databases that already " +
          "applied it would silently diverge. Write a new forward migration instead.",
      });
    }
  }

  // A new migration must sort after every committed one; otherwise it would be
  // skipped on databases that are already ahead of it.
  const highestCommitted = sortMigrations(base).at(-1)?.name;
  if (highestCommitted !== undefined) {
    const baseNames = new Set(base.map((f) => f.name));
    for (const file of current) {
      if (baseNames.has(file.name)) continue;
      if (parseTimestamp(file.name) === null) continue; // already reported
      if (file.name.localeCompare(highestCommitted) <= 0) {
        violations.push({
          rule: "migration-inserted-out-of-order",
          file: file.name,
          message:
            `Sorts before the latest committed migration (${highestCommitted}). ` +
            "Databases already past this point would never apply it. Use a later timestamp.",
        });
      }
    }
  }

  return violations;
}

const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi;

/**
 * A new table must ship with RLS in the same migration.
 *
 * "New tables ship with RLS and policies in the same migration; a table without RLS
 * reaching production is a security incident, not a bug" (deployment skill;
 * `release-manager` lists it as blocking). This is the "security tests for changed
 * policies" gate from architecture §19 applied at the migration level.
 *
 * Applies to NEW migrations only. A migration already in the baseline cannot be
 * edited without violating append-only, so re-reporting it would leave the gate
 * permanently red with no legal remedy. Pre-existing gaps are corrected by a new
 * forward migration instead.
 */
function validateTablePolicies(files: MigrationFile[]): MigrationViolation[] {
  const violations: MigrationViolation[] = [];

  for (const file of files) {
    // Strip line comments so commented-out SQL is not treated as real statements.
    const sql = file.content.replace(/--[^\n]*/g, (m) => (DENY_ALL_MARKER.test(m) ? m : ""));
    const declaresDenyAll = DENY_ALL_MARKER.test(file.content);

    for (const match of file.content.matchAll(CREATE_TABLE)) {
      const table = match[1];
      if (table === undefined) continue;

      const rlsEnabled = new RegExp(
        `alter\\s+table\\s+(?:public\\.)?"?${table}"?\\s+enable\\s+row\\s+level\\s+security`,
        "i",
      ).test(sql);

      if (!rlsEnabled) {
        violations.push({
          rule: "table-without-rls",
          file: file.name,
          message: `Table "${table}" is created without "enable row level security" in the same migration (security §7).`,
        });
        continue;
      }

      const hasPolicy = new RegExp(
        `create\\s+policy[\\s\\S]{0,400}?\\bon\\s+(?:public\\.)?"?${table}"?`,
        "i",
      ).test(sql);

      if (!hasPolicy && !declaresDenyAll) {
        violations.push({
          rule: "table-without-policies",
          file: file.name,
          message:
            `Table "${table}" enables RLS but defines no policy. Add the policies in this ` +
            `migration, or declare the deny-all intent with a "-- rls: deny-all" comment ` +
            `for internal tables (ADR-006).`,
        });
      }
    }
  }

  return violations;
}

export interface ValidateOptions {
  /** Migrations as committed in the base revision. Empty when there is no baseline. */
  base: MigrationFile[];
  /** Migrations in the working tree. */
  current: MigrationFile[];
  /**
   * When false, append-only comparison is skipped because no baseline was
   * available. The caller must surface this — a skipped check is not a pass.
   */
  baselineAvailable: boolean;
}

export function validateMigrations(options: ValidateOptions): MigrationViolation[] {
  const { base, current, baselineAvailable } = options;

  // Content rules apply to migrations that are new in this change. Without a
  // baseline every migration is treated as new (best effort, and reported as such).
  const baseNames = new Set(base.map((f) => f.name));
  const newMigrations = baselineAvailable ? current.filter((f) => !baseNames.has(f.name)) : current;

  return [
    ...validateFilenames(current),
    ...(baselineAvailable ? validateAppendOnly(base, current) : []),
    ...validateTablePolicies(newMigrations),
  ];
}
