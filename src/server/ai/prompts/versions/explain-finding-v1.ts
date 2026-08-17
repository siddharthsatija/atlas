import { definePrompt } from "../prompt";

/**
 * `explain-finding-v1` (ATL-051). First consumer: ATL-055.
 *
 * **Append-only once merged.** Wording changes ship as `explain-finding-v2.ts`.
 *
 * Pins `policyVersion: 1`. Adopting a later policy requires a new prompt version
 * that pins it, so the pair recorded against an interaction always reconstructs
 * the exact instructions that produced the output.
 *
 * ## What this prompt deliberately does not do
 *
 * It does not ask the model to decide whether a finding exists, how severe it
 * is, or how confident the *rule engine* was. Those are deterministic (ADR-001)
 * and arrive in context as facts to be explained. The `confidence` field the
 * model returns describes its own certainty about its explanation — a different
 * quantity, and conflating the two would let a model overwrite a computed value.
 *
 * The described output matches the explanation schema in AI behavior §7, which
 * ATL-050 implements under the identifier `explanation`. The two must agree
 * field for field: a prompt asking for a field the validator does not expect
 * fails validation on every call, retries once and falls back, which presents as
 * a total outage of the surface.
 */
export const explainFindingV1 = definePrompt({
  promptId: "explain-finding-v1",
  purpose: "explain_finding",
  promptVersion: 1,
  policyVersion: 1,
  schemaId: "explanation",
  schemaVersion: 1,
  taskTemplate: `TASK
Explain one privacy finding to the person it belongs to, using only the finding, the related asset, and the score-factor definition supplied in the context block.

The finding, its severity, and its rule confidence were determined by Atlas before you were called. Describe them; do not re-derive, re-rank, or dispute them. If the context is thin, stale, or demo data, say so rather than filling the gap.

Explain what the finding means in plain language, and why it might matter to this person given their own records. Offer next actions only from the allowed action types below, and only for entities that appear in the context.

OUTPUT
Return a single JSON object with exactly these fields:

- "summary": one or two sentences stating what the finding is, in plain language.
- "whyItMatters": why this may matter for this person, grounded in the supplied records. No alarm, no legal claims.
- "evidenceReferences": an array of identifiers taken verbatim from the context. Every claim you make must be supported by one of these. Never invent an identifier; never include one that is not in the context.
- "confidence": one of "low", "medium", or "high" — your certainty about this explanation. Use "low" when the context is thin, stale, or demo data.
- "uncertainties": an array of short strings naming what you could not determine. Use an empty array only when there is genuinely nothing unresolved.
- "recommendedActions": an array of objects, each with "label" (a short imperative phrase), "actionType" (one of "open_asset", "start_request", "review_permission", "dismiss"), and "entityId" (an identifier present in the context). Return an empty array rather than inventing an action.

Return the JSON object alone.`,
  repairInstruction: `Your previous response could not be read as the required JSON object.

Return a single JSON object with exactly these fields and no others: "summary" (string), "whyItMatters" (string), "evidenceReferences" (array of strings), "confidence" (one of "low", "medium", "high"), "uncertainties" (array of strings), and "recommendedActions" (array of objects, each with "label" (string), "actionType" (one of "open_asset", "start_request", "review_permission", "dismiss"), and "entityId" (string)).

Use only identifiers that appear in the context already provided. Do not add commentary, explanation, or markdown code fences. Return the JSON object alone.`,
});
