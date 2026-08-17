/**
 * User-facing copy for the deterministic fallback (ATL-052, AI behavior §11).
 *
 * In `lib/` because ATL-055 renders these strings: a second copy for the client
 * is how a sentence the server stopped emitting keeps appearing on screen.
 *
 * §11 sets the whole brief — explain that the assistant is temporarily
 * unavailable, do not expose provider errors, do not block manual workflows.
 * Every string here is written to that, and none of them apologises at length:
 * a user who wanted an explanation is better served by the explanation Atlas can
 * give than by a paragraph about why the other one is missing.
 */

/**
 * Shown above a deterministic explanation.
 *
 * Says what the user is looking at and why, without naming a provider, a status
 * code, or a failure mode. "Written by Atlas" is the honest description: the
 * text comes from the rule that produced the finding, not from a model.
 */
export const FALLBACK_NOTICE =
  "The assistant is temporarily unavailable, so this explanation was written by Atlas from the rule that produced this finding.";

/**
 * Shown when AI is switched off entirely (`AI_ENABLED=false`).
 *
 * Deliberately different from the outage notice: nothing is broken, and telling
 * a user something is "temporarily unavailable" when an operator turned it off
 * would be a small lie that erodes the rest.
 */
export const AI_DISABLED_NOTICE =
  "AI assistance is turned off, so this explanation was written by Atlas from the rule that produced this finding.";

/**
 * The lead-in for the deterministic `whyItMatters`.
 *
 * Matches AI behavior §8's approved phrasing ("Based on the information saved in
 * Atlas…") so a fallback does not read as a different product from an AI answer.
 */
export const FALLBACK_WHY_PREFIX = "Based on the information saved in Atlas";

/** Appended when the finding came from demo records (§4 requires disclosure). */
export const FALLBACK_DEMO_NOTE = "This finding is based on demo data.";

/**
 * Appended when Atlas has not confirmed the underlying records recently.
 *
 * The rule engine's confidence is a real, derived value (ADR-001); this sentence
 * reports it rather than restating it as a number the user cannot act on.
 */
export const FALLBACK_LOW_CONFIDENCE_NOTE =
  "Atlas could not recently verify the records behind this finding, so it may be out of date.";
