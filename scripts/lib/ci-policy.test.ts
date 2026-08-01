import { describe, expect, it } from "vitest";
import {
  ALLOWED_SECRET_REFERENCES,
  REQUIRED_GATES,
  findForbiddenSecretReferences,
  findMissingGates,
  runsOnPullRequest,
  validateCiPolicy,
} from "./ci-policy";

/** ATL-004 — "CI has no access to production secrets" and "all §19 gates run on PRs". */

/**
 * A workflow containing every required gate command, triggered by pull_request.
 * `omit` drops a gate so its absence can be asserted.
 */
function completeWorkflow(omit?: string): string {
  return [
    "on:",
    "  pull_request:",
    "jobs:",
    "  gates:",
    "    steps:",
    ...REQUIRED_GATES.flatMap((g) => g.commands)
      .filter((command) => command !== omit)
      .map((command) => `      - run: pnpm ${command}`),
    "",
  ].join("\n");
}

describe("forbidden secret references", () => {
  it("allows the automatically minted GITHUB_TOKEN", () => {
    const content = "env:\n  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}";
    expect(findForbiddenSecretReferences("security.yml", content)).toEqual([]);
  });

  it.each([
    "SUPABASE_SERVICE_ROLE_KEY",
    "ATLAS_KEK",
    "AUDIT_HMAC_KEY",
    "ANTHROPIC_API_KEY",
    "PRODUCTION_DATABASE_URL",
  ])("rejects secrets.%s", (name) => {
    const content = `env:\n  VALUE: \${{ secrets.${name} }}`;
    const violations = findForbiddenSecretReferences("ci.yml", content);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("forbidden-secret-reference");
    expect(violations[0]?.message).toContain(name);
  });

  it("reports each distinct secret once", () => {
    const content = `\${{ secrets.ATLAS_KEK }} \${{ secrets.ATLAS_KEK }} \${{ secrets.OTHER }}`;
    expect(findForbiddenSecretReferences("ci.yml", content)).toHaveLength(2);
  });

  it("tolerates whitespace variations in the expression", () => {
    expect(findForbiddenSecretReferences("ci.yml", "${{secrets.ATLAS_KEK}}")).toHaveLength(1);
    expect(findForbiddenSecretReferences("ci.yml", "${{   secrets.ATLAS_KEK   }}")).toHaveLength(1);
  });

  it("keeps the allowlist deliberately minimal", () => {
    expect([...ALLOWED_SECRET_REFERENCES]).toEqual(["GITHUB_TOKEN"]);
  });
});

describe("pull request trigger detection", () => {
  it.each(["on:\n  pull_request:", "on:\n  pull_request_target:"])("detects %s", (content) => {
    expect(runsOnPullRequest(content)).toBe(true);
  });

  it("does not treat workflow_dispatch as a pull request trigger", () => {
    expect(runsOnPullRequest("on:\n  workflow_dispatch:")).toBe(false);
  });
});

describe("required gate coverage", () => {
  it("accepts a workflow set covering every §19 gate on pull requests", () => {
    expect(findMissingGates([{ file: "ci.yml", content: completeWorkflow() }])).toEqual([]);
  });

  it("reports a gate that no workflow runs", () => {
    const violations = findMissingGates([
      { file: "ci.yml", content: completeWorkflow("db:validate-migrations") },
    ]);
    expect(violations.map((v) => v.rule)).toContain("missing-required-gate");
    expect(violations[0]?.message).toContain("Migration validation");
  });

  it("reports a gate that runs only on manual dispatch", () => {
    const dispatchOnly =
      "on:\n  workflow_dispatch:\njobs:\n  x:\n    steps:\n      - run: pnpm test:a11y";
    const prWorkflow = completeWorkflow("test:a11y");
    const violations = findMissingGates([
      { file: "ci.yml", content: prWorkflow },
      { file: "accessibility.yml", content: dispatchOnly },
    ]);
    expect(violations.map((v) => v.rule)).toContain("gate-not-on-pull-request");
  });

  it("accepts gates spread across several pull-request workflows", () => {
    const all = REQUIRED_GATES.flatMap((g) => g.commands);
    const build = (commands: readonly string[]) =>
      [
        "on:",
        "  pull_request:",
        "jobs:",
        "  j:",
        "    steps:",
        ...commands.map((command) => `      - run: pnpm ${command}`),
      ].join("\n");

    expect(
      findMissingGates([
        { file: "a.yml", content: build(all.slice(0, 4)) },
        { file: "b.yml", content: build(all.slice(4)) },
      ]),
    ).toEqual([]);
  });

  it("covers every gate listed in architecture §19", () => {
    expect(REQUIRED_GATES.map((g) => g.gate)).toEqual([
      "Formatting",
      "Lint",
      "Type check",
      "Unit tests",
      "Integration tests",
      "Production build",
      "Migration validation",
      "Dependency and secret scanning",
      "Accessibility smoke tests",
    ]);
  });
});

describe("validateCiPolicy", () => {
  it("returns no violations for a compliant workflow set", () => {
    expect(validateCiPolicy([{ file: "ci.yml", content: completeWorkflow() }])).toEqual([]);
  });

  it("combines secret and gate violations", () => {
    const content = `${completeWorkflow()}\n      - run: echo \${{ secrets.ATLAS_KEK }}`;
    const violations = validateCiPolicy([{ file: "ci.yml", content }]);
    expect(violations.map((v) => v.rule)).toContain("forbidden-secret-reference");
  });
});
