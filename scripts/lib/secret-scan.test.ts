import { describe, expect, it } from "vitest";
import {
  IGNORE_MARKER,
  isExcludedPath,
  isForbiddenEnvFile,
  looksLikePlaceholder,
  redact,
  scanContent,
  scanFiles,
} from "./secret-scan";

/**
 * ATL-090 — secret scanning.
 *
 * Two failure modes are covered with equal weight: a missed credential (the obvious
 * risk) and a false positive (the subtle one — a noisy scanner gets bypassed, which
 * is how scanning stops working).
 */

const ruleIds = (file: string, content: string) => scanContent(file, content).map((f) => f.rule);

describe("credential detection", () => {
  it.each([
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----"],
    ["aws-access-key", "const k = 'AKIAIOSFODNN7EXAMPLQ'"],
    ["github-token", "token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"],
    ["slack-token", "url = xoxb-1234567890-abcdefghij"],
    ["anthropic-api-key", "ANTHROPIC=sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ"],
  ])("detects %s", (rule, content) => {
    expect(ruleIds("src/app/config.ts", content)).toContain(rule);
  });

  it("detects a Supabase JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345.sIgNaTuRe01";
    expect(ruleIds("src/server/client.ts", `const key = "${jwt}"`)).toContain("jwt-credential");
  });

  it("detects a real 32-byte ATLAS_KEK assignment", () => {
    const realKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 251)).toString(
      "base64",
    );
    expect(ruleIds("deploy.sh", `ATLAS_KEK=${realKey}`)).toContain("atlas-encryption-key");
  });

  it("detects a real AUDIT_HMAC_KEY assignment", () => {
    const realKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 97) % 241)).toString(
      "base64",
    );
    expect(ruleIds("deploy.sh", `AUDIT_HMAC_KEY: "${realKey}"`)).toContain("atlas-encryption-key");
  });

  it("detects a high-entropy value assigned to a secret-named variable", () => {
    const content = `const apiKey = "Zq7Z9pL2xR4tV6yB8nM0kJ3hG5fD1sA7wE";`;
    expect(ruleIds("src/lib/thing.ts", content)).toContain("generic-secret-assignment");
  });

  it("reports file and line", () => {
    const content = `line one\nline two\nconst k = "AKIAIOSFODNN7EXAMPLQ";`;
    const [finding] = scanContent("src/a.ts", content);
    expect(finding?.file).toBe("src/a.ts");
    expect(finding?.line).toBe(3);
  });
});

describe("the scanner never reproduces a secret", () => {
  it("redacts the matched value", () => {
    const secret = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";
    const [finding] = scanContent("src/a.ts", `token: ${secret}`);
    expect(finding?.excerpt).not.toContain(secret);
    expect(finding?.excerpt).toContain("redacted");
  });

  it("redact() keeps only a short prefix", () => {
    expect(redact("abcdefghijklmnop")).toBe("abcdefgh… (16 chars, redacted)");
  });
});

describe("false-positive suppression", () => {
  it.each([
    "ci-placeholder-service-role-key",
    "your-key-here",
    "changeme",
    "local-dev-placeholder",
    "test-key-value",
  ])("treats %s as a placeholder", (value) => {
    expect(looksLikePlaceholder(value)).toBe(true);
  });

  it("treats a base64 value decoding to a repeated byte as filler", () => {
    expect(looksLikePlaceholder(Buffer.alloc(32, 1).toString("base64"))).toBe(true);
  });

  it("treats base64 that decodes to placeholder text as a placeholder", () => {
    const encoded = Buffer.from("ci-placeholder-kek-32-bytes-ok!!").toString("base64");
    expect(looksLikePlaceholder(encoded)).toBe(true);
  });

  it("does not flag the CI placeholder keys used in workflows", () => {
    const workflow = `          ATLAS_KEK: Y2ktcGxhY2Vob2xkZXIta2VrLTMyLWJ5dGVzLW9rISE=`;
    expect(scanContent(".github/workflows/ci.yml", workflow)).toEqual([]);
  });

  it("honours an inline ignore marker on the same line", () => {
    const content = `const k = "AKIAIOSFODNN7EXAMPLQ"; // ${IGNORE_MARKER} documented fixture`;
    expect(scanContent("src/a.ts", content)).toEqual([]);
  });

  it("honours an ignore marker on the preceding line", () => {
    const content = `// ${IGNORE_MARKER} documented fixture\nconst k = "AKIAIOSFODNN7EXAMPLQ";`;
    expect(scanContent("src/a.ts", content)).toEqual([]);
  });

  it("excludes the documented placeholder file", () => {
    expect(isExcludedPath(".env.example")).toBe(true);
    expect(isExcludedPath("src/app/page.tsx")).toBe(false);
  });

  it("produces no findings across ordinary source", () => {
    const content = [
      'import { cn } from "@/lib/utils";',
      'export const NAV = ["overview", "assets"] as const;',
      "export const MAILTO_SAFE_LENGTH = 1800;",
    ].join("\n");
    expect(scanContent("src/config/app.ts", content)).toEqual([]);
  });
});

describe("committed environment files", () => {
  it.each([".env", ".env.local", ".env.production", "apps/web/.env.staging"])(
    "rejects %s",
    (path) => {
      expect(isForbiddenEnvFile(path)).toBe(true);
    },
  );

  it("permits .env.example", () => {
    expect(isForbiddenEnvFile(".env.example")).toBe(false);
  });

  it("reports a committed env file without reading its contents", () => {
    const [finding] = scanFiles([
      { file: ".env.local", content: "SUPABASE_SERVICE_ROLE_KEY=real" },
    ]);
    expect(finding?.rule).toBe("committed-env-file");
    expect(finding?.excerpt).not.toContain("real");
  });
});

describe("scanFiles", () => {
  it("aggregates findings across files", () => {
    const findings = scanFiles([
      { file: "a.ts", content: "const k = 'AKIAIOSFODNN7EXAMPLQ'" },
      { file: "b.ts", content: "export const safe = 1;" },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("a.ts");
  });
});
