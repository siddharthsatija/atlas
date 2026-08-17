/**
 * Prompt immutability gate (ATL-051).
 *
 * Published prompt versions are append-only: changing a prompt requires a
 * version bump. This compares `src/server/ai/prompts/versions/` against a
 * committed baseline and fails on any modification or deletion.
 *
 * Usage:
 *   pnpm prompts:verify                 # base defaults to origin/main
 *   pnpm prompts:verify --base main
 *
 * Exit codes: 0 pass · 1 violations found · 2 bad usage.
 *
 * When no git baseline is available (fresh repository, shallow clone without the
 * base ref) the append-only comparison cannot run. That is reported explicitly
 * and the filename checks still run — a skipped check is never reported as a
 * pass, which is the same contract `validate-migrations.mts` keeps.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sortPrompts, validatePrompts, type PromptFile } from "./lib/prompt-validation.ts";

const VERSIONS_DIR = "src/server/ai/prompts/versions";

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function readWorkingTreePrompts(): PromptFile[] {
  if (!existsSync(VERSIONS_DIR)) return [];
  return sortPrompts(
    readdirSync(VERSIONS_DIR)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ name, content: readFileSync(join(VERSIONS_DIR, name), "utf8") })),
  );
}

/** Reads the prompt set as it exists in `ref`, or null when the ref is unavailable. */
function readBasePrompts(ref: string): PromptFile[] | null {
  if (git(["rev-parse", "--is-inside-work-tree"]) === null) return null;
  if (git(["rev-parse", "--verify", `${ref}^{commit}`]) === null) return null;

  const listing = git(["ls-tree", "--name-only", "-r", ref, `${VERSIONS_DIR}/`]);
  if (listing === null) return null;

  const files: PromptFile[] = [];
  for (const path of listing.split("\n").filter((entry) => entry.endsWith(".ts"))) {
    const content = git(["show", `${ref}:${path}`]);
    if (content === null) continue;
    files.push({ name: path.slice(`${VERSIONS_DIR}/`.length), content });
  }
  return sortPrompts(files);
}

function parseBaseRef(argv: string[]): string {
  const index = argv.indexOf("--base");
  if (index === -1) return process.env.ATLAS_PROMPT_BASE_REF ?? "origin/main";
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    process.stderr.write("\n  ✗ --base requires a git ref\n\n");
    process.exit(2);
  }
  return value;
}

function main(): void {
  const baseRef = parseBaseRef(process.argv.slice(2));
  const current = readWorkingTreePrompts();

  process.stdout.write(`\nPrompt validation — base ref: ${baseRef}\n\n`);

  const baseline = readBasePrompts(baseRef);

  const { violations, appendOnlySkipped } = validatePrompts({ current, baseline });

  if (appendOnlySkipped) {
    process.stdout.write(
      `  ! No git baseline for "${baseRef}" — append-only comparison SKIPPED.\n` +
        `    Filename checks still ran. In CI, fetch the base ref so this check is complete.\n\n`,
    );
  }

  if (violations.length > 0) {
    process.stderr.write(`  ✗ ${violations.length} prompt violation(s):\n\n`);
    for (const violation of violations) {
      process.stderr.write(
        `      [${violation.rule}] ${violation.file}\n        ${violation.message}\n\n`,
      );
    }
    process.stderr.write(
      `    Published prompt versions are append-only. Changing a prompt means adding\n` +
        `    the next slug-vN.ts and pointing the registry at it (ATL-051).\n\n`,
    );
    process.exit(1);
  }

  const summary =
    current.length === 0
      ? "  ✓ no prompt versions to validate\n\n"
      : `  ✓ ${current.length} prompt version file(s) validated\n\n`;
  process.stdout.write(summary);
}

main();
