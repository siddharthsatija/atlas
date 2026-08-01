/**
 * CI policy checks (ATL-004).
 *
 * Two acceptance criteria are asserted here rather than assumed:
 *
 *   1. "CI has no access to production secrets" — workflows may reference only the
 *      token GitHub injects automatically, plus an explicit allowlist. Anything else
 *      means a real credential was wired into CI (security §9: separate secrets per
 *      environment; CI has no access to production secrets).
 *
 *   2. "All gates from architecture §19 run on PRs" — the required commands must
 *      actually appear in a workflow triggered by `pull_request`.
 *
 * Pure functions over workflow text so they are unit-testable without GitHub.
 */

export interface CiPolicyViolation {
  rule: "forbidden-secret-reference" | "missing-required-gate" | "gate-not-on-pull-request";
  file: string;
  message: string;
}

/**
 * Secrets CI is permitted to reference.
 *
 * `GITHUB_TOKEN` is minted per run by GitHub and scoped by the workflow's
 * `permissions:` block — it is not an Atlas credential. Nothing else is allowed:
 * Atlas CI builds and tests with non-secret placeholders (see the workflow env
 * blocks), so a `secrets.*` reference would mean a real credential entered CI.
 */
export const ALLOWED_SECRET_REFERENCES = new Set(["GITHUB_TOKEN"]);

const SECRET_REFERENCE = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g;

export function findForbiddenSecretReferences(file: string, content: string): CiPolicyViolation[] {
  const violations: CiPolicyViolation[] = [];
  const reported = new Set<string>();

  for (const match of content.matchAll(SECRET_REFERENCE)) {
    const name = match[1];
    if (name === undefined || ALLOWED_SECRET_REFERENCES.has(name) || reported.has(name)) {
      continue;
    }
    reported.add(name);
    violations.push({
      rule: "forbidden-secret-reference",
      file,
      message:
        `References secrets.${name}. CI must not have access to production secrets ` +
        `(security §9). Builds and tests use non-secret placeholders; if this value is ` +
        `genuinely required, add it to ALLOWED_SECRET_REFERENCES with a documented reason.`,
    });
  }
  return violations;
}

/**
 * The gate list is architecture §19. Each entry names the command that proves the
 * gate runs, so renaming a script without updating CI is caught.
 */
export const REQUIRED_GATES = [
  { gate: "Formatting", commands: ["format:check"] },
  { gate: "Lint", commands: ["lint"] },
  { gate: "Type check", commands: ["typecheck"] },
  { gate: "Unit tests", commands: ["test"] },
  { gate: "Integration tests", commands: ["test:integration"] },
  { gate: "Production build", commands: ["build"] },
  { gate: "Migration validation", commands: ["db:validate-migrations"] },
  // §19 lists this as one gate; Atlas implements it as two scans (ATL-090), and
  // both must run for the gate to be satisfied.
  { gate: "Dependency and secret scanning", commands: ["scan:secrets", "deps:verify"] },
  { gate: "Accessibility smoke tests", commands: ["test:a11y"] },
] as const;

export interface WorkflowFile {
  file: string;
  content: string;
}

/** True when the workflow is triggered by pull requests. */
export function runsOnPullRequest(content: string): boolean {
  // Matches `pull_request:` or `pull_request_target:` as a trigger key.
  return /^\s{2}pull_request(_target)?:/m.test(content);
}

/**
 * Verifies every §19 gate appears in at least one workflow that runs on pull
 * requests. A gate present only in a manually dispatched workflow does not block a
 * merge and therefore does not satisfy the criterion.
 */
export function findMissingGates(workflows: WorkflowFile[]): CiPolicyViolation[] {
  const prWorkflows = workflows.filter((w) => runsOnPullRequest(w.content));
  const violations: CiPolicyViolation[] = [];

  for (const { gate, commands } of REQUIRED_GATES) {
    for (const command of commands) {
      const onPr = prWorkflows.some((w) => w.content.includes(command));
      if (onPr) continue;

      const anywhere = workflows.find((w) => w.content.includes(command));
      violations.push(
        anywhere
          ? {
              rule: "gate-not-on-pull-request",
              file: anywhere.file,
              message: `Gate "${gate}" (${command}) exists but does not run on pull requests, so it cannot block a merge (architecture §19).`,
            }
          : {
              rule: "missing-required-gate",
              file: ".github/workflows",
              message: `Gate "${gate}" (${command}) is required by architecture §19 but no workflow runs it.`,
            },
      );
    }
  }
  return violations;
}

export function validateCiPolicy(workflows: WorkflowFile[]): CiPolicyViolation[] {
  return [
    ...workflows.flatMap((w) => findForbiddenSecretReferences(w.file, w.content)),
    ...findMissingGates(workflows),
  ];
}
