/**
 * Gate-blocking verification (ATL-004).
 *
 * The ticket requires proof that "a deliberately failing fixture demonstrates each
 * gate blocks". A gate that runs but never fails is indistinguishable from no gate
 * at all, and that is only discovered when something bad ships.
 *
 * For each gate this script introduces a deliberately broken fixture, runs the
 * gate, and asserts a NON-ZERO exit. Fixtures are always removed, including on
 * failure or interrupt, so the working tree is left exactly as it was found.
 *
 * Git history is deliberately not used: creating throwaway branches would mutate a
 * shared repository, and a temporary fixture proves the same property.
 *
 * Usage:
 *   pnpm gates:verify                 # every gate
 *   pnpm gates:verify --only lint,typecheck
 *   pnpm gates:verify --skip build    # build is the slowest gate
 *
 * Exit codes: 0 every gate blocked as expected · 1 a gate failed to block · 2 usage.
 */
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

interface Fixture {
  path: string;
  content: string;
}

interface Gate {
  /** Selector used by --only / --skip. */
  id: string;
  /** Gate name as listed in architecture §19. */
  gate: string;
  command: string;
  /** The defect this fixture introduces. */
  defect: string;
  fixture: Fixture;
}

/**
 * Every fixture path carries the `_gate-fixture` marker so a leaked file is
 * obvious and is caught by .gitignore.
 */
const GATES: Gate[] = [
  {
    id: "format",
    gate: "Formatting",
    command: "pnpm format:check",
    defect: "badly formatted source file",
    fixture: {
      path: "src/utils/_gate-fixture-format.ts",
      content: "export const messy   =    {a:1,b:2}\n",
    },
  },
  {
    id: "lint",
    gate: "Lint",
    command: "pnpm lint",
    defect: "explicit `any`, which @typescript-eslint/no-explicit-any forbids",
    fixture: {
      path: "src/utils/_gate-fixture-lint.ts",
      content: "const value: any = 1;\nexport default value;\n",
    },
  },
  {
    id: "typecheck",
    gate: "Type check",
    command: "pnpm typecheck",
    defect: "assigning a number to a string",
    fixture: {
      path: "src/utils/_gate-fixture-typecheck.ts",
      content: "export const label: string = 42;\n",
    },
  },
  {
    id: "test",
    gate: "Unit tests",
    command: "pnpm test",
    defect: "a failing assertion",
    fixture: {
      path: "src/utils/_gate-fixture.test.ts",
      content:
        'import { describe, expect, it } from "vitest";\n' +
        'describe("gate fixture", () => {\n' +
        '  it("fails on purpose", () => {\n' +
        "    expect(1).toBe(2);\n" +
        "  });\n" +
        "});\n",
    },
  },
  {
    id: "migrations",
    gate: "Migration validation",
    command: "pnpm db:validate-migrations",
    defect: "migration filename without a timestamp prefix, and a table with no RLS",
    fixture: {
      path: "supabase/migrations/_gate-fixture-bad-name.sql",
      content: "create table public.gate_fixture (id uuid primary key);\n",
    },
  },
  {
    id: "ci-policy",
    gate: "CI policy (no production secrets)",
    command: "pnpm ci:verify-policy",
    defect: "workflow referencing a production secret",
    fixture: {
      path: ".github/workflows/_gate-fixture.yml",
      content:
        "name: Gate fixture\non:\n  pull_request:\njobs:\n  leak:\n    runs-on: ubuntu-latest\n" +
        "    steps:\n      - run: echo ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}\n",
    },
  },
  {
    id: "build",
    gate: "Production build",
    command: "pnpm build",
    defect: "type error inside a route module",
    fixture: {
      path: "src/app/_gate-fixture/page.tsx",
      content:
        'export default function GateFixture() {\n  const n: number = "nope";\n  return <p>{n}</p>;\n}\n',
    },
  },
];

function parseList(argv: string[], flag: string): string[] | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    process.stderr.write(`\n  ✗ ${flag} requires a comma-separated list of gate ids\n\n`);
    process.exit(2);
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Runs a command, returning its exit code. Output is captured, not printed. */
function runQuietly(command: string): number {
  try {
    execSync(command, { stdio: "pipe", encoding: "utf8" });
    return 0;
  } catch (error) {
    const code = (error as { status?: number }).status;
    return typeof code === "number" ? code : 1;
  }
}

function writeFixture({ path, content }: Fixture): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function removeFixture({ path }: Fixture): void {
  rmSync(path, { force: true });
  // Remove the directory too when the fixture created an otherwise-empty one.
  const dir = dirname(path);
  if (dir.includes("_gate-fixture")) rmSync(dir, { recursive: true, force: true });
}

function main(): void {
  const argv = process.argv.slice(2);
  const only = parseList(argv, "--only");
  const skip = parseList(argv, "--skip") ?? [];

  const selected = GATES.filter(
    (g) => (only === null || only.includes(g.id)) && !skip.includes(g.id),
  );

  if (selected.length === 0) {
    process.stderr.write("\n  ✗ No gates selected\n\n");
    process.exit(2);
  }

  process.stdout.write(
    "\nGate-blocking verification — each gate must FAIL on a broken fixture\n\n",
  );

  const failures: string[] = [];

  for (const gate of selected) {
    // Never overwrite a real file.
    if (existsSync(gate.fixture.path)) {
      failures.push(`${gate.id}: fixture path ${gate.fixture.path} already exists`);
      continue;
    }

    let exitCode: number;
    try {
      writeFixture(gate.fixture);
      exitCode = runQuietly(gate.command);
    } finally {
      removeFixture(gate.fixture);
    }

    if (exitCode === 0) {
      failures.push(`${gate.gate}: "${gate.command}" PASSED despite ${gate.defect}`);
      process.stdout.write(`  ✗ ${gate.gate.padEnd(34)} did NOT block (${gate.defect})\n`);
    } else {
      process.stdout.write(
        `  ✓ ${gate.gate.padEnd(34)} blocked (exit ${exitCode}) — ${gate.defect}\n`,
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`\n  ✗ ${failures.length} gate(s) failed to block:\n`);
    for (const failure of failures) process.stderr.write(`      ${failure}\n`);
    process.stderr.write(
      "\n    A gate that cannot fail provides no protection (architecture §19).\n\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    `\n  All ${selected.length} verified gate(s) block on a deliberate defect.\n\n`,
  );
}

main();
