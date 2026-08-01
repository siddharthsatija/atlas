/**
 * CI policy gate (ATL-004).
 *
 * Asserts two acceptance criteria against the workflow files themselves:
 *   - CI has no access to production secrets
 *   - every architecture §19 gate runs on pull requests, so it can block a merge
 *
 * Exit codes: 0 pass · 1 violations found.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateCiPolicy, type WorkflowFile } from "./lib/ci-policy.ts";

const WORKFLOWS_DIR = ".github/workflows";

function readWorkflows(): WorkflowFile[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({
      file: join(WORKFLOWS_DIR, name),
      content: readFileSync(join(WORKFLOWS_DIR, name), "utf8"),
    }));
}

function main(): void {
  process.stdout.write("\nCI policy check\n\n");

  const workflows = readWorkflows();
  if (workflows.length === 0) {
    process.stderr.write(`  ✗ No workflows found in ${WORKFLOWS_DIR}\n\n`);
    process.exit(1);
  }

  const violations = validateCiPolicy(workflows);
  if (violations.length > 0) {
    process.stderr.write(`  ✗ ${violations.length} CI policy violation(s):\n\n`);
    for (const violation of violations) {
      process.stderr.write(
        `      [${violation.rule}] ${violation.file}\n        ${violation.message}\n\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(`  ✓ ${workflows.length} workflow(s) reference no production secrets\n`);
  process.stdout.write("  ✓ every architecture §19 gate runs on pull requests\n\n");
}

main();
