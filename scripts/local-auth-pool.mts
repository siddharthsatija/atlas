/**
 * Local GoTrue connection-pool fix (#132).
 *
 * Recreates the local Supabase auth container with a bounded, reusing
 * GoTrue → Postgres connection pool. See `scripts/lib/auth-pool-config.ts` for
 * the failure mechanism and the rationale behind the chosen values.
 *
 * This exists because the Supabase CLI (2.110.0) has no `config.toml` key for
 * GoTrue's database pool, and Docker cannot change environment variables on a
 * running container. `supabase start` recreates the container from the CLI's own
 * spec, so this must be re-run after every stack start.
 *
 * Usage:
 *   pnpm db:auth-pool            # apply (idempotent — no-op when already set)
 *   pnpm db:auth-pool --check    # report only; never mutates anything
 *
 * Scope: LOCAL ONLY. It refuses to run unless `ATLAS_ENV` is unset or `local`,
 * and it only ever touches `supabase_auth_<project_id>` read from
 * `supabase/config.toml`. It changes no Atlas application code, adds no retries,
 * and alters no authentication behaviour — only the size of GoTrue's own
 * database connection pool.
 *
 * Exit codes: 0 applied or already correct · 1 failure or post-recreate drift ·
 * 2 bad usage or wrong environment.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  AUTH_POOL_ENV,
  authContainerName,
  buildRunArgs,
  compareSpecs,
  containerName,
  healthcheckFormChanged,
  isPoolConfigured,
  mergePoolEnv,
  networkNames,
  parseEnvList,
  parseProjectId,
  type ContainerSpec,
} from "./lib/auth-pool-config.ts";

const CONFIG_PATH = "supabase/config.toml";

const ok = (message: string) => process.stdout.write(`  ✓ ${message}\n`);
const info = (message: string) => process.stdout.write(`    ${message}\n`);

function fail(code: number, message: string): never {
  process.stderr.write(`\n  ✗ ${message}\n\n`);
  process.exit(code);
}

/**
 * Only the fields that must survive the recreate. Unknown keys are stripped:
 * this is a spec for what we reproduce, not a mirror of the Docker API.
 */
const containerSchema = z.object({
  Name: z.string(),
  Config: z.object({
    Image: z.string(),
    Env: z.array(z.string()).optional(),
    Cmd: z
      .array(z.string())
      .nullish()
      .transform((v) => v ?? undefined),
    Entrypoint: z
      .array(z.string())
      .nullish()
      .transform((v) => v ?? undefined),
    Labels: z
      .record(z.string(), z.string())
      .nullish()
      .transform((v) => v ?? undefined),
    User: z.string().optional(),
    WorkingDir: z.string().optional(),
    Healthcheck: z
      .object({
        Test: z.array(z.string()).optional(),
        Interval: z.number().optional(),
        Timeout: z.number().optional(),
        StartPeriod: z.number().optional(),
        Retries: z.number().optional(),
      })
      .optional(),
  }),
  HostConfig: z.object({
    Binds: z
      .array(z.string())
      .nullish()
      .transform((v) => v ?? undefined),
    PortBindings: z
      .record(
        z.string(),
        z.array(z.object({ HostIp: z.string().optional(), HostPort: z.string().optional() })),
      )
      .nullish()
      .transform((v) => v ?? undefined),
    RestartPolicy: z.object({ Name: z.string().optional() }).optional(),
  }),
  NetworkSettings: z.object({
    Networks: z
      .record(
        z.string(),
        z.object({
          Aliases: z
            .array(z.string())
            .nullish()
            .transform((v) => v ?? undefined),
        }),
      )
      .nullish()
      .transform((v) => v ?? undefined),
  }),
});

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function inspect(name: string): ContainerSpec {
  let raw: string;
  try {
    raw = docker(["container", "inspect", name]);
  } catch {
    return fail(1, `Container ${name} not found. Start the local stack first: pnpm db:start`);
  }

  const parsed = z.array(containerSchema).min(1).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return fail(1, `Unexpected \`docker container inspect\` shape: ${parsed.error.message}`);
  }
  const [container] = parsed.data;
  if (container === undefined) return fail(1, `Container ${name} returned no inspect data.`);
  return container;
}

function reportPool(spec: ContainerSpec): void {
  const env = parseEnvList(spec.Config.Env ?? []);
  for (const key of Object.keys(AUTH_POOL_ENV)) {
    info(`${key}=${env.get(key) ?? "(unset — GoTrue treats this as 0)"}`);
  }
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
for (const argument of args) {
  if (argument !== "--check") fail(2, `Unknown option: ${argument}`);
}

const environment = process.env.ATLAS_ENV;
if (environment !== undefined && environment !== "local") {
  fail(2, `Refusing to run: ATLAS_ENV is "${environment}". This script is local-only.`);
}

const projectId = parseProjectId(readFileSync(CONFIG_PATH, "utf8"));
if (projectId === null) fail(1, `No project_id found in ${CONFIG_PATH}.`);

const name = authContainerName(projectId);
const before = inspect(name);

process.stdout.write(`\n  GoTrue database pool — ${name}\n\n`);
info("current:");
reportPool(before);

if (isPoolConfigured(before.Config.Env ?? [])) {
  ok("Pool already bounded and reusing connections. Nothing to do.");
  process.exit(0);
}

if (checkOnly) {
  fail(1, "Pool is NOT configured. Run `pnpm db:auth-pool` after every `supabase start`.");
}

const env = mergePoolEnv(before.Config.Env ?? []);
const runArgs = buildRunArgs(before, env);
const secondaryNetworks = networkNames(before).slice(1);

process.stdout.write("\n");
info(`recreating ${containerName(before)} from its own inspected spec…`);

try {
  docker(["rm", "--force", name]);
  docker(runArgs);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  fail(1, `Recreate failed: ${reason}\n    Recover with: pnpm db:stop && pnpm db:start`);
}

for (const network of secondaryNetworks) {
  const aliases = before.NetworkSettings.Networks?.[network]?.Aliases ?? [];
  const connectArgs = ["network", "connect"];
  for (const alias of aliases) connectArgs.push("--alias", alias);
  connectArgs.push(network, name);
  try {
    docker(connectArgs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(1, `Failed to reconnect network ${network}: ${reason}`);
  }
}

const after = inspect(name);
const drift = compareSpecs(before, after);

process.stdout.write("\n");
info("applied:");
reportPool(after);
process.stdout.write("\n");

if (healthcheckFormChanged(before, after)) {
  info("note: healthcheck re-declared as CMD-SHELL (docker run only accepts a shell");
  info("      string). The probe runs the same program.");
}

if (drift.length > 0) {
  process.stderr.write("\n  ✗ Container spec drifted during recreate:\n");
  for (const entry of drift) process.stderr.write(`      - ${entry}\n`);
  process.stderr.write("\n    Restore a clean container with: pnpm db:stop && pnpm db:start\n\n");
  process.exit(1);
}

if (!isPoolConfigured(after.Config.Env ?? [])) {
  fail(1, "Recreate succeeded but the pool variables are not present. Not reporting a pass.");
}

ok("Pool bounded and reusing connections; container spec otherwise unchanged.");
info("Re-run this after every `supabase start` — the CLI recreates the container.");
process.stdout.write("\n");
