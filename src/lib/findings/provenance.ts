/**
 * Reading a finding's provenance back (ATL-041).
 *
 * ADR-001: "every finding cites rule ID, rule version, and input records", and
 * `source_reference` is where the first two live, written by
 * `sourceReferenceFor` as `rule_id@version`. This parses that back for display.
 *
 * Pure, and in `lib/` rather than in the panel: the string is a contract
 * between the engine and every surface that shows provenance, and a second
 * parser written inside a component is one that will disagree with the writer.
 *
 * ## What is deliberately absent
 *
 * **Last evaluation time.** Nothing persists one — there is no column, and
 * `updated_at` moves on any update including a status change, so it is not the
 * time the rule last ran. ATL-041 shows no evaluation timestamp rather than
 * presenting a proxy that would read as one.
 *
 * **Per-input confidence rationale.** `deriveConfidence` (ADR-001) takes the
 * minimum certainty across a rule's inputs and returns a single value; the
 * `ConfidenceInput[]` it reasoned over is not stored. The persisted overall
 * confidence is shown; the inputs behind it are not reconstructed.
 *
 * Both are recorded gaps for a future data-model ticket, not approximations.
 */

/** What `source_reference` decomposes into. */
export interface FindingProvenance {
  /** e.g. `R-001`. Null for a demo-seeded finding, which no rule produced. */
  ruleId: string | null;
  /** e.g. `rules-v1`. Null for the same reason. */
  ruleVersion: string | null;
  /** The raw reference, for display when it cannot be split. */
  reference: string | null;
}

/**
 * Splits `rule_id@version` into its parts.
 *
 * Tolerant by design. `source_reference` is nullable — §7.5 allows a
 * demo-seeded finding with no rule behind it — and a value that does not match
 * the shape is returned whole rather than discarded, so a surface can still
 * show *something* true rather than nothing.
 */
export function parseProvenance(sourceReference: string | null): FindingProvenance {
  if (!sourceReference) return { ruleId: null, ruleVersion: null, reference: null };

  const at = sourceReference.lastIndexOf("@");
  if (at <= 0 || at === sourceReference.length - 1) {
    return { ruleId: null, ruleVersion: null, reference: sourceReference };
  }

  return {
    ruleId: sourceReference.slice(0, at),
    ruleVersion: sourceReference.slice(at + 1),
    reference: sourceReference,
  };
}

/** §11.1's three-value scale, spelled for a reader rather than a database. */
export const CONFIDENCE_LABELS: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * How Atlas arrives at a confidence, in general terms.
 *
 * The *rule*, not the reasoning for this particular finding — that reasoning is
 * not persisted, and inventing it would be worse than explaining the method.
 * ADR-001: confidence is the minimum certainty across the records a rule read,
 * reduced as those records age.
 */
export const CONFIDENCE_METHOD =
  "Confidence is the lowest certainty of any record this rule read, reduced as those records age. It is derived from your data, never asserted by the rule.";

/** Stated plainly wherever provenance is shown, rather than left as a silence. */
export const PROVENANCE_LIMITATION =
  "Atlas does not yet record when a rule last ran, or the certainty of each individual record behind this finding.";
