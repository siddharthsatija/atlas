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

  // --- R8: hosted environments must have error monitoring configured -------
  // ATL-095 + PRD launch checklist ("production monitoring enabled"). Deploying
  // staging or production with no collector means an incident is discovered by a
  // user report rather than an alert.
  if (isRemote && !env.ATLAS_MONITORING_ENDPOINT) {
    violations.push({
      rule: "hosted-environment-requires-monitoring",
      variables: ["ATLAS_MONITORING_ENDPOINT", "ATLAS_ENV"],
      message: `ATLAS_ENV=${target} has no error-monitoring endpoint configured. Hosted environments must report errors (architecture §16, ATL-095).`,
      severity: "error",
    });
  }

  // --- R9: the monitoring endpoint must be HTTPS in hosted environments ----
  // Error events carry route templates, release, and correlation IDs. Low
  // sensitivity individually, but plaintext telemetry is a passive-observer gift
  // and contradicts security §8 (TLS for all network connections).
  if (isRemote && env.ATLAS_MONITORING_ENDPOINT) {
    if (!env.ATLAS_MONITORING_ENDPOINT.startsWith("https://")) {
      violations.push({
        rule: "monitoring-endpoint-requires-https",
        variables: ["ATLAS_MONITORING_ENDPOINT"],
        message:
          "ATLAS_MONITORING_ENDPOINT must use https outside local development (security §8).",
        severity: "error",
      });
    }
    if (isLoopback(env.ATLAS_MONITORING_ENDPOINT)) {
      violations.push({
        rule: "monitoring-endpoint-must-not-be-loopback",
        variables: ["ATLAS_MONITORING_ENDPOINT", "ATLAS_ENV"],
        message: `ATLAS_ENV=${target} points monitoring at a loopback host, so events go nowhere. Each environment reports to its own project (architecture §18).`,
        severity: "error",
      });
    }
  }

  // --- R10: the monitoring credential must be its own secret ---------------
  // "Separate DSN/keys per environment" (ATL-095). Reusing another subsystem's
  // secret as the collector key would hand a third party a credential that also
  // unlocks Supabase, the AI provider, or the rate-limit store.
  if (env.ATLAS_MONITORING_KEY) {
    for (const [name, value] of [
      ["SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY],
      ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.NEXT_PUBLIC_SUPABASE_ANON_KEY],
      ["ATLAS_KEK", env.ATLAS_KEK],
      ["AUDIT_HMAC_KEY", env.AUDIT_HMAC_KEY],
      ["ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY],
      ["RATE_LIMIT_REDIS_TOKEN", env.RATE_LIMIT_REDIS_TOKEN],
    ] as const) {
      if (env.ATLAS_MONITORING_KEY === value) {
        violations.push({
          rule: "monitoring-key-must-be-distinct",
          variables: ["ATLAS_MONITORING_KEY", name],
          message: `ATLAS_MONITORING_KEY is identical to ${name}. The monitoring credential is shared with a third-party collector and must never unlock another system (security §9).`,
          severity: "error",
        });
      }
    }

    if (isRemote && looksLikePlaceholder(env.ATLAS_MONITORING_KEY)) {
      violations.push({
        rule: "no-placeholder-secrets-in-hosted-environments",
        variables: ["ATLAS_MONITORING_KEY"],
        message: `ATLAS_MONITORING_KEY looks like a placeholder or development value but ATLAS_ENV=${target}. Each environment uses its own real secret (security §9).`,
        severity: "error",
      });
    }
  }

  // --- R13: the previous KEK must be configured as a complete pair ---------
  // ATL-084. A key without its version cannot be selected, and a version without
  // its key resolves to nothing — either half alone silently disables the
  // rotation fallback it exists to provide, and users mid-sweep lose access to
  // their own data.
  const hasPreviousKek = Boolean(env.ATLAS_KEK_PREVIOUS);
  const hasPreviousVersion = env.ATLAS_KEK_PREVIOUS_VERSION !== undefined;
  if (hasPreviousKek !== hasPreviousVersion) {
    violations.push({
      rule: "previous-kek-requires-both-key-and-version",
      variables: ["ATLAS_KEK_PREVIOUS", "ATLAS_KEK_PREVIOUS_VERSION"],
      message:
        "The previous KEK is half-configured. Set both the key and its version, or neither (ADR-003 rotation).",
      severity: "error",
    });
  }

  if (hasPreviousKek && hasPreviousVersion) {
    // Reusing one key across generations makes rotation a no-op that reports
    // success — the worst possible outcome for a control whose value is that the
    // old key stops working.
    if (env.ATLAS_KEK_PREVIOUS === env.ATLAS_KEK) {
      violations.push({
        rule: "previous-kek-must-differ-from-current",
        variables: ["ATLAS_KEK_PREVIOUS", "ATLAS_KEK"],
        message:
          "ATLAS_KEK_PREVIOUS is identical to ATLAS_KEK. A rotation that reuses the key rotates nothing (ADR-003).",
        severity: "error",
      });
    }

    if ((env.ATLAS_KEK_PREVIOUS_VERSION ?? 0) >= env.ATLAS_KEK_VERSION) {
      violations.push({
        rule: "kek-version-must-advance",
        variables: ["ATLAS_KEK_PREVIOUS_VERSION", "ATLAS_KEK_VERSION"],
        message:
          "ATLAS_KEK_VERSION must be greater than ATLAS_KEK_PREVIOUS_VERSION. Versions identify generations and only move forward (ADR-003).",
        severity: "error",
      });
    }
  }

  // --- R11: Google OAuth must be configured as a pair ----------------------
  // ATL-011. Google is optional, but half-configured is not a valid state: a
  // client ID with no secret produces a provider that appears available and fails
  // at the consent step, which reads to a user as "sign-in is broken".
  const hasGoogleId = Boolean(env.ATLAS_GOOGLE_CLIENT_ID);
  const hasGoogleSecret = Boolean(env.ATLAS_GOOGLE_CLIENT_SECRET);
  if (hasGoogleId !== hasGoogleSecret) {
    violations.push({
      rule: "google-oauth-requires-both-credentials",
      variables: ["ATLAS_GOOGLE_CLIENT_ID", "ATLAS_GOOGLE_CLIENT_SECRET"],
      message:
        "Google OAuth is partially configured. Set both the client ID and the secret, or neither — magic link is the primary method and works alone (security §5).",
      severity: "error",
    });
  }

  // --- R12: the OAuth secret must not be a placeholder in hosted environments
  if (isRemote && env.ATLAS_GOOGLE_CLIENT_SECRET) {
    if (looksLikePlaceholder(env.ATLAS_GOOGLE_CLIENT_SECRET)) {
      violations.push({
        rule: "no-placeholder-secrets-in-hosted-environments",
        variables: ["ATLAS_GOOGLE_CLIENT_SECRET"],
        message: `ATLAS_GOOGLE_CLIENT_SECRET looks like a placeholder or development value but ATLAS_ENV=${target}. Each environment uses its own real secret (security §9).`,
        severity: "error",
      });
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
