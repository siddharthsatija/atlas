import "server-only";

/**
 * Public surface of the prompt registry (ATL-051).
 *
 * Callers import from here rather than reaching into `versions/`, so a prompt is
 * always obtained through `resolvePrompt` with its metadata attached. The lint
 * boundary already forbids `src/features` from importing `src/server/ai` at all,
 * and `server-only` keeps the text out of any client bundle.
 */

export {
  resolvePrompt,
  registeredPrompts,
  hasPrompt,
  UnregisteredPromptError,
  UnknownPolicyVersionError,
} from "./registry";

export {
  AI_PURPOSES,
  SCHEMA_IDS,
  PROMPT_ID_PATTERN,
  PLACEHOLDER_PATTERN,
  type AiPurpose,
  type SchemaId,
  type PromptDefinition,
  type ResolvedPrompt,
  type SystemPolicy,
} from "./prompt";
