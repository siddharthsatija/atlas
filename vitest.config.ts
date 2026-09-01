import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * Three projects, split by **what each needs to run**, not by what it is called.
 *
 *   unit     — jsdom. Pure functions, schemas, components. No database.
 *   server   — node. Modules marked `server-only`, exercised against test
 *              doubles. No database.
 *   database — node. RLS and authorization against a real Postgres. Requires
 *              `pnpm db:start`, and runs serially against shared state.
 *
 * The `server` project was previously merged into `integration`, which conflated
 * "runs in node" with "needs a database". That conflation is what made the CI
 * unit job — which runs every project by default — try to open a database
 * connection and fail. Most node-environment tests here mock their client and
 * need no Postgres at all; only `tests/integration/**` genuinely does.
 *
 * Splitting them means the fast, no-infrastructure gate can cover both `unit`
 * and `server` — preserving the coverage denominator — while the database suite
 * stays behind the job that actually starts Postgres.
 *
 * End-to-end and accessibility journeys run in Playwright, not here.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    globals: true,
    css: false,
    setupFiles: ["./src/test/setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          // CI tooling in scripts/lib is unit-tested here too: the migration
          // validator guards an irreversible repository invariant (ATL-004).
          include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        /**
         * Resolve `server-only` the way a Server Component does.
         *
         * That package deliberately throws on import under every export condition
         * except `react-server` — it is how a server module is prevented from being
         * pulled into a client bundle. Integration tests exercise server code
         * (`env.ts`, route handlers) in Node, where the throwing variant resolves
         * and the suite dies on import.
         *
         * `resolve.conditions` alone does not fix it: node_modules are externalised
         * and resolved by Node, not Vite. The alias therefore points at the
         * package's own `empty.js` — the exact module the `react-server` condition
         * selects — by absolute path, because that subpath is not listed in the
         * package's `exports` map and cannot be requested by specifier.
         *
         * Scoped to the node projects. The unit project keeps the real guard, so
         * an accidental client import of a server module still fails there.
         */
        resolve: {
          alias: {
            "server-only": fileURLToPath(
              new URL("./node_modules/server-only/empty.js", import.meta.url),
            ),
          },
          conditions: ["react-server", "node"],
        },
        test: {
          name: "server",
          environment: "node",
          // Server modules against test doubles. No database, so these run in
          // the same fast gate as the unit project.
          include: ["src/**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        // Same server-only resolution as above: these also load server modules.
        resolve: {
          alias: {
            "server-only": fileURLToPath(
              new URL("./node_modules/server-only/empty.js", import.meta.url),
            ),
          },
          conditions: ["react-server", "node"],
        },
        test: {
          name: "database",
          environment: "node",
          // The only suites that require Postgres. They create real users and
          // assert RLS, so they must not run without `pnpm db:start`.
          include: ["tests/integration/**/*.test.ts"],
          // Shared database state: never run these in parallel.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      /**
       * Coverage is measured over LOGIC, where the percentage is meaningful.
       *
       * Presentational primitives (`src/components`), framework glue (`src/app`),
       * and providers are verified by behavior, accessibility, and type checks —
       * see .claude/skills/testing/SKILL.md, which makes risk-tiered expectations
       * the standard and treats a global percentage as "a smoke alarm, not a goal".
       *
       * The layers that carry the rules Atlas depends on — score calculation,
       * findings rules, the request state machine, crypto, redaction (M3/M6) —
       * all land in `src/server`, `src/lib`, and `src/config`, so they are held to
       * the full threshold from the moment they exist.
       */
      include: [
        "src/lib/**/*.{ts,tsx}",
        "src/config/**/*.{ts,tsx}",
        "src/server/**/*.{ts,tsx}",
        "src/utils/**/*.{ts,tsx}",
      ],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        // Declaration-only modules: no branches to exercise.
        // env.ts is a server-only loader whose logic lives in (and is tested via)
        // env.schema.ts; app.ts is a constants module.
        "src/config/env.ts",
        "src/config/app.ts",
        // Repository/database adapter implementations are exercised by the
        // `database` integration project against a real Supabase/Postgres
        // instance with real RLS policies (pnpm test:integration). Their
        // Supabase query-builder branches are only meaningful when executed
        // against a live database, so including them in the unit+server
        // coverage denominator produces a permanently-inflated uncovered
        // branch count that no unit or server test can close. Repository
        // correctness is enforced by pnpm test:integration; the fast gate
        // here measures the logic layers that can be meaningfully covered
        // without database infrastructure.
        "src/server/repositories/**",
      ],
      /**
       * A floor, not a goal. Risk-tiered expectations in
       * .claude/skills/testing/SKILL.md govern: score calculation, findings rules,
       * the request state machine, crypto, and redaction are expected to be
       * exhaustively covered regardless of this number.
       */
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
