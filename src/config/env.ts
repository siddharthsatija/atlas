import "server-only";
import { assertEnvironmentIsolation } from "./environment-isolation";
import { buildServerEnv, type ServerEnv } from "./env.schema";

/**
 * Validated server environment (ATL-001).
 *
 * Evaluated once at module load: a missing or malformed value fails the build or
 * boot rather than surfacing as `undefined` at runtime.
 *
 * This module is server-only. Client-visible values are re-exported deliberately
 * through `publicEnv`, so exposing a new value to the browser requires an explicit
 * change here (architecture §5, security §9).
 *
 * The schema and parser live in `env.schema.ts` so they can be unit-tested without
 * importing this server-only module.
 *
 * After parsing, environment isolation is asserted (ATL-003, architecture §18): a
 * lower environment pointed at production credentials, a reused key, or a
 * placeholder secret in a hosted environment fails the boot rather than being
 * discovered in production.
 */
export const env: ServerEnv = (() => {
  const parsed = buildServerEnv(process.env);
  assertEnvironmentIsolation(parsed);
  return parsed;
})();

/**
 * Values safe to reference from client code.
 * Import this — never `env` — when a value must reach the browser.
 */
export const publicEnv = {
  supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  appUrl: env.NEXT_PUBLIC_APP_URL,
} as const;

export const isProduction = env.ATLAS_ENV === "production";
export const isLocal = env.ATLAS_ENV === "local";
export type { ServerEnv };
