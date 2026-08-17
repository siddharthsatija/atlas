/**
 * GoTrue → Postgres connection pool configuration for the LOCAL stack (#132).
 *
 * Pure logic only. All Docker I/O lives in `scripts/local-auth-pool.mts`, so the
 * argument construction and the drift comparison below are unit-testable without
 * a running daemon.
 *
 * ## Why this exists
 *
 * The Supabase CLI (2.110.0) config surface has no key for GoTrue's database
 * pool. Every supported `auth.*` key is documented at
 * https://supabase.com/docs/guides/local-development/cli/config and none of them
 * reach `GOTRUE_DB_*`. The only pool-shaped keys in the schema are `db.pooler.*`,
 * which configure the Supavisor listener used by *external* clients; GoTrue does
 * not go through it and connects to Postgres directly.
 *
 * With those variables unset, GoTrue's `internal/storage.ApplyConfig` still runs
 * and applies them unconditionally, so the container reports:
 *
 *     limit_max_open_conns=0   limit_max_idle_conns=0   limit_conn_max_lifetime=0s
 *
 * `database/sql` reads `MaxIdleConns=0` as "retain no idle connections", so every
 * connection is closed the moment its query completes, and `MaxOpenConns=0` means
 * there is no ceiling and no queueing to push back against the churn. Each close
 * leaves a socket in TIME_WAIT for 60s (2×MSL) against a single fixed destination
 * — the auth container's own network namespace only varies the source port, so
 * the ~28k ephemeral range drains and `connect(2)` returns EADDRNOTAVAIL:
 *
 *     failed to connect to host=supabase_db_...: dial tcp 172.19.0.2:5432:
 *     connect: cannot assign requested address
 *
 * which surfaces to Atlas as HTTP 500 from `/auth/v1/user` and therefore as
 * `AuthProviderUnavailableError`.
 *
 * Docker cannot change environment variables on a running container, so the fix
 * is applied by recreating the auth container from its own inspected spec.
 */

/**
 * Pool values applied to the local auth container.
 *
 * Budget against the local Postgres ceiling of `max_connections = 100`:
 *
 *   GoTrue 10 + PostgREST 10 + Storage 10 + Realtime 10 + pg-meta/Studio ~5 +
 *   CLI/psql ~5 = ~50, plus 3 reserved for superusers. Roughly 47 spare.
 *
 * GoTrue alone can therefore never claim more than 10% of the ceiling, where
 * today it is uncapped.
 *
 * - `MAX_POOL_SIZE=10` replaces "unlimited". Beyond the cap, `database/sql`
 *   *queues* callers instead of opening another socket. That backpressure is the
 *   property currently missing.
 * - `MAX_IDLE_POOL_SIZE=10` is the load-bearing value and is deliberately equal
 *   to the max: a released connection is then always returned to the pool rather
 *   than closed. Any smaller value reintroduces close-on-release precisely during
 *   the concurrency bursts that caused the failure.
 * - `CONN_MAX_LIFETIME=30m` still recycles connections so none lives forever,
 *   but at ~10 closes per half hour instead of one per request.
 * - `CONN_MAX_IDLE_TIME=5m` releases the pool between runs.
 *
 * A full E2E run goes from thousands of 60-second TIME_WAIT sockets to ~10.
 */
export const AUTH_POOL_ENV: Readonly<Record<string, string>> = Object.freeze({
  GOTRUE_DB_MAX_POOL_SIZE: "10",
  GOTRUE_DB_MAX_IDLE_POOL_SIZE: "10",
  GOTRUE_DB_CONN_MAX_LIFETIME: "30m",
  GOTRUE_DB_CONN_MAX_IDLE_TIME: "5m",
});

/** Only ever act on a container the local Supabase CLI owns. */
export const AUTH_CONTAINER_PREFIX = "supabase_auth_";

export interface HealthcheckSpec {
  Test?: string[] | undefined;
  Interval?: number | undefined;
  Timeout?: number | undefined;
  StartPeriod?: number | undefined;
  Retries?: number | undefined;
}

export interface PortBindingSpec {
  HostIp?: string | undefined;
  HostPort?: string | undefined;
}

export interface NetworkSpec {
  Aliases?: string[] | undefined;
}

export interface ContainerSpec {
  Name: string;
  Config: {
    Image: string;
    Env?: string[] | undefined;
    Cmd?: string[] | undefined;
    Entrypoint?: string[] | undefined;
    Labels?: Record<string, string> | undefined;
    User?: string | undefined;
    WorkingDir?: string | undefined;
    Healthcheck?: HealthcheckSpec | undefined;
  };
  HostConfig: {
    Binds?: string[] | undefined;
    PortBindings?: Record<string, PortBindingSpec[]> | undefined;
    RestartPolicy?: { Name?: string | undefined } | undefined;
  };
  NetworkSettings: {
    Networks?: Record<string, NetworkSpec> | undefined;
  };
}

/** `project_id = "atlas-local"` from supabase/config.toml. */
export function parseProjectId(configToml: string): string | null {
  for (const line of configToml.split("\n")) {
    const match = /^\s*project_id\s*=\s*"([^"]+)"/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

export function authContainerName(projectId: string): string {
  return `${AUTH_CONTAINER_PREFIX}${projectId}`;
}

/** Docker `KEY=VALUE` list → map. Values may contain `=`; only the first splits. */
export function parseEnvList(env: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of env) {
    const index = entry.indexOf("=");
    if (index <= 0) continue;
    result.set(entry.slice(0, index), entry.slice(index + 1));
  }
  return result;
}

/** True when every pool variable already holds its target value. */
export function isPoolConfigured(env: readonly string[]): boolean {
  const current = parseEnvList(env);
  return Object.entries(AUTH_POOL_ENV).every(([key, value]) => current.get(key) === value);
}

/**
 * Original environment with the pool variables set, preserving order and never
 * dropping an existing variable. Existing entries are replaced in place.
 */
export function mergePoolEnv(env: readonly string[]): string[] {
  const applied = new Set<string>();
  const merged = env.map((entry) => {
    const index = entry.indexOf("=");
    const key = index > 0 ? entry.slice(0, index) : entry;
    const override = AUTH_POOL_ENV[key];
    if (override === undefined) return entry;
    applied.add(key);
    return `${key}=${override}`;
  });

  for (const [key, value] of Object.entries(AUTH_POOL_ENV)) {
    if (!applied.has(key)) merged.push(`${key}=${value}`);
  }
  return merged;
}

/** Single-quote for a POSIX shell. Used only for `--health-cmd`. */
function shellQuote(argument: string): string {
  return `'${argument.split("'").join(`'\\''`)}'`;
}

/** Docker inspect reports healthcheck durations in nanoseconds. */
function nanosecondsToDuration(value: number): string {
  return `${Math.round(value / 1_000_000)}ms`;
}

function healthcheckArgs(healthcheck: HealthcheckSpec | undefined): string[] {
  const test = healthcheck?.Test ?? [];
  if (test.length === 0) return [];
  if (test[0] === "NONE") return ["--no-healthcheck"];

  const args: string[] = [];
  if (test[0] === "CMD-SHELL") {
    const command = test[1];
    if (command === undefined) return [];
    args.push("--health-cmd", command);
  } else if (test[0] === "CMD") {
    args.push("--health-cmd", test.slice(1).map(shellQuote).join(" "));
  } else {
    return [];
  }

  if (healthcheck?.Interval !== undefined && healthcheck.Interval > 0) {
    args.push("--health-interval", nanosecondsToDuration(healthcheck.Interval));
  }
  if (healthcheck?.Timeout !== undefined && healthcheck.Timeout > 0) {
    args.push("--health-timeout", nanosecondsToDuration(healthcheck.Timeout));
  }
  if (healthcheck?.StartPeriod !== undefined && healthcheck.StartPeriod > 0) {
    args.push("--health-start-period", nanosecondsToDuration(healthcheck.StartPeriod));
  }
  if (healthcheck?.Retries !== undefined && healthcheck.Retries > 0) {
    args.push("--health-retries", String(healthcheck.Retries));
  }
  return args;
}

/** Inspect prefixes container names with `/`. */
export function containerName(spec: ContainerSpec): string {
  return spec.Name.replace(/^\//, "");
}

export function networkNames(spec: ContainerSpec): string[] {
  return Object.keys(spec.NetworkSettings.Networks ?? {});
}

/**
 * Effective process the container runs. Docker composes `Entrypoint` then `Cmd`,
 * so this is what must be preserved across the recreate.
 */
export function effectiveCommand(spec: ContainerSpec): string[] {
  return [...(spec.Config.Entrypoint ?? []), ...(spec.Config.Cmd ?? [])];
}

/**
 * `docker run` arguments reproducing `spec` with `env` substituted.
 *
 * `docker run` accepts a single `--network`, so only the first network is
 * attached here; the caller connects any remainder with `docker network connect`.
 *
 * `--entrypoint` likewise accepts a single value, so a multi-element entrypoint
 * is expressed as `--entrypoint <first>` plus the remaining elements prepended to
 * the command arguments. The resulting process is identical even though the
 * Entrypoint/Cmd split differs — `compareSpecs` compares the composed command
 * rather than the two fields separately for exactly this reason.
 */
export function buildRunArgs(spec: ContainerSpec, env: readonly string[]): string[] {
  const args = ["run", "--detach", "--name", containerName(spec)];

  const [primaryNetwork] = networkNames(spec);
  if (primaryNetwork !== undefined) {
    args.push("--network", primaryNetwork);
    for (const alias of spec.NetworkSettings.Networks?.[primaryNetwork]?.Aliases ?? []) {
      args.push("--network-alias", alias);
    }
  }

  const restart = spec.HostConfig.RestartPolicy?.Name;
  if (restart !== undefined && restart !== "" && restart !== "no") {
    args.push("--restart", restart);
  }

  for (const [port, bindings] of Object.entries(spec.HostConfig.PortBindings ?? {})) {
    for (const binding of bindings) {
      const hostPort = binding.HostPort ?? "";
      const hostIp = binding.HostIp ?? "";
      const publish = hostIp === "" ? `${hostPort}:${port}` : `${hostIp}:${hostPort}:${port}`;
      args.push("--publish", publish);
    }
  }

  for (const [key, value] of Object.entries(spec.Config.Labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }

  for (const bind of spec.HostConfig.Binds ?? []) {
    args.push("--volume", bind);
  }

  if (spec.Config.User !== undefined && spec.Config.User !== "") {
    args.push("--user", spec.Config.User);
  }
  if (spec.Config.WorkingDir !== undefined && spec.Config.WorkingDir !== "") {
    args.push("--workdir", spec.Config.WorkingDir);
  }

  args.push(...healthcheckArgs(spec.Config.Healthcheck));

  // Values are passed as argv, never written to a file: the auth container's
  // environment holds the local JWT secret and database password.
  for (const entry of env) {
    args.push("--env", entry);
  }

  const entrypoint = spec.Config.Entrypoint ?? [];
  const [entrypointHead, ...entrypointTail] = entrypoint;
  if (entrypointHead !== undefined) {
    args.push("--entrypoint", entrypointHead);
  }

  args.push(spec.Config.Image, ...entrypointTail, ...(spec.Config.Cmd ?? []));
  return args;
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value);
}

function aliasMap(spec: ContainerSpec): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [network, settings] of Object.entries(spec.NetworkSettings.Networks ?? {})) {
    result[network] = [...(settings.Aliases ?? [])].sort();
  }
  return result;
}

function portMap(spec: ContainerSpec): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [port, bindings] of Object.entries(spec.HostConfig.PortBindings ?? {})) {
    result[port] = bindings.map((b) => `${b.HostIp ?? ""}:${b.HostPort ?? ""}`).sort();
  }
  return result;
}

/**
 * Fields that must survive the recreate, reported as human-readable differences.
 *
 * Environment is compared by variable *name*, never by value: a dropped variable
 * is the failure mode worth catching, and the values are secrets that must not be
 * printed (CLAUDE.md — no tokens or credentials in output).
 */
export function compareSpecs(before: ContainerSpec, after: ContainerSpec): string[] {
  const drift: string[] = [];

  const check = (label: string, a: unknown, b: unknown) => {
    if (sortedJson(a) !== sortedJson(b)) {
      drift.push(`${label} changed: ${sortedJson(a)} -> ${sortedJson(b)}`);
    }
  };

  check("image", before.Config.Image, after.Config.Image);
  check("command", effectiveCommand(before), effectiveCommand(after));
  check("labels", before.Config.Labels ?? {}, after.Config.Labels ?? {});
  check("user", before.Config.User ?? "", after.Config.User ?? "");
  check("workingDir", before.Config.WorkingDir ?? "", after.Config.WorkingDir ?? "");
  check(
    "binds",
    [...(before.HostConfig.Binds ?? [])].sort(),
    [...(after.HostConfig.Binds ?? [])].sort(),
  );
  check("portBindings", portMap(before), portMap(after));
  check(
    "restartPolicy",
    before.HostConfig.RestartPolicy?.Name ?? "",
    after.HostConfig.RestartPolicy?.Name ?? "",
  );
  check("networkAliases", aliasMap(before), aliasMap(after));
  check(
    "healthcheckRetries",
    before.Config.Healthcheck?.Retries ?? 0,
    after.Config.Healthcheck?.Retries ?? 0,
  );
  check(
    "healthcheckInterval",
    before.Config.Healthcheck?.Interval ?? 0,
    after.Config.Healthcheck?.Interval ?? 0,
  );

  const beforeKeys = [...parseEnvList(before.Config.Env ?? []).keys()].sort();
  const afterKeys = new Set(parseEnvList(after.Config.Env ?? []).keys());
  const missing = beforeKeys.filter((key) => !afterKeys.has(key));
  if (missing.length > 0) {
    drift.push(`environment variables dropped: ${missing.join(", ")}`);
  }

  return drift;
}

/**
 * Healthchecks declared as `CMD` are re-created as `CMD-SHELL`, because
 * `docker run --health-cmd` only accepts a shell string. The probe runs the same
 * program; only the declaration form differs. Reported rather than hidden.
 */
export function healthcheckFormChanged(before: ContainerSpec, after: ContainerSpec): boolean {
  return (
    before.Config.Healthcheck?.Test?.[0] === "CMD" && after.Config.Healthcheck?.Test?.[0] !== "CMD"
  );
}
