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

  // --- Audit logging (ADR-006) --------------------------------------------
  AUDIT_HMAC_KEY: base64Key(32, "AUDIT_HMAC_KEY"),

  // --- AI provider (security §10) — unused until milestone M7 -------------
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),

  // --- Rate limiting (architecture §3) ------------------------------------
  // Serverless cannot rate-limit in memory; a shared durable store is required.
  RATE_LIMIT_REDIS_URL: z.url("RATE_LIMIT_REDIS_URL must be a valid URL"),
  RATE_LIMIT_REDIS_TOKEN: z.string().min(1, "RATE_LIMIT_REDIS_TOKEN is required"),
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
