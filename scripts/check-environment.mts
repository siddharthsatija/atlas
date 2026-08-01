/**
 * Environment smoke check (ATL-003).
 *
 * Verifies that the environment currently in scope is completely configured,
 * internally consistent, isolated from every other environment, and actually
 * reachable with its own credentials.
 *
 * Usage:
 *   pnpm env:check                       # uses ATLAS_ENV, loads .env.local if present
 *   pnpm env:check --env staging         # values must already be in the shell/CI
 *   pnpm env:check --skip-connectivity   # offline: configuration checks only
 *   pnpm env:check --require local       # fails unless ATLAS_ENV is `local`
 *
 * Guarantees:
 *   - Validation reuses the application's own Zod schema and isolation rules. There
 *     is no second copy of either (`src/config/env.schema.ts`,
 *     `src/config/environment-isolation.ts`).
 *   - No secret value is ever printed. Output names variables only (security §9).
 *
 * Exit codes: 0 pass · 1 configuration or connectivity failure · 2 bad usage.
 */
import { buildServerEnv, type ServerEnv } from "../src/config/env.schema.ts";
import { findIsolationViolations } from "../src/config/environment-isolation.ts";

const ENVIRONMENTS = ["local", "preview", "staging", "production"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

interface Options {
  env: string | undefined;
  require: string | undefined;
  skipConnectivity: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { env: undefined, require: undefined, skipConnectivity: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-connectivity") {
      options.skipConnectivity = true;
    } else if (arg === "--env" || arg === "--require") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(2, `${arg} requires a value (${ENVIRONMENTS.join(" | ")})`);
      }
      if (arg === "--env") options.env = value;
      else options.require = value;
      i += 1;
    } else if (arg !== undefined && arg.startsWith("--")) {
      fail(2, `Unknown option: ${arg}`);
    }
  }
  return options;
}

function fail(code: number, message: string): never {
  process.stderr.write(`\n  ✗ ${message}\n\n`);
  process.exit(code);
}

const ok = (message: string) => process.stdout.write(`  ✓ ${message}\n`);
const info = (message: string) => process.stdout.write(`    ${message}\n`);

/** Reachability probe. Uses the anon key only — never the service-role key. */
async function checkConnectivity(env: ServerEnv): Promise<{ ok: boolean; detail: string }> {
  const target = new URL("/auth/v1/health", env.NEXT_PUBLIC_SUPABASE_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(target, {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      signal: controller.signal,
    });
    return response.ok
      ? { ok: true, detail: `HTTP ${response.status} from ${target.host}` }
      : { ok: false, detail: `HTTP ${response.status} from ${target.host}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `${target.host} unreachable (${reason})` };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // `--env` selects which environment we are asserting about. It overrides
  // ATLAS_ENV so CI can check a target explicitly.
  if (options.env !== undefined) {
    if (!ENVIRONMENTS.includes(options.env as Environment)) {
      fail(2, `--env must be one of ${ENVIRONMENTS.join(", ")}`);
    }
    process.env.ATLAS_ENV = options.env;
  }

  const target = process.env.ATLAS_ENV ?? "local";
  process.stdout.write(`\nAtlas environment check — ATLAS_ENV=${target}\n\n`);

  // --- 1. Required variables present and well-formed ----------------------
  let env: ServerEnv;
  try {
    env = buildServerEnv(process.env);
    ok(`configuration valid (${Object.keys(env).length} variables)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(1, `Configuration invalid.\n${message}`);
  }

  // --- 2. Guard: caller demanded a specific environment --------------------
  if (options.require !== undefined && env.ATLAS_ENV !== options.require) {
    fail(
      1,
      `This command requires ATLAS_ENV=${options.require} but the environment is ` +
        `${env.ATLAS_ENV}. Refusing to continue (architecture §18).`,
    );
  }
  if (options.require !== undefined) ok(`environment is ${options.require} as required`);

  // --- 3. Isolation rules --------------------------------------------------
  const violations = findIsolationViolations(env);
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `      [${v.rule}] ${v.variables.join(", ")}\n        ${v.message}`)
      .join("\n");
    fail(1, `Environment isolation failed:\n${detail}`);
  }
  ok("environment isolation rules pass");

  // --- 4. Connectivity with this environment's own credentials -------------
  if (options.skipConnectivity) {
    info("connectivity skipped (--skip-connectivity)");
  } else {
    const result = await checkConnectivity(env);
    if (!result.ok) {
      fail(
        1,
        `Supabase not reachable with this environment's credentials: ${result.detail}\n` +
          `    For local, start the stack first: pnpm db:start`,
      );
    }
    ok(`Supabase reachable — ${result.detail}`);
  }

  process.stdout.write(`\n  Environment "${env.ATLAS_ENV}" is correctly configured.\n\n`);
}

await main();
