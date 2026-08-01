/**
 * Migration validation gate (ATL-004).
 *
 * Compares the migrations in the working tree against those in a base revision and
 * fails on any non-append-only change (architecture §8).
 *
 * Usage:
 *   pnpm db:validate-migrations                 # base defaults to origin/main
 *   pnpm db:validate-migrations --base main
 *
 * Exit codes: 0 pass · 1 violations found · 2 bad usage.
 *
 * When no git baseline is available (fresh repository, shallow clone without the
 * base ref) the append-only comparison cannot run. That is reported explicitly and
 * the remaining checks still run — a skipped check is never reported as a pass.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  sortMigrations,
  validateMigrations,
  type MigrationFile,
} from "./lib/migration-validation.ts";

const MIGRATIONS_DIR = "supabase/migrations";

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function readWorkingTreeMigrations(): MigrationFile[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return sortMigrations(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => ({ name, content: readFileSync(join(MIGRATIONS_DIR, name), "utf8") })),
  );
}

/** Reads the migration set as it exists in `ref`, or null when the ref is unavailable. */
function readBaseMigrations(ref: string): MigrationFile[] | null {
  if (git(["rev-parse", "--is-inside-work-tree"]) === null) return null;
  if (git(["rev-parse", "--verify", `${ref}^{commit}`]) === null) return null;

  const listing = git(["ls-tree", "--name-only", `${ref}`, `${MIGRATIONS_DIR}/`]);
  if (listing === null) return null;

  const files: MigrationFile[] = [];
  for (const path of listing.split("\n").filter((p) => p.endsWith(".sql"))) {
    const content = git(["show", `${ref}:${path}`]);
    if (content === null) continue;
    files.push({ name: path.slice(`${MIGRATIONS_DIR}/`.length), content });
  }
  return sortMigrations(files);
}

function parseBaseRef(argv: string[]): string {
  const index = argv.indexOf("--base");
  if (index === -1) return process.env.ATLAS_MIGRATION_BASE_REF ?? "origin/main";
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    process.stderr.write("\n  ✗ --base requires a git ref\n\n");
    process.exit(2);
  }
  return value;
}

function main(): void {
  const baseRef = parseBaseRef(process.argv.slice(2));
  const current = readWorkingTreeMigrations();

  process.stdout.write(`\nMigration validation — base ref: ${baseRef}\n\n`);

  const base = readBaseMigrations(baseRef);
  const baselineAvailable = base !== null;

  if (!baselineAvailable) {
    process.stdout.write(
      `  ! No git baseline for "${baseRef}" — append-only comparison SKIPPED.\n` +
        `    Filename and RLS checks still ran. In CI, fetch the base ref so this check is complete.\n\n`,
    );
  }

  const violations = validateMigrations({
    base: base ?? [],
    current,
    baselineAvailable,
  });

  if (violations.length > 0) {
    process.stderr.write(`  ✗ ${violations.length} migration violation(s):\n\n`);
    for (const violation of violations) {
      process.stderr.write(
        `      [${violation.rule}] ${violation.file}\n        ${violation.message}\n\n`,
      );
    }
    process.stderr.write(
      `    Migrations are append-only after shared deployment (architecture §8).\n\n`,
    );
    process.exit(1);
  }

  const summary =
    current.length === 0
      ? "no migrations yet — nothing to validate"
      : `${current.length} migration(s) validated`;
  process.stdout.write(`  ✓ ${summary}\n`);
  if (baselineAvailable) process.stdout.write(`  ✓ append-only comparison against ${baseRef}\n`);
  process.stdout.write("\n");
}

main();
