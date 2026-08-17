import { ACTION_TYPES } from "./explanation";
import type { SchemaId } from "../prompts/prompt";

/**
 * Post-validation invariant checks (ATL-050, `.claude/skills/ai/SKILL.md`).
 *
 * **These are the privacy controls, not the schema.** A schema proves an output
 * is shaped correctly; it cannot prove the output is *about the right records*.
 * Every check here compares the model's claims against what was actually sent
 * and what the user actually approved — facts a schema has no access to.
 *
 * ## Violations fail closed and are never retried
 *
 * A malformed shape is plausibly a formatting slip worth one more attempt. A
 * reference to a record that was never in context is a hallucination, and an
 * `includedFieldKeys` superset is a privacy violation — asking again does not
 * make either acceptable, and displaying either is the failure this whole
 * subsystem exists to prevent. So these produce an immediate fallback.
 *
 * ## Nothing here is displayed
 *
 * Violations carry a code and a count, never the offending value. A violation
 * message quoting a hallucinated identifier would put model-generated text into
 * a log or an error surface, which is the thing being guarded against.
 */

export type InvariantCode =
  /** A reference the supplied context did not contain. */
  | "evidence_reference_not_in_context"
  /** An explanation citing nothing at all. */
  | "evidence_references_empty"
  /** A field key the user did not approve in this flow. */
  | "included_field_not_approved"
  /** An action type outside the allowlist. */
  | "action_type_not_allowed"
  /** An entity the user does not own, or that was not in context. */
  | "entity_not_owned";

export interface InvariantViolation {
  code: InvariantCode;
  /** How many values failed. Never the values themselves. */
  count: number;
}

/**
 * What the caller actually sent and approved.
 *
 * Supplied by ATL-049 in production. ATL-050 does not build it — retrieval and
 * approval are the policy layer's, and inventing them here would put two
 * modules in charge of the same decision.
 */
export interface ValidationContext {
  /** Identifiers present in the context block that was sent. */
  contextIds: ReadonlySet<string>;
  /** Personal field keys approved **in this flow**, not merely stored. */
  approvedFieldKeys: ReadonlySet<string>;
  /** Entity ids the signed-in user owns AND that appeared in context. */
  ownedEntityIds: ReadonlySet<string>;
}

/** Shapes the checks read. Kept structural so neither schema type is imported. */
interface ExplanationShape {
  evidenceReferences: string[];
  recommendedActions: { actionType: string; entityId: string }[];
}

interface DraftShape {
  includedFieldKeys: string[];
}

const countMissing = (values: string[], allowed: ReadonlySet<string>): number =>
  values.filter((value) => !allowed.has(value)).length;

function checkExplanation(
  output: ExplanationShape,
  context: ValidationContext,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  /**
   * An explanation with no evidence is ungrounded by construction. The schema
   * permits an empty array because emptiness is only wrong for this purpose.
   */
  if (output.evidenceReferences.length === 0) {
    violations.push({ code: "evidence_references_empty", count: 1 });
  }

  const unknownReferences = countMissing(output.evidenceReferences, context.contextIds);
  if (unknownReferences > 0) {
    violations.push({ code: "evidence_reference_not_in_context", count: unknownReferences });
  }

  /**
   * Re-asserted despite the schema's enum.
   *
   * Unreachable while the schema holds, and deliberately kept: the schema layer
   * retries on failure, the invariant layer fails closed. If the enum is ever
   * widened without the retrieval side being widened to match, this is the check
   * that refuses to display the result rather than asking the model again.
   */
  const allowedActions: ReadonlySet<string> = new Set(ACTION_TYPES);
  const badActions = output.recommendedActions.filter(
    (action) => !allowedActions.has(action.actionType),
  ).length;
  if (badActions > 0) {
    violations.push({ code: "action_type_not_allowed", count: badActions });
  }

  const unownedEntities = countMissing(
    output.recommendedActions.map((action) => action.entityId),
    context.ownedEntityIds,
  );
  if (unownedEntities > 0) {
    violations.push({ code: "entity_not_owned", count: unownedEntities });
  }

  return violations;
}

function checkDraft(output: DraftShape, context: ValidationContext): InvariantViolation[] {
  /**
   * The subset check the skill calls out by name: trusting `includedFieldKeys`
   * instead of intersecting it with approved keys is how a stored personal field
   * reaches a recipient without per-request approval (ADR-002, security §10).
   */
  const unapproved = countMissing(output.includedFieldKeys, context.approvedFieldKeys);
  return unapproved > 0 ? [{ code: "included_field_not_approved", count: unapproved }] : [];
}

/** Shape the asset-summary checks read. Structural, like the two above. */
interface AssetSummaryShape {
  evidenceReferences: string[];
}

/**
 * ATL-054's grounding checks.
 *
 * Deliberately **not** the explanation checks. A summary has no
 * `recommendedActions` to allowlist and no `entityId` to own, so running those
 * would be reading fields that do not exist. It has no `includedFieldKeys`
 * either: `approvedFieldKeys` is a drafting concept (ADR-002, per-request field
 * approval) and means nothing for a description of records the user already
 * owns. Applying it here would be draft semantics leaking into a purpose that
 * never asked for them.
 *
 * What remains is the pair that makes an asset summary trustworthy, and they are
 * the same two that make ATL-054's scope claim real: it must cite something, and
 * everything it cites must have been in the context actually sent. The second is
 * what stops another asset's identifier appearing in the output even if the
 * model is asked for it in prose — the id was never sent, so it can never be
 * cited.
 */
function checkAssetSummary(
  output: AssetSummaryShape,
  context: ValidationContext,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (output.evidenceReferences.length === 0) {
    violations.push({ code: "evidence_references_empty", count: 1 });
  }

  const unknownReferences = countMissing(output.evidenceReferences, context.contextIds);
  if (unknownReferences > 0) {
    violations.push({ code: "evidence_reference_not_in_context", count: unknownReferences });
  }

  return violations;
}

/**
 * One handler per schema, looked up rather than branched.
 *
 * ## Why a `Record` and not a ternary
 *
 * This was `schemaId === "explanation" ? checkExplanation : checkDraft`. That
 * has a silent failure mode: a third schema type-checks fine and falls into the
 * draft branch, which reads `includedFieldKeys` — a field an asset summary does
 * not have — and throws inside the layer whose job is to make output safe.
 * ATL-054 added exactly such a schema, so the fall-through had to go.
 *
 * A `Record<SchemaId, …>` makes the next schema a **compile error** until it
 * declares a handler, which is the same technique `PURPOSE_POLICIES` and
 * `schemaFor` already use. There is no default branch, because a default is the
 * thing that made the old shape unsafe.
 *
 * Existing `explanation` and `draft` behaviour is unchanged — the same two
 * functions run on the same inputs.
 */
const HANDLERS: Record<
  SchemaId,
  (output: unknown, context: ValidationContext) => InvariantViolation[]
> = {
  explanation: (output, context) => checkExplanation(output as ExplanationShape, context),
  draft: (output, context) => checkDraft(output as DraftShape, context),
  asset_summary: (output, context) => checkAssetSummary(output as AssetSummaryShape, context),
};

/**
 * Runs the checks appropriate to the schema that produced the output.
 *
 * Returns an empty array when everything holds. The output is `unknown` because
 * it arrives from the registry lookup; the structural casts inside each handler
 * are safe because this only runs after the corresponding schema parsed
 * successfully.
 */
export function checkInvariants(
  schemaId: SchemaId,
  output: unknown,
  context: ValidationContext,
): InvariantViolation[] {
  return HANDLERS[schemaId](output, context);
}
