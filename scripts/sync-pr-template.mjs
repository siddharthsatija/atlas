#!/usr/bin/env node
/**
 * The pull request template has one source of truth: .claude/pull-request-template.md
 * GitHub requires its own copy at .github/pull_request_template.md, so this script
 * mirrors it. CI runs `--check` so the two cannot drift.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SOURCE = ".claude/pull-request-template.md";
const TARGET = ".github/pull_request_template.md";
const BANNER = `<!-- GENERATED FILE — do not edit.
     Source of truth: ${SOURCE}
     Regenerate with: pnpm sync:pr-template -->\n\n`;

if (!existsSync(SOURCE)) {
  console.error(`missing source template: ${SOURCE}`);
  process.exit(1);
}

const expected = BANNER + readFileSync(SOURCE, "utf8");
const checkOnly = process.argv.includes("--check");
const actual = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : null;

if (checkOnly) {
  if (actual !== expected) {
    console.error(`${TARGET} is out of date. Run: pnpm sync:pr-template`);
    process.exit(1);
  }
  console.log("pull request template is in sync");
} else {
  writeFileSync(TARGET, expected);
  console.log(`wrote ${TARGET} from ${SOURCE}`);
}
