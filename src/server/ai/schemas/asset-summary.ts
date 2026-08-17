import { z } from "zod";

/**
 * The asset-summary output schema (ATL-054, AI behavior §3 "Summarize an asset").
 *
 * ## Why this is not `explanation`
 *
 * The explanation schema carries `whyItMatters`, `confidence` and
 * `recommendedActions`, and every one of them would be a lie here. A summary of
 * what a service holds is not an argument about why it matters; the model's
 * certainty about its own reasoning is a quantity ATL-055 attaches to
 * *explanations*, not descriptions; and ATL-054's acceptance criteria ask for
 * scoped retrieval and a naming disclosure, not for proposed actions.
 *
 * Reusing `explanation` would have meant either populating those fields with
 * something invented or making them optional — and making a published schema's
 * required fields optional weakens it for the surface that does need them.
 *
 * So this is three fields, each of which the ticket actually requires.
 *
 * ## What each is for
 *
 * `summary` is the grounded text. `.min(1)` because `""` is not a summary, it is
 * a blank panel the UI would render as though it were an answer.
 *
 * `evidenceReferences` is the anti-leakage mechanism. Its *emptiness* rule lives
 * in the invariant layer rather than here, exactly as `explanation` does it: a
 * schema cannot know which ids were sent, and "cited nothing" is only wrong for
 * purposes that must be grounded in records.
 *
 * `uncertainties` exists because §4 requires the response to disclose inference,
 * staleness, demo data and anything Atlas cannot verify. Provenance already
 * reaches the model through `toProvenance`; this is where it says so back.
 *
 * ## Unknown fields are stripped, not rejected
 *
 * Zod drops unknown keys by default. `.strict()` would spend a retry on a model
 * that added one harmless extra key — a worse trade than ignoring something
 * nothing reads. Same reasoning as `explanation`.
 */
export const assetSummarySchema = z.object({
  summary: z.string().min(1),
  evidenceReferences: z.array(z.string().min(1)),
  uncertainties: z.array(z.string().min(1)),
});

export type AssetSummaryOutput = z.infer<typeof assetSummarySchema>;

/** Bumped when the shape changes. Recorded against every interaction (#95). */
export const ASSET_SUMMARY_SCHEMA_VERSION = 1;
