import "server-only";

/**
 * Public surface of the AI policy layer (ATL-049).
 *
 * `AiPolicyService` is the only path from user data to the provider — consent,
 * retrieval limits, redaction and fencing all live behind it, so a second entry
 * point would be a way around all four at once. `StructuredCompletionService` is
 * deliberately **not** re-exported here: callers reach it through the policy
 * layer or not at all.
 */

export {
  AiPolicyService,
  PRODUCT_GUIDANCE_UNAVAILABLE,
  type AiPolicyRequest,
  type AiPolicyResult,
  type AiPolicyDeps,
} from "./ai-policy-service";

export { PURPOSE_POLICIES, policyFor, allowsRecordKind, type PurposePolicy } from "./policy-map";

export { classifyContext, type ClassificationInput } from "./classification";

export {
  CONTEXT_OPEN_TAG,
  CONTEXT_CLOSE_TAG,
  assembleContextBlock,
  contextIdsOf,
  escapeForContext,
  type ContextEntry,
} from "./context-assembly";

export { redactForContext, redactIdentifier, SECRET_PLACEHOLDER } from "./redaction";
