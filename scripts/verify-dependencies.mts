/**
 * Dependency audit gate (ATL-090).
 *
 * Runs `pnpm audit --json` and applies the policy in
 * `scripts/lib/dependency-policy.ts`: high and critical advisories block a merge
 * unless covered by a documented, time-boxed exception.
 *
 * Usage:
 *   pnpm deps:verify
 *   pnpm deps:verify --report audit-report.json   # also write the raw report
 *
 * Exit codes: 0 pass · 1 policy violations · 2 audit could not run.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  evaluateDependencyPolicy,
  parseAuditReport,
  type DependencyException,
} from "./lib/dependency-policy.ts";

/**
 * Overridable so `pnpm gates:verify` can prove the policy blocks on a malformed
 * exceptions file without mutating the real one.
 */
const EXCEPTIONS_FILE =
  process.env.ATLAS_DEPENDENCY_EXCEPTIONS ?? ".github/dependency-exceptions.json";

/** `pnpm audit` exits non-zero when advisories exist, so stdout is captured either way. */
function runAudit(): unknown {
  let stdout = "";
  try {
    stdout = execSync("pnpm audit --json", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
  }

  if (stdout.trim() === "") {
    process.stderr.write(
      "\n  ✗ `pnpm audit` produced no output. The registry may be unreachable.\n" +
        "    A dependency scan that cannot run must not be reported as a pass.\n\n",
    );
    process.exit(2);
  }

  try {
    return JSON.parse(stdout);
  } catch {
    process.stderr.write("\n  ✗ Could not parse `pnpm audit --json` output.\n\n");
    process.exit(2);
  }
}

function readExceptions(): DependencyException[] {
  if (!existsSync(EXCEPTIONS_FILE)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(EXCEPTIONS_FILE, "utf8"));
    const list = (parsed as { exceptions?: unknown }).exceptions;
    return Array.isArray(list) ? (list as DependencyException[]) : [];
  } catch {
    process.stderr.write(`\n  ✗ ${EXCEPTIONS_FILE} is not valid JSON.\n\n`);
    process.exit(2);
  }
}

function main(): void {
  process.stdout.write("\nDependency audit\n\n");

  const raw = runAudit();
  const advisories = parseAuditReport(raw);
  const exceptions = readExceptions();

  const reportIndex = process.argv.indexOf("--report");
  if (reportIndex !== -1) {
    const path = process.argv[reportIndex + 1];
    if (path !== undefined && !path.startsWith("--")) {
      writeFileSync(path, JSON.stringify(raw, null, 2));
      process.stdout.write(`  · report written to ${path}\n`);
    }
  }

  const violations = evaluateDependencyPolicy({ advisories, exceptions, now: new Date() });

  const counts = advisories.reduce<Record<string, number>>((acc, a) => {
    acc[a.severity] = (acc[a.severity] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([severity, n]) => `${n} ${severity}`)
    .join(", ");
  process.stdout.write(
    `  · ${advisories.length} advisory(ies) reported${summary ? `: ${summary}` : ""}\n`,
  );
  process.stdout.write(`  · ${exceptions.length} documented exception(s)\n\n`);

  if (violations.length > 0) {
    process.stderr.write(`  ✗ ${violations.length} dependency policy violation(s):\n\n`);
    for (const violation of violations) {
      process.stderr.write(
        `      [${violation.rule}] ${violation.id}\n        ${violation.message}\n\n`,
      );
    }
    process.stderr.write("    Remediation runbook: .github/SECURITY.md\n\n");
    process.exit(1);
  }

  process.stdout.write("  ✓ no blocking advisories\n\n");
}

main();
