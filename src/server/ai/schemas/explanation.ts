import { z } from "zod";

/**
 * The explanation output schema (ATL-050, AI behavior §7).
 *
 * Implemented **exactly as specified**: `summary`, `whyItMatters`,
 * `evidenceReferences`, `confidence`, `uncertainties`, `recommendedActions`.
 * No field is added, renamed or made optional — the prompt describes this shape
 * to the model, and a schema that disagreed with the prompt would fail every
 * call, retry once, and fall back, presenting as a total outage of the surface.
 *
 * ## Why the strings have a minimum length
 *
 * `z.string()` accepts `""`. A summary of `""` is not a valid explanation, it is
 * a blank panel that the UI would render as though it were an answer. §7 gives
 * the type, not the emptiness rule; treating empty required prose as malformed
 * is the reading that keeps the output meaningful.
 *
 * ## Unknown fields are stripped, not rejected
 *
 * Zod object parsing drops unknown keys by default, which is what the ticket
 * asks for ("extra fields stripped"). `.strict()` would instead reject them and
 * spend a retry on a model that added one harmless extra key — a worse trade
 * than silently dropping something nothing reads.
 */

/**
 * The action allowlist (AI behavior §7, `.claude/skills/ai/SKILL.md`).
 *
 * Exported because the invariant layer re-asserts it: the schema enforcing an
 * enum is the primary control, and the invariant check is what fails closed if
 * this list is ever widened without the retrieval side being widened too.
 */
export const ACTION_TYPES = [
  "open_asset",
  "start_request",
  "review_permission",
  "dismiss",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export const recommendedActionSchema = z.object({
  label: z.string().min(1),
  actionType: z.enum(ACTION_TYPES),
  /**
   * §7 specifies a uuid, and the point of checking is that a model inventing a
   * plausible identifier such as `asset-123` fails here rather than reaching the
   * ownership check with a shape nobody can look up.
   *
   * **`guid` rather than `uuid`.** Zod's `uuid()` additionally enforces the
   * RFC-4122 version and variant nibbles, which Postgres's own `uuid` type does
   * not: `22222222-2222-2222-2222-222222222222` is a value Postgres stores and
   * returns happily, and rejecting it here would refuse an identifier the
   * database considers valid. The version nibble carries no authorisation
   * meaning — ownership is decided by the invariant check against context, not
   * by how an id was generated.
   */
  entityId: z.guid(),
});

export const explanationSchema = z.object({
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  /**
   * Required, and required to be non-empty at the invariant layer rather than
   * here: an explanation with no evidence is ungrounded, but *which* references
   * are acceptable depends on the context that was sent, which a schema cannot
   * know.
   */
  evidenceReferences: z.array(z.string().min(1)),
  confidence: z.enum(CONFIDENCE_LEVELS),
  uncertainties: z.array(z.string().min(1)),
  recommendedActions: z.array(recommendedActionSchema),
});

export type ExplanationOutput = z.infer<typeof explanationSchema>;

/** Bumped when the shape changes. Recorded against every interaction (#95). */
export const EXPLANATION_SCHEMA_VERSION = 1;
