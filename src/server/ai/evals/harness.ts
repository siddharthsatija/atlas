/**
 * The deterministic evaluation harness (ATL-051, AI behavior §13).
 *
 * ## Why this runs without a provider
 *
 * B6: assertion-based cases run in CI, live-model cases are a documented
 * pre-release step. CI holds only a placeholder API key, so anything requiring a
 * real completion cannot run there — and a gate that cannot run in CI is not a
 * gate. What *can* run deterministically is the check that matters most for
 * safety: given an output, does it contain something the specification forbids?
 *
 * So the harness is a pure function over recorded outputs. It grades text; it
 * does not generate it. Producing the fixtures is the pre-release step's job.
 *
 * ## Why cases are tagged with a prompt version
 *
 * "Eval set wired to versions" is the acceptance criterion, and the wiring has
 * to bite: publishing `explain-finding-v2` with no cases must fail rather than
 * pass vacuously, because a prompt nobody graded is exactly the thing this
 * ticket exists to prevent shipping.
 *
 * ## What this is not
 *
 * Not a corpus (B8). It holds enough cases to prove the wiring works and that a
 * regression is detected. Each ticket that adds a prompt adds the cases for it —
 * the tickets that know what their surface must never say.
 */

/** A rule an output must satisfy. Assertion-based only: no judgment, no model. */
export interface EvalRule {
  /** Stable identifier, e.g. `no-scanning-claim`. */
  id: string;
  /** Why this rule exists, traced to the specification. */
  rationale: string;
  /** Matching this pattern is a FAILURE. */
  forbidden: RegExp;
}

export interface EvalCase {
  id: string;
  /** The prompt version this case grades, e.g. `explain-finding-v1`. */
  promptId: string;
  /** What the case is probing for. */
  description: string;
  /** A recorded model output to grade. */
  output: string;
  /** Rule ids this case must satisfy. */
  rules: string[];
}

export interface EvalFailure {
  caseId: string;
  ruleId: string;
  rationale: string;
}

export interface EvalReport {
  passed: number;
  failures: EvalFailure[];
  /** Prompt ids that have no cases at all. */
  ungradedPromptIds: string[];
  ok: boolean;
}

export class UnknownEvalRuleError extends Error {
  constructor(caseId: string, ruleId: string) {
    super(`Eval case ${caseId} references unknown rule ${ruleId}`);
    this.name = "UnknownEvalRuleError";
  }
}

export interface RunEvalsInput {
  cases: EvalCase[];
  rules: EvalRule[];
  /**
   * Every prompt id that must be graded.
   *
   * Supplied by the caller from the registry, so a newly published prompt with
   * no cases is a failure rather than an absence nobody noticed.
   */
  requiredPromptIds: string[];
}

/**
 * Grades every case and reports which prompts went ungraded.
 *
 * A case naming a rule that does not exist throws rather than silently grading
 * against nothing — a typo in a rule id would otherwise turn a safety check into
 * a no-op that still reports a pass.
 */
export function runEvals({ cases, rules, requiredPromptIds }: RunEvalsInput): EvalReport {
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const failures: EvalFailure[] = [];
  let passed = 0;

  for (const testCase of cases) {
    let caseFailed = false;

    for (const ruleId of testCase.rules) {
      const rule = rulesById.get(ruleId);
      if (!rule) throw new UnknownEvalRuleError(testCase.id, ruleId);

      if (rule.forbidden.test(testCase.output)) {
        failures.push({ caseId: testCase.id, ruleId: rule.id, rationale: rule.rationale });
        caseFailed = true;
      }
    }

    if (!caseFailed) passed += 1;
  }

  const graded = new Set(cases.map((testCase) => testCase.promptId));
  const ungradedPromptIds = requiredPromptIds.filter((id) => !graded.has(id));

  return {
    passed,
    failures,
    ungradedPromptIds,
    ok: failures.length === 0 && ungradedPromptIds.length === 0,
  };
}
