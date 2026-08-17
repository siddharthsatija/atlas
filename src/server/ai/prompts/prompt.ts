/**
 * Prompt registry types (ATL-051, architecture §12, `docs/07-ai-behavior.md`).
 *
 * ## Three parts, and this module owns two of them
 *
 * A prompt is assembled server-side from:
 *
 *   1. **System policy** — fixed, version-controlled, never user-influenced.
 *   2. **Task template** — per-purpose instructions plus the output shape.
 *   3. **Context block** — retrieved records, redacted, delimited as untrusted.
 *
 * ATL-051 owns 1 and 2. **Part 3 is ATL-049's** and never appears here: the
 * registry returns a prompt with a place for context, never a prompt containing
 * context.
 *
 * ## Nothing here interpolates
 *
 * Registered prompts are static text. There is no function that takes a user
 * value and returns a prompt string, because that function is how an asset note
 * becomes an instruction. A test asserts every registered prompt is free of
 * placeholder syntax, which makes "user data cannot reach the system policy" a
 * property of the registry rather than a rule call sites must remember.
 *
 * ## Why the policy is versioned separately
 *
 * The policy is a different contract from a task template: it carries the
 * refusal list, the tone rules and the untrusted-data framing that every purpose
 * shares. Inlining it into each prompt would duplicate safety rules once per
 * purpose and guarantee they drift. So it is its own append-only artefact, and a
 * prompt adopts a newer policy only by publishing a new prompt version that pins
 * it — which keeps any historical interaction fully reproducible from its two
 * recorded version numbers.
 */

/**
 * The purposes the policy layer may classify a request as (ATL-049,
 * `.claude/skills/ai/SKILL.md`). Registering a prompt for a purpose does not
 * make it available — ATL-049 owns the data-selection policy that decides what
 * each purpose may retrieve.
 */
export const AI_PURPOSES = [
  "explain_finding",
  "summarize_asset",
  "explain_score",
  "recommend_action",
  "draft_request",
  "product_question",
] as const;

export type AiPurpose = (typeof AI_PURPOSES)[number];

/**
 * Output schema identifiers, per AI behavior §7.
 *
 * Declared here rather than in ATL-050 so there is **one** source of truth for
 * the name. ATL-050 implements the Zod shapes keyed by these identifiers and can
 * assert that every identifier the registry names has an implementation — the
 * check that catches a prompt describing a field its validator does not expect,
 * which would otherwise surface as every call failing validation in production.
 */
export const SCHEMA_IDS = ["explanation", "draft", "asset_summary"] as const;

export type SchemaId = (typeof SCHEMA_IDS)[number];

/** `slug-vN`: lowercase words joined by hyphens, then an explicit version. */
export const PROMPT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]*$/;

/**
 * Placeholder syntaxes a prompt must never contain.
 *
 * Covers the three ways a template accidentally becomes interpolated: a
 * JavaScript template expression, a handlebars/mustache pair, and a printf-style
 * marker. Matching any of these means the prompt was written expecting a value
 * to be substituted, which is exactly what must not happen.
 */
export const PLACEHOLDER_PATTERN = /\$\{|\{\{|%s\b/;

export interface SystemPolicy {
  readonly policyVersion: number;
  readonly text: string;
}

export interface PromptDefinition {
  /** `explain-finding-v1`. Stable, and recorded against every interaction. */
  readonly promptId: string;
  readonly purpose: AiPurpose;
  readonly promptVersion: number;
  /** The policy generation this prompt was written and evaluated against. */
  readonly policyVersion: number;
  readonly schemaId: SchemaId;
  readonly schemaVersion: number;
  /** Per-purpose instructions and the described output shape. Static text. */
  readonly taskTemplate: string;
  /**
   * Fixed guidance appended on the second attempt after schema-invalid output
   * (ATL-050).
   *
   * It lives here rather than at the call site for the same reason every other
   * prompt string does: an inline repair string is a prompt nobody versioned and
   * nobody evaluated. Because it is part of the version file, changing it
   * requires a version bump like any other wording change.
   *
   * **It must remain fixed.** No user data, no echo of the invalid completion,
   * no validation-error detail and no provider message may be interpolated into
   * it — a repair instruction quoting the model's own bad output is a channel
   * for injected text to re-enter the prompt as instruction. It may name the
   * expected structure, because that is fixed and already stated in the task
   * template.
   */
  readonly repairInstruction: string;
}

/**
 * What a caller receives. Metadata travels **with** the text.
 *
 * ATL-051 owns no persistence (B3): the versions are carried here so the ticket
 * that eventually owns `ai_interactions` can record what actually produced an
 * output. A caller that had to look the version up separately would eventually
 * record one prompt's version against another prompt's output.
 */
export interface ResolvedPrompt {
  readonly promptId: string;
  readonly purpose: AiPurpose;
  readonly promptVersion: number;
  readonly policyVersion: number;
  readonly schemaId: SchemaId;
  readonly schemaVersion: number;
  /** Policy followed by task template — the string the gateway receives. */
  readonly system: string;
  /** The task portion alone, so evals can assert on it without the policy. */
  readonly taskTemplate: string;
  /** Fixed second-attempt guidance (ATL-050). Never interpolated. */
  readonly repairInstruction: string;
}

/** Freezes a policy so a published generation cannot be mutated at runtime. */
export function defineSystemPolicy(policy: SystemPolicy): SystemPolicy {
  return Object.freeze({ ...policy });
}

/**
 * Freezes a prompt definition.
 *
 * The file-level append-only gate (`scripts/verify-prompts.mts`) is what stops a
 * *published* version being edited in the repository; `Object.freeze` stops it
 * being edited in a running process. Both are cheap, and they fail at different
 * times.
 */
export function definePrompt(definition: PromptDefinition): PromptDefinition {
  return Object.freeze({ ...definition });
}

/** Assembles policy and task template into the string the gateway sends. */
export function assembleSystem(policy: SystemPolicy, prompt: PromptDefinition): string {
  return `${policy.text.trim()}\n\n${prompt.taskTemplate.trim()}\n`;
}
