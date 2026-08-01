/**
 * Dependency audit policy (ATL-090).
 *
 * `pnpm audit` reports advisories; this decides which of them block a merge.
 *
 * It replaces pnpm's `auditConfig.ignoreGhsas`, which suppresses an advisory so
 * completely that `pnpm audit --json` reports zero findings. An accepted risk that
 * is invisible has no expiry, no owner, and no review trigger — it silently becomes
 * permanent. Exceptions here are explicit, owned, and **time-boxed**: an expired
 * exception fails the build, forcing a re-decision.
 *
 * Pure functions over a parsed audit report so the policy is unit-testable without
 * running an audit.
 */

export type Severity = "info" | "low" | "moderate" | "high" | "critical";

/** Severities that block a merge (ticket: "critical findings block merge"). */
export const BLOCKING_SEVERITIES: Severity[] = ["high", "critical"];

export interface Advisory {
  /** GitHub advisory identifier, e.g. GHSA-xxxx-xxxx-xxxx. */
  id: string;
  severity: Severity;
  module: string;
  title: string;
  /** Dependency path, e.g. `.>eslint>minimatch>brace-expansion`. */
  paths: string[];
  vulnerableVersions?: string;
  patchedVersions?: string;
}

/**
 * A documented, time-boxed acceptance of a specific advisory.
 * Every field is required: an exception without a reason, owner, or expiry is not
 * a decision, it is an omission.
 */
export interface DependencyException {
  id: string;
  reason: string;
  /** Who accepted the risk. */
  acceptedBy: string;
  /** ISO date (YYYY-MM-DD). After this date the exception stops applying. */
  expires: string;
  /** Ticket or issue tracking the permanent fix. */
  tracking: string;
}

export type ViolationRule =
  "blocking-advisory" | "expired-exception" | "stale-exception" | "malformed-exception";

export interface DependencyViolation {
  rule: ViolationRule;
  id: string;
  message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateExceptions(exceptions: DependencyException[]): DependencyViolation[] {
  const violations: DependencyViolation[] = [];

  for (const exception of exceptions) {
    const missing = (["id", "reason", "acceptedBy", "expires", "tracking"] as const).filter(
      (field) => {
        const value = exception[field];
        return typeof value !== "string" || value.trim() === "";
      },
    );

    if (missing.length > 0) {
      violations.push({
        rule: "malformed-exception",
        id: exception.id || "(unnamed)",
        message: `Exception is missing required field(s): ${missing.join(", ")}. An accepted risk needs a reason, an owner, an expiry, and a tracking reference.`,
      });
      continue;
    }

    if (!ISO_DATE.test(exception.expires)) {
      violations.push({
        rule: "malformed-exception",
        id: exception.id,
        message: `"expires" must be an ISO date (YYYY-MM-DD), got "${exception.expires}".`,
      });
    }
  }

  return violations;
}

function isExpired(exception: DependencyException, now: Date): boolean {
  // Compare date-only, treating the expiry as end-of-day UTC.
  const expiry = new Date(`${exception.expires}T23:59:59.999Z`);
  return now.getTime() > expiry.getTime();
}

export interface EvaluateOptions {
  advisories: Advisory[];
  exceptions: DependencyException[];
  now: Date;
}

/**
 * Returns everything that should block the build.
 *
 * Blocks when:
 *   - a high or critical advisory has no matching exception
 *   - a matching exception has expired
 *   - an exception is malformed
 *   - an exception no longer matches any advisory (stale — must be removed so the
 *     next real occurrence is not silently pre-accepted)
 */
export function evaluateDependencyPolicy(options: EvaluateOptions): DependencyViolation[] {
  const { advisories, exceptions, now } = options;

  const malformed = validateExceptions(exceptions);
  if (malformed.length > 0) return malformed;

  const violations: DependencyViolation[] = [];
  const byId = new Map(exceptions.map((e) => [e.id, e]));
  const matched = new Set<string>();

  for (const advisory of advisories) {
    if (!BLOCKING_SEVERITIES.includes(advisory.severity)) continue;

    const exception = byId.get(advisory.id);

    if (exception === undefined) {
      violations.push({
        rule: "blocking-advisory",
        id: advisory.id,
        message:
          `${advisory.severity.toUpperCase()} advisory in "${advisory.module}": ${advisory.title}. ` +
          `Path: ${advisory.paths[0] ?? "unknown"}. ` +
          (advisory.patchedVersions ? `Patched in ${advisory.patchedVersions}. ` : "") +
          `Remediate, or add a time-boxed exception (.github/SECURITY.md).`,
      });
      continue;
    }

    matched.add(exception.id);

    if (isExpired(exception, now)) {
      violations.push({
        rule: "expired-exception",
        id: advisory.id,
        message:
          `Exception for ${advisory.id} expired on ${exception.expires} and must be re-decided. ` +
          `Original reason: ${exception.reason} (accepted by ${exception.acceptedBy}, tracking ${exception.tracking}).`,
      });
    }
  }

  for (const exception of exceptions) {
    if (matched.has(exception.id)) continue;
    violations.push({
      rule: "stale-exception",
      id: exception.id,
      message:
        `Exception for ${exception.id} no longer matches any advisory — the issue appears resolved. ` +
        `Remove it so a future occurrence is not silently pre-accepted.`,
    });
  }

  return violations;
}

/**
 * Normalises `pnpm audit --json` output into `Advisory[]`.
 * Tolerates an empty or shapeless report rather than throwing: an unreadable audit
 * must surface as a clear failure upstream, not a crash here.
 */
export function parseAuditReport(raw: unknown): Advisory[] {
  if (typeof raw !== "object" || raw === null) return [];
  const advisories = (raw as { advisories?: unknown }).advisories;
  if (typeof advisories !== "object" || advisories === null) return [];

  const result: Advisory[] = [];

  for (const value of Object.values(advisories as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;

    const id =
      typeof entry["github_advisory_id"] === "string"
        ? entry["github_advisory_id"]
        : typeof entry["url"] === "string"
          ? (/GHSA-[a-z0-9-]+/i.exec(entry["url"])?.[0] ?? "")
          : "";

    const findings = Array.isArray(entry["findings"]) ? entry["findings"] : [];
    const paths = findings.flatMap((finding) =>
      typeof finding === "object" &&
      finding !== null &&
      Array.isArray((finding as { paths?: unknown }).paths)
        ? (finding as { paths: unknown[] }).paths.filter((p): p is string => typeof p === "string")
        : [],
    );

    result.push({
      id: id || `UNKNOWN-${String(entry["module_name"] ?? "advisory")}`,
      severity: (typeof entry["severity"] === "string" ? entry["severity"] : "info") as Severity,
      module: typeof entry["module_name"] === "string" ? entry["module_name"] : "unknown",
      title: typeof entry["title"] === "string" ? entry["title"] : "(no title)",
      paths,
      ...(typeof entry["vulnerable_versions"] === "string"
        ? { vulnerableVersions: entry["vulnerable_versions"] }
        : {}),
      ...(typeof entry["patched_versions"] === "string"
        ? { patchedVersions: entry["patched_versions"] }
        : {}),
    });
  }

  return result;
}
