import "server-only";
import {
  assembleSystem,
  type AiPurpose,
  type PromptDefinition,
  type ResolvedPrompt,
} from "./prompt";
import { systemPolicyV1 } from "./versions/system-policy-v1";
import { explainFindingV1 } from "./versions/explain-finding-v1";
import { summarizeAssetV1 } from "./versions/summarize-asset-v1";

/**
 * The prompt registry (ATL-051).
 *
 * Maps a purpose to the prompt version currently active for it. **This file is
 * the mutable half** — repointing a purpose at a newer version is the entire
 * point of a registry. The versions themselves, under `versions/`, are
 * append-only and enforced by `scripts/verify-prompts.mts`.
 *
 * ## Why most purposes are absent
 *
 * Only `explain_finding` is registered. The other five purposes exist in the
 * taxonomy but have no prompt, because writing prose for a surface whose
 * retrieval policy (ATL-049) and output schema (ATL-050) do not exist yet
 * produces prompts that must be rewritten before anything ever calls them. Each
 * remaining purpose gets its prompt from the ticket that first consumes it —
 * `draft_request` from ATL-059, which needs ATL-058's field-approval flow to
 * exist before its wording can be honest.
 *
 * An unregistered purpose therefore throws rather than returning a default. A
 * fallback prompt would be worse than an error: it would send *something* to the
 * provider for a purpose nobody wrote instructions for.
 */

/** Policy generations, newest last. Prompts pin one by version. */
const POLICIES = [systemPolicyV1] as const;

/**
 * Purpose to active prompt version.
 *
 * `Partial` is deliberate: it makes "this purpose has no prompt yet" a fact the
 * type system carries, so a caller cannot read a registration that is not there.
 */
const ACTIVE_PROMPTS: Partial<Record<AiPurpose, PromptDefinition>> = {
  explain_finding: explainFindingV1,
  summarize_asset: summarizeAssetV1,
};

/** Raised when a purpose has no registered prompt. Never shown to a user. */
export class UnregisteredPromptError extends Error {
  readonly purpose: AiPurpose;

  constructor(purpose: AiPurpose) {
    super(`No prompt is registered for purpose: ${purpose}`);
    this.name = "UnregisteredPromptError";
    this.purpose = purpose;
  }
}

/** Raised when a prompt pins a policy generation that does not exist. */
export class UnknownPolicyVersionError extends Error {
  constructor(promptId: string, policyVersion: number) {
    super(`Prompt ${promptId} pins unknown policy version ${policyVersion}`);
    this.name = "UnknownPolicyVersionError";
  }
}

/** Every registered prompt, for tests and the eval harness. */
export function registeredPrompts(): PromptDefinition[] {
  return Object.values(ACTIVE_PROMPTS);
}

/** True when the purpose has an active prompt. */
export function hasPrompt(purpose: AiPurpose): boolean {
  return ACTIVE_PROMPTS[purpose] !== undefined;
}

/**
 * Resolves the active prompt for a purpose.
 *
 * Returns the assembled system text **and** the versions that produced it, so a
 * caller can record what generated an output without a second lookup. ATL-051
 * stores nothing; carrying the metadata is how the ticket satisfies "each
 * interaction records prompt version" without inventing persistence (B3).
 *
 * Takes no user data, so there is nothing here to authorize or redact.
 */
export function resolvePrompt(purpose: AiPurpose): ResolvedPrompt {
  const prompt = ACTIVE_PROMPTS[purpose];
  if (!prompt) throw new UnregisteredPromptError(purpose);

  const policy = POLICIES.find((entry) => entry.policyVersion === prompt.policyVersion);
  if (!policy) throw new UnknownPolicyVersionError(prompt.promptId, prompt.policyVersion);

  return Object.freeze({
    promptId: prompt.promptId,
    purpose: prompt.purpose,
    promptVersion: prompt.promptVersion,
    policyVersion: policy.policyVersion,
    schemaId: prompt.schemaId,
    schemaVersion: prompt.schemaVersion,
    system: assembleSystem(policy, prompt),
    taskTemplate: prompt.taskTemplate,
    repairInstruction: prompt.repairInstruction,
  });
}
