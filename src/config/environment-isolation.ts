import type { ServerEnv } from "./env.schema";

/**
 * Environment isolation rules (ATL-003).
 *
 * Architecture §18 requires that each environment use separate projects, keys,
 * databases, and storage, and that **production data never reaches a lower
 * environment**. These rules turn that requirement from prose into an enforced
 * invariant: they run at boot (`env.ts`) and in the environment smoke check
 * (`scripts/check-environment.mts`).
 *
 * Design notes:
 *   - Pure functions, no I/O, so they are exhaustively unit-testable.
 *   - Violations never include a secret value — only the variable name and the
 *     reason (security §9).
 *   - `preview` is deliberately the most permissive environment: previews may run
 *     against an ephemeral or local instance (deployment skill, Environments table).
 *     `staging` and `production` are held to the strict rules because that is where
 *     a mistake is dangerous.
 */

export type IsolationSeverity = "error";

export interface IsolationViolation {
  /** Stable identifier, used in tests and error output. */
  rule: string;
  /** Environment variable(s) involved. Names only — never values. */
  variables: string[];
  /** Operator-facing explanation of what is wrong and why it matters. */
  message: string;
  severity: IsolationSeverity;
}

/** Hosts that indicate a developer machine rather than a hosted project. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

/**
 * Substrings that indicate a non-production placeholder secret. Matched
 * case-insensitively against the decoded value's *shape*, never logged.
 */
const PLACEHOLDER_MARKERS = [
  "placeholder",
  "changeme",
  "change-me",
  "example",
  "dummy",
  "your-",
  "xxx",
  "todo",
  "local-dev",
  "ci-",
  "test-key",
];

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

function isLoopback(rawUrl: string): boolean {
  const host = hostOf(rawUrl);
  return host !== null && LOOPBACK_HOSTS.has(host);
}

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))) return true;

  // A base64 key decoding to a single repeated byte (e.g. all zeros) is a filler value.
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length >= 16 && decoded.every((byte) => byte === decoded[0])) return true;
  } catch {
    // Not base64 — the marker check above already applies.
  }
  return false;
}

/**
 * Evaluates every isolation rule for the given environment.
 * Returns an empty array when the configuration is sound.
 */
export function findIsolationViolations(env: ServerEnv): IsolationViolation[] {
  const violations: IsolationViolation[] = [];
  const target = env.ATLAS_ENV;
  const isRemote = target === "staging" || target === "production";

  // --- R1: local must stay local -------------------------------------------
  // Prevents a developer machine from being pointed at a hosted project, which is
  // the most common way production data reaches a laptop.
  if (target === "local" && !isLoopback(env.NEXT_PUBLIC_SUPABASE_URL)) {
    violations.push({
      rule: "local-must-use-loopback",
      variables: ["NEXT_PUBLIC_SUPABASE_URL", "ATLAS_ENV"],
      message:
        "ATLAS_ENV=local must point at a local Supabase instance (127.0.0.1). " +
        "Pointing local development at a hosted project risks copying real data to a developer machine (architecture §18).",
      severity: "error",
    });
  }

  // --- R2: staging and production must not be loopback ---------------------
  if (isRemote && isLoopback(env.NEXT_PUBLIC_SUPABASE_URL)) {
    violations.push({
      rule: "remote-must-not-use-loopback",
      variables: ["NEXT_PUBLIC_SUPABASE_URL", "ATLAS_ENV"],
      message: `ATLAS_ENV=${target} is configured against a loopback host. Each environment uses its own hosted project (architecture §18).`,
      severity: "error",
    });
  }

  // --- R3: production must be HTTPS end to end -----------------------------
  if (target === "production") {
    for (const [name, value] of [
      ["NEXT_PUBLIC_SUPABASE_URL", env.NEXT_PUBLIC_SUPABASE_URL],
      ["NEXT_PUBLIC_APP_URL", env.NEXT_PUBLIC_APP_URL],
    ] as const) {
      if (!value.startsWith("https://")) {
        violations.push({
          rule: "production-requires-https",
          variables: [name],
          message: `${name} must use https in production (security §8: TLS for all network connections).`,
          severity: "error",
        });
      }
    }
  }

  // --- R4: a lower environment must never target the production project ----
  // ATLAS_PRODUCTION_PROJECT_REF is optional. When set (recommended for CI and
  // staging), it makes "no production data path to lower environments" a check
  // rather than a convention.
  const productionRef = process.env.ATLAS_PRODUCTION_PROJECT_REF?.trim();
  if (productionRef && target !== "production") {
    const host = hostOf(env.NEXT_PUBLIC_SUPABASE_URL) ?? "";
    if (host.includes(productionRef)) {
      violations.push({
        rule: "lower-environment-targets-production",
        variables: ["NEXT_PUBLIC_SUPABASE_URL", "ATLAS_PRODUCTION_PROJECT_REF"],
        message: `ATLAS_ENV=${target} is pointing at the production Supabase project. Production data must never reach a lower environment (architecture §18).`,
        severity: "error",
      });
    }
  }

  // --- R5: the service-role key must not be the anon key -------------------
  // The anon key is RLS-constrained and public; the service-role key bypasses RLS.
  // Setting them equal would either break RLS or expose a bypass key to the browser.
  if (env.SUPABASE_SERVICE_ROLE_KEY === env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    violations.push({
      rule: "service-role-must-differ-from-anon",
      variables: ["SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
      message:
        "The service-role key and the anon key are identical. The service role bypasses RLS and must never be the browser-visible key (security §6).",
      severity: "error",
    });
  }

  // --- R6: encryption and audit keys must be distinct ----------------------
  // ADR-003 (KEK) and ADR-006 (audit HMAC) define two independent keys. Reusing one
  // value for both couples ciphertext confidentiality to audit-subject pseudonymity.
  if (env.ATLAS_KEK === env.AUDIT_HMAC_KEY) {
    violations.push({
      rule: "kek-and-audit-key-must-differ",
      variables: ["ATLAS_KEK", "AUDIT_HMAC_KEY"],
      message:
        "ATLAS_KEK and AUDIT_HMAC_KEY are identical. They serve different purposes and must be independently generated (ADR-003, ADR-006).",
      severity: "error",
    });
  }

  // --- R7: no placeholder secrets in staging or production -----------------
  // Catches shipping development or CI filler values to a hosted environment.
  if (isRemote) {
    for (const [name, value] of [
      ["SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY],
      ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.NEXT_PUBLIC_SUPABASE_ANON_KEY],
      ["ATLAS_KEK", env.ATLAS_KEK],
      ["AUDIT_HMAC_KEY", env.AUDIT_HMAC_KEY],
      ["ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY],
      ["RATE_LIMIT_REDIS_TOKEN", env.RATE_LIMIT_REDIS_TOKEN],
    ] as const) {
      if (looksLikePlaceholder(value)) {
        violations.push({
          rule: "no-placeholder-secrets-in-hosted-environments",
          variables: [name],
          message: `${name} looks like a placeholder or development value but ATLAS_ENV=${target}. Each environment uses its own real secret (security §9).`,
          severity: "error",
        });
      }
    }
  }

  return violations;
}

/**
 * Throws when the environment violates isolation. Called at boot so a
 * misconfigured environment fails immediately rather than at first use.
 * The message names variables and rules — never values.
 */
export function assertEnvironmentIsolation(env: ServerEnv): void {
  const violations = findIsolationViolations(env);
  if (violations.length === 0) return;

  const detail = violations
    .map((v) => `  - [${v.rule}] ${v.variables.join(", ")}: ${v.message}`)
    .join("\n");

  throw new Error(
    `Environment isolation check failed for ATLAS_ENV=${env.ATLAS_ENV}:\n${detail}\n\n` +
      `See supabase/README.md and architecture §18.`,
  );
}
