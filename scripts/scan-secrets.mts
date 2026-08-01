/**
 * Secret scanning gate (ATL-090).
 *
 * Scans tracked files for credentials. Findings are reported with file, line, and a
 * REDACTED excerpt — the scanner never reproduces a secret in its own output, which
 * would simply move the exposure into CI logs (security §9).
 *
 * Usage:
 *   pnpm scan:secrets              # tracked files in the working tree
 *   pnpm scan:secrets --all        # every file, including untracked
 *
 * Exit codes: 0 clean · 1 findings.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import { scanFiles, type ScanTarget } from "./lib/secret-scan.ts";

const SKIP_DIRS = ["node_modules/", ".next/", "coverage/", "playwright-report/", ".git/"];
const MAX_BYTES = 512 * 1024;

function listTrackedFiles(all: boolean): string[] {
  try {
    const args = all
      ? ["ls-files", "--cached", "--others", "--exclude-standard"]
      : ["ls-files", "--cached", "--others", "--exclude-standard"];
    const out = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean);
  } catch {
    // No git repository: fall back to a directory walk.
    const out = execFileSync(
      "find",
      [".", "-type", "f", "-not", "-path", "./node_modules/*", "-not", "-path", "./.git/*"],
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(/^\.\//, ""));
  }
}

function readTargets(paths: string[]): ScanTarget[] {
  const targets: ScanTarget[] = [];

  for (const file of paths) {
    if (SKIP_DIRS.some((dir) => file.startsWith(dir) || file.includes(`/${dir}`))) continue;
    if (!existsSync(file)) continue;

    try {
      if (statSync(file).size > MAX_BYTES) continue; // lockfiles and binaries
      targets.push({ file, content: readFileSync(file, "utf8") });
    } catch {
      continue; // unreadable or binary
    }
  }
  return targets;
}

function main(): void {
  const all = process.argv.includes("--all");
  process.stdout.write("\nSecret scan\n\n");

  const targets = readTargets(listTrackedFiles(all));
  const findings = scanFiles(targets);

  if (findings.length > 0) {
    process.stderr.write(`  ✗ ${findings.length} potential secret(s) found:\n\n`);
    for (const finding of findings) {
      process.stderr.write(
        `      [${finding.severity}] ${finding.rule}\n` +
          `        ${finding.file}:${finding.line} — ${finding.description}\n` +
          `        ${finding.excerpt}\n\n`,
      );
    }
    process.stderr.write(
      "    Any exposed credential is rotated immediately (security §9).\n" +
        "    Remediation runbook: .github/SECURITY.md\n" +
        "    A verified false positive can be suppressed with an `atlas-scan-ignore` comment.\n\n",
    );
    process.exit(1);
  }

  process.stdout.write(`  ✓ ${targets.length} file(s) scanned, no secrets detected\n\n`);
}

main();
