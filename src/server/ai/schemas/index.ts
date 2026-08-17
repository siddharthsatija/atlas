import "server-only";

/**
 * Public surface of the AI output schemas (ATL-050).
 *
 * Server-only: validated output is still model-derived text until a caller has
 * checked it, and the schemas describe the shape of data that never belongs in a
 * client bundle. The lint boundary already blocks `src/features` from importing
 * `src/server/ai`.
 */

export {
  explanationSchema,
  recommendedActionSchema,
  ACTION_TYPES,
  CONFIDENCE_LEVELS,
  EXPLANATION_SCHEMA_VERSION,
  type ExplanationOutput,
  type ActionType,
} from "./explanation";

export { draftSchema, DRAFT_SCHEMA_VERSION, type DraftOutput } from "./draft";

export { schemaFor, schemaEntries, type SchemaEntry } from "./registry";

export {
  checkInvariants,
  type InvariantCode,
  type InvariantViolation,
  type ValidationContext,
} from "./invariants";

export { validateOutput, type ValidationResult } from "./validate";
