import type { InputClassification } from "@/lib/ai/interaction-vocabulary";

/**
 * Sensitivity classification of assembled context (ATL-049, §7.11).
 *
 * Derived from what actually entered the context block, never declared by a
 * caller. A caller-supplied tier would be a claim about its own behaviour, and
 * the whole point of recording this is to describe what the policy layer did.
 *
 * The ordering is `none < metadata < personal`, and the rule is the maximum
 * reached: one approved personal field makes the whole interaction `personal`,
 * because the disclosure surface is answering "how sensitive was what you sent",
 * not "what was most of it".
 */

export interface ClassificationInput {
  /** Entity IDs that entered the context block. */
  recordIds: readonly string[];
  /** Personal-field keys actually included (ADR-002), not merely approved. */
  includedPersonalFieldKeys: readonly string[];
}

export function classifyContext({
  recordIds,
  includedPersonalFieldKeys,
}: ClassificationInput): InputClassification {
  if (includedPersonalFieldKeys.length > 0) return "personal";
  return recordIds.length > 0 ? "metadata" : "none";
}
