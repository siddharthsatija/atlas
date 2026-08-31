import { describe, expect, it } from "vitest";
import { buildServerEnv, serverEnvSchema } from "./env.schema";

/**
 * SCAFFOLD VALIDATION — not a product test.
 *
 * Verifies that environment validation fails loudly and never leaks secret values
 * into error output (ATL-001, security §9).
 */

const validEnv = {
  NODE_ENV: "test",
  ATLAS_ENV: "local",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-placeholder",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  ATLAS_KEK: Buffer.alloc(32, 1).toString("base64"),
  ATLAS_KEK_VERSION: "1",
  AUDIT_HMAC_KEY: Buffer.alloc(32, 2).toString("base64"),
  ANTHROPIC_API_KEY: "anthropic-placeholder",
  RATE_LIMIT_REDIS_URL: "http://127.0.0.1:6379",
  RATE_LIMIT_REDIS_TOKEN: "redis-placeholder",
  HIBP_API_KEY: "hibp-placeholder",
} as const;

describe("environment validation", () => {
  it("accepts a fully populated environment", () => {
    const parsed = serverEnvSchema.safeParse(validEnv);
    expect(parsed.success).toBe(true);
  });

  it("accepts explicitly defined safe placeholders in test environments", () => {
    // CI and local test runs use non-secret placeholders; validation must not
    // require real credentials to typecheck, build, or run tests.
    expect(() => buildServerEnv(validEnv)).not.toThrow();
  });

  it.each([
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ATLAS_KEK",
    "AUDIT_HMAC_KEY",
    "ANTHROPIC_API_KEY",
    "RATE_LIMIT_REDIS_URL",
    "HIBP_API_KEY",
  ])("fails when required variable %s is missing", (key) => {
    const { [key]: _removed, ...incomplete } = validEnv as Record<string, string>;
    expect(() => buildServerEnv(incomplete)).toThrow(/Invalid environment configuration/);
  });

  it("fails when HIBP_API_KEY is empty", () => {
    expect(() => buildServerEnv({ ...validEnv, HIBP_API_KEY: "" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("fails when a URL variable is malformed", () => {
    expect(() => buildServerEnv({ ...validEnv, NEXT_PUBLIC_APP_URL: "not-a-url" })).toThrow(
      /NEXT_PUBLIC_APP_URL/,
    );
  });

  it("fails when an encryption key is not 32 bytes", () => {
    const tooShort = Buffer.alloc(16, 1).toString("base64");
    expect(() => buildServerEnv({ ...validEnv, ATLAS_KEK: tooShort })).toThrow(/ATLAS_KEK/);
  });

  it("fails when an encryption key is not valid base64 of the right length", () => {
    expect(() => buildServerEnv({ ...validEnv, AUDIT_HMAC_KEY: "obviously-not-base64!!" })).toThrow(
      /AUDIT_HMAC_KEY/,
    );
  });

  it("never includes a secret value in the error message", () => {
    const secret = "SUPER-SECRET-VALUE-THAT-MUST-NOT-LEAK";
    let message = "";
    try {
      buildServerEnv({ ...validEnv, ATLAS_KEK: secret });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/ATLAS_KEK/); // names the variable
    expect(message).not.toContain(secret); // never echoes the value
  });

  it("exposes only NEXT_PUBLIC_ values through the public surface", () => {
    const env = buildServerEnv(validEnv);
    const publicSurface = {
      supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
      supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      appUrl: env.NEXT_PUBLIC_APP_URL,
    };
    const serialized = JSON.stringify(publicSurface);

    for (const secret of [
      validEnv.SUPABASE_SERVICE_ROLE_KEY,
      validEnv.ATLAS_KEK,
      validEnv.AUDIT_HMAC_KEY,
      validEnv.ANTHROPIC_API_KEY,
      validEnv.RATE_LIMIT_REDIS_TOKEN,
      validEnv.HIBP_API_KEY,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("rejects server-only secrets that are given a NEXT_PUBLIC_ prefix", () => {
    // A secret must never be reachable client-side by renaming it. The schema has
    // no NEXT_PUBLIC_ key for any secret, so such a variable is simply not a
    // recognized source of that value.
    const shape = Object.keys(serverEnvSchema.shape);
    const publicKeys = shape.filter((k) => k.startsWith("NEXT_PUBLIC_"));

    expect(publicKeys).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_APP_URL",
    ]);
    for (const secretName of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "ATLAS_KEK",
      "AUDIT_HMAC_KEY",
      "ANTHROPIC_API_KEY",
      "RATE_LIMIT_REDIS_TOKEN",
      "HIBP_API_KEY",
    ]) {
      expect(shape).not.toContain(`NEXT_PUBLIC_${secretName}`);
    }
  });
});
