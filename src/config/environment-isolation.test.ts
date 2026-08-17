import { afterEach, describe, expect, it } from "vitest";
import type { ServerEnv } from "./env.schema";
import { assertEnvironmentIsolation, findIsolationViolations } from "./environment-isolation";

/**
 * ATL-003 — environment isolation rules.
 *
 * These rules are the enforced form of architecture §18 ("each environment uses
 * separate projects, keys, databases and storage; production data must never be
 * copied to lower environments"), so they are covered exhaustively including the
 * permissive cases that must NOT fire.
 */

const KEK = Buffer.alloc(32, 1).toString("base64");
const HMAC = Buffer.alloc(32, 2).toString("base64");

function env(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    NODE_ENV: "test",
    ATLAS_ENV: "local",
    ATLAS_LOG_LEVEL: "info",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-value",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    ATLAS_KEK: KEK,
    ATLAS_KEK_VERSION: 1,
    AUDIT_HMAC_KEY: HMAC,
    ANTHROPIC_API_KEY: "anthropic-key-value",
    // ATL-052's kill switch. Defaults to true, so the fixture matches a
    // deployment that has not set it.
    AI_ENABLED: true,
    RATE_LIMIT_REDIS_URL: "http://127.0.0.1:6379",
    RATE_LIMIT_REDIS_TOKEN: "redis-token-value",
    ...overrides,
  };
}

/**
 * A realistic hosted configuration with independent, non-placeholder secrets.
 *
 * The keys are deliberately high-entropy: the shared `KEK`/`HMAC` fixtures decode to
 * a single repeated byte, which rule R7 correctly rejects for hosted environments.
 */
const HOSTED_KEK = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 251)).toString(
  "base64",
);
const HOSTED_HMAC = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 97) % 241)).toString(
  "base64",
);

function hostedEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return env({
    ATLAS_ENV: "staging",
    ATLAS_KEK: HOSTED_KEK,
    AUDIT_HMAC_KEY: HOSTED_HMAC,
    NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
    NEXT_PUBLIC_APP_URL: "https://staging.atlas.app",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon",
    SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service",
    ANTHROPIC_API_KEY: "sk-ant-api03-realvaluehere",
    RATE_LIMIT_REDIS_URL: "https://eu1-rate-limit.upstash.io",
    RATE_LIMIT_REDIS_TOKEN: "AX9sASQgN2M0",
    // ATL-095: hosted environments must report errors somewhere (R8).
    ATLAS_MONITORING_ENDPOINT: "https://collector.example.com/staging/ingest",
    ATLAS_MONITORING_KEY: "mon_9f2b7c1dRealValue",
    ...overrides,
  });
}

const rules = (e: ServerEnv) => findIsolationViolations(e).map((v) => v.rule);

afterEach(() => {
  delete process.env.ATLAS_PRODUCTION_PROJECT_REF;
});

describe("environment isolation", () => {
  describe("sound configurations produce no violations", () => {
    it("accepts a correct local environment", () => {
      expect(findIsolationViolations(env())).toEqual([]);
    });

    it("accepts a correct staging environment", () => {
      expect(findIsolationViolations(hostedEnv())).toEqual([]);
    });

    it("accepts a correct production environment", () => {
      const production = hostedEnv({
        ATLAS_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://atlas.app",
      });
      expect(findIsolationViolations(production)).toEqual([]);
    });

    it("leaves preview permissive: it may run against an ephemeral local instance", () => {
      // Deployment skill, Environments table: preview may be ephemeral.
      expect(findIsolationViolations(env({ ATLAS_ENV: "preview" }))).toEqual([]);
    });
  });

  describe("R1 local must use a loopback host", () => {
    it("rejects local pointed at a hosted project", () => {
      const e = env({ NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co" });
      expect(rules(e)).toContain("local-must-use-loopback");
    });

    it.each(["http://127.0.0.1:54321", "http://localhost:54321"])("accepts %s", (url) => {
      expect(rules(env({ NEXT_PUBLIC_SUPABASE_URL: url }))).not.toContain(
        "local-must-use-loopback",
      );
    });
  });

  describe("R2 hosted environments must not use loopback", () => {
    it.each(["staging", "production"] as const)("rejects loopback in %s", (target) => {
      const e = hostedEnv({
        ATLAS_ENV: target,
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      });
      expect(rules(e)).toContain("remote-must-not-use-loopback");
    });

    it("does not apply to preview", () => {
      expect(rules(env({ ATLAS_ENV: "preview" }))).not.toContain("remote-must-not-use-loopback");
    });
  });

  describe("R3 production requires HTTPS", () => {
    it("rejects a non-https Supabase URL in production", () => {
      const e = hostedEnv({
        ATLAS_ENV: "production",
        NEXT_PUBLIC_SUPABASE_URL: "http://abcdefghijklmnop.supabase.co",
      });
      expect(rules(e)).toContain("production-requires-https");
    });

    it("rejects a non-https app URL in production", () => {
      const e = hostedEnv({ ATLAS_ENV: "production", NEXT_PUBLIC_APP_URL: "http://atlas.app" });
      expect(rules(e)).toContain("production-requires-https");
    });

    it("does not require https in staging", () => {
      expect(rules(hostedEnv())).not.toContain("production-requires-https");
    });
  });

  describe("R4 a lower environment must never target the production project", () => {
    it("rejects staging pointed at the production project ref", () => {
      process.env.ATLAS_PRODUCTION_PROJECT_REF = "prodprojectref01";
      const e = hostedEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://prodprojectref01.supabase.co" });
      expect(rules(e)).toContain("lower-environment-targets-production");
    });

    it("allows production to target its own project ref", () => {
      process.env.ATLAS_PRODUCTION_PROJECT_REF = "prodprojectref01";
      const e = hostedEnv({
        ATLAS_ENV: "production",
        NEXT_PUBLIC_SUPABASE_URL: "https://prodprojectref01.supabase.co",
        NEXT_PUBLIC_APP_URL: "https://atlas.app",
      });
      expect(rules(e)).not.toContain("lower-environment-targets-production");
    });

    it("is inert when the production ref is not configured", () => {
      const e = hostedEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://prodprojectref01.supabase.co" });
      expect(rules(e)).not.toContain("lower-environment-targets-production");
    });
  });

  describe("R5 the service-role key must differ from the anon key", () => {
    it("rejects identical keys", () => {
      const e = env({
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "same-key",
        SUPABASE_SERVICE_ROLE_KEY: "same-key",
      });
      expect(rules(e)).toContain("service-role-must-differ-from-anon");
    });
  });

  describe("R6 encryption and audit keys must differ", () => {
    it("rejects a reused key", () => {
      expect(rules(env({ ATLAS_KEK: KEK, AUDIT_HMAC_KEY: KEK }))).toContain(
        "kek-and-audit-key-must-differ",
      );
    });
  });

  describe("R7 no placeholder secrets in hosted environments", () => {
    it.each([
      ["SUPABASE_SERVICE_ROLE_KEY", { SUPABASE_SERVICE_ROLE_KEY: "ci-placeholder-service-role" }],
      ["ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "your-key-here" }],
      ["RATE_LIMIT_REDIS_TOKEN", { RATE_LIMIT_REDIS_TOKEN: "changeme" }],
    ])("rejects a placeholder %s in staging", (_name, override) => {
      expect(rules(hostedEnv(override as Partial<ServerEnv>))).toContain(
        "no-placeholder-secrets-in-hosted-environments",
      );
    });

    it("rejects a filler key that decodes to a repeated byte", () => {
      // Buffer.alloc(32, 1) is exactly the kind of value used in tests and examples.
      expect(rules(hostedEnv({ ATLAS_KEK: KEK }))).toContain(
        "no-placeholder-secrets-in-hosted-environments",
      );
    });

    it("permits placeholders in local and preview", () => {
      const local = env({ SUPABASE_SERVICE_ROLE_KEY: "local-dev-placeholder" });
      const preview = env({ ATLAS_ENV: "preview", SUPABASE_SERVICE_ROLE_KEY: "ci-placeholder" });
      expect(rules(local)).not.toContain("no-placeholder-secrets-in-hosted-environments");
      expect(rules(preview)).not.toContain("no-placeholder-secrets-in-hosted-environments");
    });
  });

  describe("R8 hosted environments must have error monitoring configured", () => {
    it.each(["staging", "production"] as const)("requires an endpoint in %s", (target) => {
      const e = hostedEnv({
        ATLAS_ENV: target,
        NEXT_PUBLIC_APP_URL: "https://atlas.app",
        ATLAS_MONITORING_ENDPOINT: undefined,
      });
      expect(rules(e)).toContain("hosted-environment-requires-monitoring");
    });

    it("does not require monitoring locally or in preview", () => {
      // A developer must be able to boot without a collector (ATL-095).
      expect(rules(env())).not.toContain("hosted-environment-requires-monitoring");
      expect(rules(env({ ATLAS_ENV: "preview" }))).not.toContain(
        "hosted-environment-requires-monitoring",
      );
    });
  });

  describe("R9 the monitoring endpoint must be reachable and encrypted", () => {
    it("rejects a plaintext endpoint in a hosted environment", () => {
      const e = hostedEnv({ ATLAS_MONITORING_ENDPOINT: "http://collector.example.com/ingest" });
      expect(rules(e)).toContain("monitoring-endpoint-requires-https");
    });

    it("rejects a loopback endpoint in a hosted environment", () => {
      // Points at nothing once deployed — events would vanish silently.
      const e = hostedEnv({ ATLAS_MONITORING_ENDPOINT: "https://127.0.0.1:9000/ingest" });
      expect(rules(e)).toContain("monitoring-endpoint-must-not-be-loopback");
    });

    it("permits a plaintext loopback collector locally", () => {
      const e = env({ ATLAS_MONITORING_ENDPOINT: "http://127.0.0.1:9000/ingest" });
      expect(findIsolationViolations(e)).toEqual([]);
    });
  });

  describe("R10 the monitoring credential must be its own secret", () => {
    it.each([
      ["SUPABASE_SERVICE_ROLE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service"],
      ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon"],
      ["ANTHROPIC_API_KEY", "sk-ant-api03-realvaluehere"],
      ["RATE_LIMIT_REDIS_TOKEN", "AX9sASQgN2M0"],
    ])("rejects reusing %s as the collector key", (_name, value) => {
      // The collector is a third party. A shared credential would hand it a key
      // that also unlocks Supabase or the AI provider.
      const e = hostedEnv({ ATLAS_MONITORING_KEY: value });
      expect(rules(e)).toContain("monitoring-key-must-be-distinct");
    });

    it("rejects reusing the KEK or the audit HMAC key", () => {
      expect(rules(hostedEnv({ ATLAS_MONITORING_KEY: HOSTED_KEK }))).toContain(
        "monitoring-key-must-be-distinct",
      );
      expect(rules(hostedEnv({ ATLAS_MONITORING_KEY: HOSTED_HMAC }))).toContain(
        "monitoring-key-must-be-distinct",
      );
    });

    it("rejects a placeholder collector key in a hosted environment", () => {
      const e = hostedEnv({ ATLAS_MONITORING_KEY: "changeme" });
      expect(rules(e)).toContain("no-placeholder-secrets-in-hosted-environments");
    });

    it("accepts a distinct, real-looking collector key", () => {
      expect(findIsolationViolations(hostedEnv())).toEqual([]);
    });
  });

  describe("R11 Google OAuth must be configured as a pair", () => {
    it("accepts neither credential — magic link is the primary method", () => {
      // §5 makes Google optional. Absence must not be an error.
      expect(rules(env())).not.toContain("google-oauth-requires-both-credentials");
      expect(rules(hostedEnv())).not.toContain("google-oauth-requires-both-credentials");
    });

    it("accepts both credentials", () => {
      const e = hostedEnv({
        ATLAS_GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.com",
        ATLAS_GOOGLE_CLIENT_SECRET: "GOCSPX-realvaluehere",
      });
      expect(findIsolationViolations(e)).toEqual([]);
    });

    it.each([
      ["only the client ID", { ATLAS_GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.com" }],
      ["only the secret", { ATLAS_GOOGLE_CLIENT_SECRET: "GOCSPX-realvaluehere" }],
    ])("rejects %s", (_label, overrides) => {
      // Half-configured presents a provider that appears available and fails at
      // the consent step, which reads to a user as "sign-in is broken".
      expect(rules(hostedEnv(overrides))).toContain("google-oauth-requires-both-credentials");
    });
  });

  describe("R12 the OAuth secret must be real in hosted environments", () => {
    it("rejects a placeholder secret", () => {
      const e = hostedEnv({
        ATLAS_GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.com",
        ATLAS_GOOGLE_CLIENT_SECRET: "changeme",
      });
      expect(rules(e)).toContain("no-placeholder-secrets-in-hosted-environments");
    });

    it("permits a placeholder locally", () => {
      const e = env({
        ATLAS_GOOGLE_CLIENT_ID: "local-dev-client-id",
        ATLAS_GOOGLE_CLIENT_SECRET: "local-dev-placeholder",
      });
      expect(rules(e)).not.toContain("no-placeholder-secrets-in-hosted-environments");
    });
  });

  describe("R13 the previous KEK must be a complete, distinct, earlier generation", () => {
    const PREVIOUS = Buffer.alloc(32, 5).toString("base64");

    it("accepts neither value — the normal steady state", () => {
      // A previous KEK exists only during a rotation sweep.
      expect(findIsolationViolations(env())).toEqual([]);
    });

    it("accepts a complete, distinct, earlier pair", () => {
      const e = env({
        ATLAS_KEK_VERSION: 2,
        ATLAS_KEK_PREVIOUS: PREVIOUS,
        ATLAS_KEK_PREVIOUS_VERSION: 1,
      });
      expect(findIsolationViolations(e)).toEqual([]);
    });

    it.each([
      ["only the key", { ATLAS_KEK_PREVIOUS: PREVIOUS }],
      ["only the version", { ATLAS_KEK_PREVIOUS_VERSION: 1 }],
    ])("rejects %s", (_label, overrides) => {
      // Either half alone silently disables the rotation fallback.
      expect(rules(env(overrides))).toContain("previous-kek-requires-both-key-and-version");
    });

    it("rejects a previous KEK identical to the current one", () => {
      // A rotation that reuses the key rotates nothing but reports success.
      const e = env({
        ATLAS_KEK_VERSION: 2,
        ATLAS_KEK_PREVIOUS: KEK,
        ATLAS_KEK_PREVIOUS_VERSION: 1,
      });
      expect(rules(e)).toContain("previous-kek-must-differ-from-current");
    });

    it.each([
      ["equal versions", 2, 2],
      ["a version that moves backwards", 1, 2],
    ])("rejects %s", (_label, current, previous) => {
      const e = env({
        ATLAS_KEK_VERSION: current,
        ATLAS_KEK_PREVIOUS: PREVIOUS,
        ATLAS_KEK_PREVIOUS_VERSION: previous,
      });
      expect(rules(e)).toContain("kek-version-must-advance");
    });
  });

  describe("assertEnvironmentIsolation", () => {
    it("does not throw for a sound environment", () => {
      expect(() => assertEnvironmentIsolation(env())).not.toThrow();
    });

    it("throws listing the failed rules", () => {
      const e = env({ NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co" });
      expect(() => assertEnvironmentIsolation(e)).toThrow(/local-must-use-loopback/);
    });

    it("never includes a secret value in the error message", () => {
      // atlas-scan-ignore — synthetic fixture asserting secrets never reach messages
      const secret = "SUPER-SECRET-SERVICE-ROLE-VALUE";
      const e = hostedEnv({
        SUPABASE_SERVICE_ROLE_KEY: secret,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: secret,
      });
      let message = "";
      try {
        assertEnvironmentIsolation(e);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("SUPABASE_SERVICE_ROLE_KEY"); // names the variable
      expect(message).not.toContain(secret); // never the value
    });
  });
});
