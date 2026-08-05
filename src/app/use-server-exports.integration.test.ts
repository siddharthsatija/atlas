import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every `"use server"` module may export **only** async functions.
 *
 * Next.js turns each export of such a module into a callable server reference.
 * A non-function export cannot be one, so evaluating the module throws:
 *
 *     A "use server" file can only export async functions, found object.
 *
 * ## Why this file exists
 *
 * This rule is invisible to every check Atlas runs before a build. `tsc` sees a
 * valid module. ESLint has no rule for it. Vitest imports the file directly, so
 * the constant resolves and the tests pass. It fails only when the *built*
 * server evaluates the module — at which point the failure is not a compile
 * error but a request-time throw, caught by the global error boundary.
 *
 * That is exactly how it reached us: `INITIAL_MAGIC_LINK_STATE` was exported
 * from `(auth)/sign-in/actions.ts`, and the first sign-in submission in the E2E
 * run rendered "This page could not be displayed". The error surfaced far from
 * its cause and looked like an application bug, so triage chased the rate-limit
 * outage logs that happened to sit beside it in the log stream.
 *
 * A static scan is the right shape here: it costs nothing, it needs no build,
 * and it names the offending file instead of a hashed chunk offset.
 */

const APP_DIR = join(process.cwd(), "src", "app");

/** Runtime value exports — the ones that must all be async functions. */
const VALUE_EXPORT = /^export\s+(?:async\s+function|function|const|let|var|class|enum)\b.*$/gm;

/** `export async function foo` — the only permitted form. */
const ASYNC_FUNCTION = /^export\s+async\s+function\s/;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : [];
    }),
  );
  return files.flat();
}

/** Files whose *first* statement is the `"use server"` directive. */
async function serverActionFiles(): Promise<string[]> {
  const files = await walk(APP_DIR);
  return files.filter((file) => /^\s*["']use server["'];/.test(readFileSync(file, "utf8")));
}

describe('"use server" modules', () => {
  it("exist, so this suite is actually checking something", async () => {
    // Without this, a refactor that renamed or moved every action file would
    // leave the suite passing over an empty set.
    expect((await serverActionFiles()).length).toBeGreaterThan(0);
  });

  it("export only async functions", async () => {
    const files = await serverActionFiles();

    const offenders = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return (source.match(VALUE_EXPORT) ?? [])
        .filter((line) => !ASYNC_FUNCTION.test(line))
        .map((line) => `${file.replace(process.cwd(), ".")}: ${line.trim()}`);
    });

    /**
     * Shared state objects and types belong in a sibling `form-state.ts`, which
     * a client component and a Server Action can both import.
     */
    expect(offenders).toEqual([]);
  });
});
