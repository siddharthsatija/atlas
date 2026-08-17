import { describe, expect, it } from "vitest";
import {
  AUTH_POOL_ENV,
  authContainerName,
  buildRunArgs,
  compareSpecs,
  containerName,
  effectiveCommand,
  healthcheckFormChanged,
  isPoolConfigured,
  mergePoolEnv,
  networkNames,
  parseEnvList,
  parseProjectId,
  type ContainerSpec,
} from "./auth-pool-config";

/** #132 — bound and reuse GoTrue → Postgres connections in the local stack. */

function spec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  const base: ContainerSpec = {
    Name: "/supabase_auth_atlas-local",
    Config: {
      Image: "public.ecr.aws/supabase/gotrue:v2.180.0",
      Env: ["GOTRUE_DB_DRIVER=postgres", "GOTRUE_JWT_SECRET=super-secret", "PATH=/usr/bin"],
      Cmd: [],
      Entrypoint: ["gotrue"],
      Labels: { "com.supabase.cli.project": "atlas-local" },
      User: "",
      WorkingDir: "",
      Healthcheck: {
        Test: ["CMD", "wget", "--no-verbose", "http://localhost:9999/health"],
        Interval: 10_000_000_000,
        Timeout: 5_000_000_000,
        Retries: 3,
      },
    },
    HostConfig: {
      Binds: [],
      PortBindings: { "9999/tcp": [{ HostIp: "", HostPort: "" }] },
      RestartPolicy: { Name: "always" },
    },
    NetworkSettings: {
      Networks: { "supabase_network_atlas-local": { Aliases: ["auth", "gotrue"] } },
    },
  };
  return { ...base, ...overrides };
}

describe("pool values", () => {
  it("bounds max open connections well below max_connections = 100", () => {
    const maxOpen = Number(AUTH_POOL_ENV.GOTRUE_DB_MAX_POOL_SIZE);
    expect(maxOpen).toBeGreaterThan(0);
    expect(maxOpen).toBeLessThanOrEqual(20);
  });

  it("keeps idle equal to max so a released connection is never closed", () => {
    // Idle < max reintroduces close-on-release during bursts, which is the
    // TIME_WAIT churn that exhausts the container's ephemeral source ports.
    expect(AUTH_POOL_ENV.GOTRUE_DB_MAX_IDLE_POOL_SIZE).toBe(AUTH_POOL_ENV.GOTRUE_DB_MAX_POOL_SIZE);
  });

  it("recycles connections on a bounded lifetime", () => {
    expect(AUTH_POOL_ENV.GOTRUE_DB_CONN_MAX_LIFETIME).toMatch(/^\d+[smh]$/);
    expect(AUTH_POOL_ENV.GOTRUE_DB_CONN_MAX_IDLE_TIME).toMatch(/^\d+[smh]$/);
  });
});

describe("parseProjectId", () => {
  it("reads the quoted project id", () => {
    expect(parseProjectId('# comment\nproject_id = "atlas-local"\n[api]\n')).toBe("atlas-local");
  });

  it("returns null when absent", () => {
    expect(parseProjectId("[api]\nport = 54321\n")).toBeNull();
  });

  it("derives the CLI container name", () => {
    expect(authContainerName("atlas-local")).toBe("supabase_auth_atlas-local");
  });
});

describe("parseEnvList", () => {
  it("splits on the first equals only", () => {
    const parsed = parseEnvList(["DATABASE_URL=postgres://a:b@c/d?x=1", "EMPTY="]);
    expect(parsed.get("DATABASE_URL")).toBe("postgres://a:b@c/d?x=1");
    expect(parsed.get("EMPTY")).toBe("");
  });

  it("ignores malformed entries", () => {
    expect(parseEnvList(["NOEQUALS", "=leading"]).size).toBe(0);
  });
});

describe("mergePoolEnv", () => {
  it("appends every pool variable when none are present", () => {
    const merged = parseEnvList(mergePoolEnv(["PATH=/usr/bin"]));
    for (const [key, value] of Object.entries(AUTH_POOL_ENV)) {
      expect(merged.get(key)).toBe(value);
    }
  });

  it("replaces an existing value in place rather than duplicating it", () => {
    const merged = mergePoolEnv(["GOTRUE_DB_MAX_POOL_SIZE=0", "PATH=/usr/bin"]);
    expect(merged.filter((e) => e.startsWith("GOTRUE_DB_MAX_POOL_SIZE="))).toHaveLength(1);
    expect(merged[0]).toBe(`GOTRUE_DB_MAX_POOL_SIZE=${AUTH_POOL_ENV.GOTRUE_DB_MAX_POOL_SIZE}`);
  });

  it("never drops an unrelated variable", () => {
    const original = ["A=1", "B=2", "C=3"];
    const merged = parseEnvList(mergePoolEnv(original));
    for (const key of ["A", "B", "C"]) expect(merged.has(key)).toBe(true);
  });

  it("is idempotent", () => {
    const once = mergePoolEnv(["PATH=/usr/bin"]);
    expect(mergePoolEnv(once)).toEqual(once);
  });
});

describe("isPoolConfigured", () => {
  it("is false for the CLI default (all unset)", () => {
    expect(isPoolConfigured(["PATH=/usr/bin"])).toBe(false);
  });

  it("is false when GoTrue reports the unlimited/no-idle default", () => {
    expect(isPoolConfigured(["GOTRUE_DB_MAX_POOL_SIZE=0", "GOTRUE_DB_MAX_IDLE_POOL_SIZE=0"])).toBe(
      false,
    );
  });

  it("is true once every value matches", () => {
    expect(isPoolConfigured(mergePoolEnv([]))).toBe(true);
  });

  it("is false when a single value drifts", () => {
    const env = mergePoolEnv([]).map((e) =>
      e.startsWith("GOTRUE_DB_MAX_IDLE_POOL_SIZE=") ? "GOTRUE_DB_MAX_IDLE_POOL_SIZE=1" : e,
    );
    expect(isPoolConfigured(env)).toBe(false);
  });
});

describe("buildRunArgs", () => {
  const args = buildRunArgs(spec(), mergePoolEnv(spec().Config.Env ?? []));
  const flagValue = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

  it("recreates the container under its original name", () => {
    expect(flagValue("--name")).toBe("supabase_auth_atlas-local");
  });

  it("reattaches the network with every alias", () => {
    expect(flagValue("--network")).toBe("supabase_network_atlas-local");
    const aliases = args.filter((_value, index) => args[index - 1] === "--network-alias");
    expect(aliases).toEqual(["auth", "gotrue"]);
  });

  it("preserves CLI labels so `supabase stop` still reaps the container", () => {
    expect(args).toContain("com.supabase.cli.project=atlas-local");
  });

  it("preserves the restart policy and published ports", () => {
    expect(flagValue("--restart")).toBe("always");
    expect(flagValue("--publish")).toBe(":9999/tcp");
  });

  it("carries the pool variables", () => {
    for (const [key, value] of Object.entries(AUTH_POOL_ENV)) {
      expect(args).toContain(`${key}=${value}`);
    }
  });

  it("passes environment as argv and never writes an env file", () => {
    expect(args).not.toContain("--env-file");
    expect(args).toContain("GOTRUE_JWT_SECRET=super-secret");
  });

  it("puts the image last, before its command arguments", () => {
    expect(args.at(-1)).toBe("public.ecr.aws/supabase/gotrue:v2.180.0");
    expect(flagValue("--entrypoint")).toBe("gotrue");
  });

  it("preserves the composed process for a multi-element entrypoint", () => {
    const multi = spec();
    multi.Config.Entrypoint = ["/bin/sh", "-c"];
    multi.Config.Cmd = ["gotrue serve"];
    const built = buildRunArgs(multi, []);
    const imageIndex = built.indexOf(multi.Config.Image);
    expect(built[built.indexOf("--entrypoint") + 1]).toBe("/bin/sh");
    expect(built.slice(imageIndex + 1)).toEqual(["-c", "gotrue serve"]);
  });

  it("translates a CMD healthcheck into a shell-quoted probe", () => {
    expect(flagValue("--health-cmd")).toBe("'wget' '--no-verbose' 'http://localhost:9999/health'");
    expect(flagValue("--health-interval")).toBe("10000ms");
    expect(flagValue("--health-retries")).toBe("3");
  });

  it("passes a CMD-SHELL healthcheck through unquoted", () => {
    const shell = spec();
    shell.Config.Healthcheck = { Test: ["CMD-SHELL", "curl -f http://localhost:9999/health"] };
    const built = buildRunArgs(shell, []);
    expect(built[built.indexOf("--health-cmd") + 1]).toBe("curl -f http://localhost:9999/health");
  });

  it("disables the healthcheck when the image declares NONE", () => {
    const none = spec();
    none.Config.Healthcheck = { Test: ["NONE"] };
    expect(buildRunArgs(none, [])).toContain("--no-healthcheck");
  });

  it("omits the restart flag when the policy is empty", () => {
    const noRestart = spec();
    noRestart.HostConfig.RestartPolicy = { Name: "" };
    expect(buildRunArgs(noRestart, [])).not.toContain("--restart");
  });

  it("reports secondary networks so the caller can reconnect them", () => {
    const multi = spec();
    multi.NetworkSettings.Networks = {
      "supabase_network_atlas-local": { Aliases: ["auth"] },
      extra: { Aliases: [] },
    };
    expect(networkNames(multi)).toEqual(["supabase_network_atlas-local", "extra"]);
  });
});

describe("compareSpecs", () => {
  it("reports no drift for an identical recreate", () => {
    expect(compareSpecs(spec(), spec())).toEqual([]);
  });

  it("tolerates the Entrypoint/Cmd split moving, since the process is unchanged", () => {
    const after = spec();
    after.Config.Entrypoint = [];
    after.Config.Cmd = ["gotrue"];
    expect(effectiveCommand(after)).toEqual(effectiveCommand(spec()));
    expect(compareSpecs(spec(), after)).toEqual([]);
  });

  it("catches a dropped environment variable", () => {
    const after = spec();
    after.Config.Env = ["PATH=/usr/bin"];
    expect(compareSpecs(spec(), after).join(" ")).toContain("GOTRUE_JWT_SECRET");
  });

  it("never prints an environment value", () => {
    const after = spec();
    after.Config.Env = ["PATH=/usr/bin"];
    expect(compareSpecs(spec(), after).join(" ")).not.toContain("super-secret");
  });

  it("catches a lost network alias", () => {
    const after = spec();
    after.NetworkSettings.Networks = { "supabase_network_atlas-local": { Aliases: ["auth"] } };
    expect(compareSpecs(spec(), after).join(" ")).toContain("networkAliases");
  });

  it("catches a lost label, image, or port binding", () => {
    const noLabel = spec();
    noLabel.Config.Labels = {};
    expect(compareSpecs(spec(), noLabel).join(" ")).toContain("labels");

    const otherImage = spec();
    otherImage.Config.Image = "gotrue:other";
    expect(compareSpecs(spec(), otherImage).join(" ")).toContain("image");

    const noPorts = spec();
    noPorts.HostConfig.PortBindings = {};
    expect(compareSpecs(spec(), noPorts).join(" ")).toContain("portBindings");
  });

  it("strips the leading slash from the inspected name", () => {
    expect(containerName(spec())).toBe("supabase_auth_atlas-local");
  });
});

describe("healthcheckFormChanged", () => {
  it("flags CMD becoming CMD-SHELL", () => {
    const after = spec();
    after.Config.Healthcheck = { Test: ["CMD-SHELL", "wget ..."] };
    expect(healthcheckFormChanged(spec(), after)).toBe(true);
  });

  it("does not flag an unchanged form", () => {
    expect(healthcheckFormChanged(spec(), spec())).toBe(false);
  });
});
