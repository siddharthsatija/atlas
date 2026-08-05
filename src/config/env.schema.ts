import { z } from "zod";

/**
 * Environment schema and parser (ATL-001).
 *
 * Deliberately separate from `env.ts`: this module is pure and contains no secrets
 * and no `process.env` access, so it can be unit-tested directly. `env.ts` is the
 * server-only module that actually reads the environment.
 *
 * Error messages name the offending variable and never echo its value (security §9).
 */

const base64Key = (bytes: number, label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine((v) => {
      try {
        return Buffer.from(v, "base64").length === bytes;
      } catch {
        return false;
      }
    }, `${label} must be ${bytes} bytes, base64-encoded (openssl rand -base64 ${bytes})`);

export const serverEnvSchema = z.object({
  // --- Runtime -------------------------------------------------------------
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ATLAS_ENV: z.enum(["local", "preview", "staging", "production"]).default("local"),
  ATLAS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // --- Supabase ------------------------------------------------------------
  NEXT_PUBLIC_SUPABASE_URL: z.url("NEXT_PUBLIC_SUPABASE_URL must be a valid URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY is required"),
  /** Bypasses RLS. Server-only modules exclusively (security §6). */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),

  // --- Application ---------------------------------------------------------
  NEXT_PUBLIC_APP_URL: z.url("NEXT_PUBLIC_APP_URL must be a valid URL"),

  // --- Encryption (ADR-003) ------------------------------------------------
  ATLAS_KEK: base64Key(32, "ATLAS_KEK"),
  ATLAS_KEK_VERSION: z.coerce.number().int().positive().default(1),
  /**
   * The superseded KEK, set only while a rotation sweep is in flight (ATL-084).
   *
   * Re-wrapping every DEK is not instantaneous. Without the previous generation
   * in the process, un-swept users would be locked out of their own data between
   * deploy and sweep completion. Both values are set together or neither is —
   * enforced by an isolation rule, because a half-set pair would silently
   * disable the fallback it exists to provide.
   */
  ATLAS_KEK_PREVIOUS: base64Key(32, "ATLAS_KEK_PREVIOUS").optional(),
  ATLAS_KEK_PREVIOUS_VERSION: z.coerce.number().int().positive().optional(),

  // --- Audit logging (ADR-006) --------------------------------------------
  AUDIT_HMAC_KEY: base64Key(32, "AUDIT_HMAC_KEY"),

  // --- AI provider (security §10) — unused until milestone M7 -------------
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),

  // --- Rate limiting (architecture §3) ------------------------------------
  // Serverless cannot rate-limit in memory; a shared durable store is required.
  RATE_LIMIT_REDIS_URL: z.url("RATE_LIMIT_REDIS_URL must be a valid URL"),
  RATE_LIMIT_REDIS_TOKEN: z.string().min(1, "RATE_LIMIT_REDIS_TOKEN is required"),

  // --- Google OAuth (ATL-011, security §5) --------------------------------
  // Optional: magic link is the primary method and the application works fully
  // without Google. Both values are server-only — the browser receives only the
  // consent URL the server builds, never the client secret.
  ATLAS_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  ATLAS_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  // --- Error monitoring (ATL-095, architecture §16) -----------------------
  // Optional: local development and CI run without a collector, and monitoring
  // being absent must not fail a developer's boot. Staging and production are
  // held to a stricter standard by the isolation rules (architecture §18), which
  // require monitoring to be configured, HTTPS, and distinct per environment.
  //
  // Server-only and deliberately NOT NEXT_PUBLIC: the browser reports through the
  // first-party ingest route, so the collector credential never reaches a client
  // bundle (security §9, CLAUDE.md).
  ATLAS_MONITORING_ENDPOINT: z.url("ATLAS_MONITORING_ENDPOINT must be a valid URL").optional(),
  ATLAS_MONITORING_KEY: z.string().min(1).optional(),
  /** Build identifier for release tagging. Falls back to the platform's commit SHA. */
  ATLAS_RELEASE: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
      "ATLAS_RELEASE must be an identifier-shaped build reference (no spaces or free text)",
    )
    .optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Parses and validates an environment source.
 * Throws with a list of offending variable names — never their values.
 */
export function buildServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        `See .env.example. Each environment uses its own values (security §9).`,
    );
  }

  return parsed.data;
}
