import { definePrompt } from "../prompt";

/**
 * `summarize-asset-v1` (ATL-051 registry, ATL-054's consumer).
 *
 * **Append-only once merged.** Wording changes ship as `summarize-asset-v2.ts`.
 * No existing published version was touched to add this one.
 *
 * Pins `policyVersion: 1`, matching `explain-finding-v1`. Adopting a later
 * policy requires a new prompt version that pins it, so the pair recorded
 * against an interaction always reconstructs the exact instructions that
 * produced the output.
 *
 * ## The scope instruction is defence in depth, not the control
 *
 * The paragraph telling the model to ignore requests about other services is
 * worth writing, but it is **not** what enforces scope. Retrieval already sent
 * exactly one asset and its own categories and permissions (`policy-map.ts`,
 * `summarize_asset`), so another asset's records are not in the context to be
 * described, and its identifier is not in the context to be cited — the
 * invariant layer rejects any reference that was not sent. A user asking "also
 * tell me about my other account" gets an answer about this one.
 *
 * That ordering matters: prose in a prompt is the weakest layer in the stack and
 * the easiest for a determined input to argue with. It is here so the model's
 * *behaviour* is polite about the refusal, not so that the refusal depends on it.
 *
 * ## Why the output is three fields
 *
 * It matches the `asset_summary` schema field for field. A prompt asking for a
 * field the validator does not expect fails validation on every call, retries
 * once and falls back — presenting as a total outage of the surface. No
 * `whyItMatters`, no `confidence`, no `recommendedActions`: see the schema for
 * why none of the three belongs to a description of what a service holds.
 */
export const summarizeAssetV1 = definePrompt({
  promptId: "summarize-asset-v1",
  purpose: "summarize_asset",
  promptVersion: 1,
  policyVersion: 1,
  schemaId: "asset_summary",
  schemaVersion: 1,
  taskTemplate: `TASK
Summarise one saved service for the person it belongs to, using only the service, the categories of data it is recorded as holding, and the permissions recorded against it, as supplied in the context block.

Describe what is recorded. Do not evaluate, rank, or warn: this is a summary of the person's own records, not an assessment of them. If the context is thin, stale, or demo data, say so rather than filling the gap.

The context contains exactly one service. If the question mentions any other service, account, or record, summarise only the service in the context and note in "uncertainties" that you were asked about something outside it. Never describe, name, or refer to a service that is not in the context.

OUTPUT
Return a single JSON object with exactly these fields:

- "summary": two to four sentences describing what this service is recorded as holding and what it is permitted to do, in plain language.
- "evidenceReferences": an array of identifiers taken verbatim from the context. Every claim you make must be supported by one of these. Never invent an identifier; never include one that is not in the context.
- "uncertainties": an array of short strings naming what you could not determine, including anything you were asked about that was not in the context. Use an empty array only when there is genuinely nothing unresolved.

Return the JSON object alone.`,
  repairInstruction: `Your previous response could not be read as the required JSON object.

Return a single JSON object with exactly these fields and no others: "summary" (string), "evidenceReferences" (array of strings), and "uncertainties" (array of strings).

Use only identifiers that appear in the context already provided. Do not add commentary, explanation, or markdown code fences. Return the JSON object alone.`,
});
