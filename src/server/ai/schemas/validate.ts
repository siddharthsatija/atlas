import type { SchemaId } from "../prompts/prompt";
import { schemaFor } from "./registry";
import { checkInvariants, type InvariantViolation, type ValidationContext } from "./invariants";

/**
 * Output validation (ATL-050).
 *
 * Three stages, in order: parse the text as JSON, validate it against the
 * schema, then run the invariant checks. Each stage's failure means something
 * different, and the difference decides what happens next — which is why the
 * result is a discriminated union rather than a boolean.
 *
 * ## Fenced JSON is malformed, not tolerated
 *
 * Models sometimes wrap JSON in markdown fences. Stripping them here would be
 * convenient and wrong: the system policy already instructs "no markdown
 * fences", and quietly accepting output that ignores the policy means the policy
 * is not a control. The repair path exists precisely for this case, and it costs
 * one bounded retry.
 *
 * ## Nothing renderable leaves this module on failure
 *
 * A failed result carries a status and, for invariants, codes and counts. It
 * never carries the raw completion, a Zod issue path, or a value the model
 * produced. Those would end up in a log line or an error surface, and
 * model-generated text is exactly what must not travel.
 */

export type ValidationResult =
  | { status: "valid"; value: unknown; schemaVersion: number }
  /** Not JSON, or not the required shape. Worth exactly one repaired retry. */
  | { status: "schema_invalid" }
  /** Grounded-ness or privacy failure. Fails closed; never retried. */
  | { status: "invariant_violated"; violations: InvariantViolation[] };

/** Parses without throwing. Returns undefined for anything unparseable. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function validateOutput(
  schemaId: SchemaId,
  completion: string,
  context: ValidationContext,
): ValidationResult {
  const entry = schemaFor(schemaId);

  const parsed = parseJson(completion);
  if (parsed === undefined) return { status: "schema_invalid" };

  /**
   * `safeParse` rather than `parse`: a thrown ZodError would carry issue paths
   * and received values up the stack, where a well-meaning catch block would log
   * them. Unknown keys are dropped here by Zod's default object behaviour, which
   * is the ticket's "extra fields stripped".
   */
  const result = entry.schema.safeParse(parsed);
  if (!result.success) return { status: "schema_invalid" };

  const violations = checkInvariants(schemaId, result.data, context);
  if (violations.length > 0) return { status: "invariant_violated", violations };

  return { status: "valid", value: result.data, schemaVersion: entry.version };
}
