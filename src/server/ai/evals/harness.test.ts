import { describe, expect, it } from "vitest";
import { runEvals, UnknownEvalRuleError, type EvalCase, type EvalRule } from "./harness";
import { EVAL_CASES, EVAL_RULES, EXPECTED_FAILING_CASE_IDS, REGRESSION_CASES } from "./cases";

/**
 * ATL-051 — the evaluation harness smoke run.
 *
 * Two properties are being established. First, that the harness **detects**
 * violations rather than reporting a comfortable pass: the probe cases are
 * recorded outputs that must fail, and a harness that passed them would be worse
 * than no harness, because it would certify prompts as safe. Second, that the
 * suite is **wired to versions** — a published prompt with no cases fails.
 */

const rule = (id: string, forbidden: RegExp): EvalRule => ({
  id,
  rationale: `test rule ${id}`,
  forbidden,
});

const testCase = (overrides: Partial<EvalCase> = {}): EvalCase => ({
  id: "case-1",
  promptId: "explain-finding-v1",
  description: "test",
  output: "a calm, grounded sentence",
  rules: ["forbid-boom"],
  ...overrides,
});

const RULES = [rule("forbid-boom", /boom/i)];

describe("grading", () => {
  it("passes an output that violates nothing", () => {
    const report = runEvals({
      cases: [testCase()],
      rules: RULES,
      requiredPromptIds: ["explain-finding-v1"],
    });

    expect(report.ok).toBe(true);
    expect(report.passed).toBe(1);
  });

  it("fails an output that matches a forbidden pattern", () => {
    const report = runEvals({
      cases: [testCase({ output: "BOOM, everything is gone" })],
      rules: RULES,
      requiredPromptIds: ["explain-finding-v1"],
    });

    expect(report.ok).toBe(false);
    expect(report.failures[0]).toMatchObject({ caseId: "case-1", ruleId: "forbid-boom" });
  });

  it("reports the rationale with the failure", () => {
    // A failing eval that does not say why teaches people to delete the case.
    const report = runEvals({
      cases: [testCase({ output: "boom" })],
      rules: RULES,
      requiredPromptIds: [],
    });

    expect(report.failures[0]?.rationale).toBeTruthy();
  });

  it("counts a case once even when it breaks several rules", () => {
    const report = runEvals({
      cases: [testCase({ output: "boom and bang", rules: ["forbid-boom", "forbid-bang"] })],
      rules: [...RULES, rule("forbid-bang", /bang/i)],
      requiredPromptIds: [],
    });

    expect(report.passed).toBe(0);
    expect(report.failures).toHaveLength(2);
  });

  it("throws on a case naming a rule that does not exist", () => {
    /**
     * A typo in a rule id would otherwise turn a safety check into a silent
     * no-op that still reports a pass — the worst available outcome.
     */
    expect(() =>
      runEvals({
        cases: [testCase({ rules: ["forbid-typo"] })],
        rules: RULES,
        requiredPromptIds: [],
      }),
    ).toThrow(UnknownEvalRuleError);
  });
});

describe("the suite is wired to prompt versions", () => {
  it("fails when a required prompt has no cases", () => {
    // Publishing explain-finding-v2 without grading it must not pass vacuously.
    const report = runEvals({
      cases: [testCase()],
      rules: RULES,
      requiredPromptIds: ["explain-finding-v1", "explain-finding-v2"],
    });

    expect(report.ok).toBe(false);
    expect(report.ungradedPromptIds).toEqual(["explain-finding-v2"]);
  });

  it("passes when every required prompt is graded", () => {
    const report = runEvals({
      cases: [testCase()],
      rules: RULES,
      requiredPromptIds: ["explain-finding-v1"],
    });

    expect(report.ungradedPromptIds).toEqual([]);
  });
});

describe("the real suite", () => {
  it("passes every regression case", () => {
    const report = runEvals({
      cases: REGRESSION_CASES,
      rules: EVAL_RULES,
      requiredPromptIds: ["explain-finding-v1"],
    });

    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("catches every probe case", () => {
    /**
     * The assertion that proves the rules bite. A suite of only clean cases
     * passes even when every rule is broken.
     */
    for (const caseId of EXPECTED_FAILING_CASE_IDS) {
      const probe = EVAL_CASES.find((entry) => entry.id === caseId);
      expect(probe, `missing probe case ${caseId}`).toBeDefined();

      const report = runEvals({
        cases: [probe as EvalCase],
        rules: EVAL_RULES,
        requiredPromptIds: [],
      });

      expect(report.failures.length, `${caseId} was not caught`).toBeGreaterThan(0);
    }
  });

  it("grades the prompt version the registry actually publishes", () => {
    // The link between the eval suite and the registry. If the active prompt is
    // repointed to v2, this fails until v2 has cases.
    expect(EVAL_CASES.every((entry) => entry.promptId === "explain-finding-v1")).toBe(true);
  });

  it("gives every rule a traceable rationale", () => {
    for (const evalRule of EVAL_RULES) {
      expect(evalRule.rationale).toMatch(/§|CLAUDE\.md/);
    }
  });
});
