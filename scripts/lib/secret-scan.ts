/**
 * First-party secret scanner (ATL-090).
 *
 * Complements `gitleaks` in CI rather than replacing it. Two reasons it exists:
 *
 *   1. **Verifiability.** The ticket requires a fixture proving the gate blocks.
 *      A scanner that runs locally can be exercised by `pnpm gates:verify`;
 *      a third-party action can only be observed after the fact.
 *   2. **Atlas-specific secrets.** Generic scanners do not know about `ATLAS_KEK`
 *      (ADR-003), `AUDIT_HMAC_KEY` (ADR-006), or Supabase service-role JWTs — the
 *      credentials whose exposure would matter most here (security §3 Restricted).
 *
 * Design constraint: **false positives are a security failure**, because a noisy
 * scanner gets bypassed. Values that are obviously placeholders are therefore not
 * reported, and every finding can be suppressed with an auditable inline marker.
 *
 * Pure functions — no I/O — so the rules are exhaustively unit-testable.
 */

export type SecretSeverity = "critical" | "high";

export interface SecretRule {
  id: string;
  description: string;
  severity: SecretSeverity;
  pattern: RegExp;
}

export interface SecretFinding {
  rule: string;
  severity: SecretSeverity;
  file: string;
  line: number;
  description: string;
  /** Redacted excerpt: the match is never reproduced in full. */
  excerpt: string;
}

/** Suppresses a finding on the same line or the line immediately above. */
export const IGNORE_MARKER = "atlas-scan-ignore";

/**
 * Paths excluded from scanning.
 *
 * `.env.example` holds documented placeholders; this module and its test contain
 * the patterns themselves; the runbook documents example credentials.
 */
export const EXCLUDED_PATHS = [
  ".env.example",
  "scripts/lib/secret-scan.ts",
  "scripts/lib/secret-scan.test.ts",
  ".github/SECURITY.md",
  "pnpm-lock.yaml",
] as const;

/**
 * Substrings marking a value as a deliberate non-secret. Kept in sync in spirit with
 * `src/config/environment-isolation.ts`, which rejects these in hosted environments.
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
  "test-",
  "fixture",
  "sample",
  "redacted",
  "not-a-real",
  "must-not-leak",
];

export function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))) return true;

  // A base64 value decoding to one repeated byte is filler (e.g. Buffer.alloc).
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length >= 16 && decoded.every((byte) => byte === decoded[0])) return true;
    // Decoded ASCII text that itself reads as a placeholder.
    const text = decoded.toString("utf8");
    if (
      /^[\x20-\x7e]+$/.test(text) &&
      PLACEHOLDER_MARKERS.some((m) => text.toLowerCase().includes(m))
    ) {
      return true;
    }
  } catch {
    /* not base64 */
  }
  return false;
}

export const SECRET_RULES: SecretRule[] = [
  {
    id: "private-key",
    description: "Private key block",
    severity: "critical",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: "aws-access-key",
    description: "AWS access key id",
    severity: "critical",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: "github-token",
    description: "GitHub personal access or app token",
    severity: "critical",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: "slack-token",
    description: "Slack token",
    severity: "high",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "anthropic-api-key",
    description: "Anthropic API key (security §10)",
    severity: "critical",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "jwt-credential",
    description: "JSON Web Token — a Supabase anon or service-role key",
    severity: "critical",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "atlas-encryption-key",
    description: "ATLAS_KEK or AUDIT_HMAC_KEY assigned a real 32-byte value (ADR-003, ADR-006)",
    severity: "critical",
    pattern: /\b(?:ATLAS_KEK|AUDIT_HMAC_KEY)\s*[:=]\s*["']?([A-Za-z0-9+/]{42,}={0,2})["']?/g,
  },
  {
    id: "generic-secret-assignment",
    description: "High-entropy value assigned to a secret-named variable",
    severity: "high",
    pattern:
      /\b(?:api[_-]?key|secret|password|passwd|token|credential|service[_-]?role[_-]?key)\s*[:=]\s*["']([A-Za-z0-9/+=_-]{24,})["']/gi,
  },
];

function isIgnored(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const previous = index > 0 ? (lines[index - 1] ?? "") : "";
  return current.includes(IGNORE_MARKER) || previous.includes(IGNORE_MARKER);
}

/** Shows only enough of a match to locate it. The value itself is never emitted. */
export function redact(match: string): string {
  const visible = match.slice(0, 8);
  return `${visible}… (${match.length} chars, redacted)`;
}

export function isExcludedPath(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  return EXCLUDED_PATHS.some(
    (excluded) => normalized === excluded || normalized.endsWith(`/${excluded}`),
  );
}

export function scanContent(file: string, content: string): SecretFinding[] {
  if (isExcludedPath(file)) return [];

  const lines = content.split("\n");
  const findings: SecretFinding[] = [];

  for (const rule of SECRET_RULES) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (isIgnored(lines, i)) continue;

      // Fresh regex per line: the shared rules are global and stateful.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(line)) !== null) {
        // Prefer the captured value when the rule captures one.
        const value = match[1] ?? match[0];
        if (looksLikePlaceholder(value) || looksLikePlaceholder(line)) continue;

        findings.push({
          rule: rule.id,
          severity: rule.severity,
          file,
          line: i + 1,
          description: rule.description,
          excerpt: redact(value),
        });
      }
    }
  }

  return findings;
}

/** A committed `.env` file is a violation regardless of contents (security §9). */
export function isForbiddenEnvFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return /^\.env(\..+)?$/.test(name) && name !== ".env.example";
}

export interface ScanTarget {
  file: string;
  content: string;
}

export function scanFiles(targets: ScanTarget[]): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const target of targets) {
    if (isForbiddenEnvFile(target.file)) {
      findings.push({
        rule: "committed-env-file",
        severity: "critical",
        file: target.file,
        line: 1,
        description: "Environment files are never committed (security §9)",
        excerpt: "(file contents not read)",
      });
      continue;
    }
    findings.push(...scanContent(target.file, target.content));
  }

  return findings;
}
