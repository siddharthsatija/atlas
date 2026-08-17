import type { ContextDisclosure } from "./explanation-view";
import type { InputClassification } from "./interaction-vocabulary";

/**
 * User-facing copy for the assistant panel (ATL-053, AI behavior §4 and §11).
 *
 * In `lib/` for the reason `fallback-copy.ts` is: one home for every sentence the
 * assistant can say, so a phrase cannot drift between the surface that renders it
 * and the layer that decided it applies.
 *
 * ## Nothing here names a provider or a failure mode
 *
 * Every state a user can reach says what Atlas can and cannot do right now. None
 * of them mentions a vendor, a status code, a rate limit or a timeout — §11 and
 * the locked ATL-053 decision both require it, and a user cannot act on any of
 * those words anyway.
 *
 * ## Confidence wording is deliberately not shared with findings
 *
 * `lib/findings/provenance.ts` has its own `CONFIDENCE_LABELS` for the **rule's**
 * confidence, derived by ADR-001 from source and staleness. The labels below
 * describe the **model's** certainty about its own reasoning. The two are
 * different quantities, and importing one for the other is exactly how a UI ends
 * up presenting a model's guess as a system measurement.
 */

/** What each state tells the user. */
export const ASSISTANT_COPY = {
  /** The control that opens the assistant. */
  ask: "Ask Atlas",
  askHint: "Atlas will explain this finding using only the records shown here.",
  pending: "Atlas is looking at this finding…",
  cancel: "Cancel",
  /**
   * Cancel stops the *waiting*, and says so.
   *
   * The request is not aborted — no `AbortSignal` reaches the gateway — so a
   * message promising the work stopped would be untrue. This wording claims only
   * what actually happened.
   */
  cancelled: "Stopped waiting. Atlas may still finish this request in the background.",
  clear: "Clear",
  cleared: "Cleared from this view.",
  /**
   * Shown when `ai_processing` consent is absent or withdrawn.
   *
   * ## Why this names no location
   *
   * An earlier draft ended "You can turn it on in Settings." That is not true
   * today: consent is captured once during onboarding (ATL-016/ATL-078), and
   * `/settings` is still the ATL-005 placeholder — the privacy controls are
   * ATL-074–077. Pointing a user at a page with no such control is a promise the
   * product cannot keep, and it is worse than saying less, because the user goes
   * looking and concludes the product is broken.
   *
   * So this states the fact and stops. It invents no mechanism, links to nothing
   * that does not exist, and stays correct once the real control ships — at which
   * point this string should gain a link to it.
   */
  consentRequired:
    "Atlas does not have your permission to use AI, so it cannot explain this finding. Nothing about this finding was sent anywhere.",
  /**
   * The second sentence is the point.
   *
   * A consent refusal happens *before retrieval* (ATL-049), so the user's records
   * are never read — and telling them so is the most useful thing this state can
   * say. A bare "permission required" leaves them wondering what already left.
   */
  unavailable: "Atlas could not explain this finding right now. You can try again.",
  notFound: "This finding is no longer available.",
  retry: "Try again",
  /** Announced when an answer replaces the pending state (see the live region). */
  answeredAnnouncement: "Atlas has finished explaining this finding.",
  summaryHeading: "What Atlas found",
  whyHeading: "Why it matters",
  sourcesHeading: "Records Atlas used",
  actionsHeading: "Suggested next steps",
  uncertaintiesHeading: "What Atlas is unsure about",
  /**
   * Stated on every AI answer, not only uncertain ones (§4, and the "every score
   * view explains limitations" habit the score surfaces already follow).
   */
  proposalNote: "Atlas suggests these; it never carries them out for you.",
} as const;

/**
 * The strings one assistant surface needs.
 *
 * Widened from the literal types of `ASSISTANT_COPY` so a second surface can
 * supply its own wording without the component branching on which surface it is
 * (ATL-054). The component reads copy; it does not choose it.
 */
export type AssistantCopy = { [K in keyof typeof ASSISTANT_COPY]: string };

/**
 * The same panel, asked about a saved service instead of a finding (ATL-054).
 *
 * ## Why the wording is duplicated rather than made generic
 *
 * An earlier attempt replaced "finding" with a noun passed in at render time —
 * "Atlas is looking at this {subject}…". It reads like a mail merge, and worse,
 * it forces every sentence into one grammatical shape: `notFound` wants "This
 * finding is no longer available" and "This service is no longer saved", which
 * are not the same sentence with a word swapped. Two explicit sets cost a few
 * lines and let each one say the true thing.
 *
 * Every constraint the finding copy documents still applies here: no provider is
 * named, no failure mode is described, no control is promised that does not
 * exist, and the consent refusal still states that nothing was read — because on
 * this surface too, consent is checked before retrieval (ATL-049).
 *
 * `whyHeading`, `actionsHeading` and `proposalNote` are supplied because the type
 * is one shape, but no asset-summary answer reaches them: `presentAssetSummary`
 * only ever produces the `asset_summary` variant, which has neither a
 * `whyItMatters` nor an `actions` field to render. They are written for an asset
 * rather than left as finding wording so that they cannot be wrong if a future
 * purpose does reach them.
 */
export const ASSET_ASSISTANT_COPY: AssistantCopy = {
  ask: "Ask Atlas",
  askHint: "Atlas will summarise this service using only the records saved against it.",
  pending: "Atlas is looking at this service…",
  cancel: "Cancel",
  cancelled: "Stopped waiting. Atlas may still finish this request in the background.",
  clear: "Clear",
  cleared: "Cleared from this view.",
  consentRequired:
    "Atlas does not have your permission to use AI, so it cannot summarise this service. Nothing about this service was sent anywhere.",
  unavailable: "Atlas could not summarise this service right now. You can try again.",
  notFound: "This service is no longer available.",
  retry: "Try again",
  answeredAnnouncement: "Atlas has finished summarising this service.",
  summaryHeading: "What Atlas read",
  whyHeading: "Why it matters",
  sourcesHeading: "Records Atlas used",
  actionsHeading: "Suggested next steps",
  uncertaintiesHeading: "What Atlas is unsure about",
  proposalNote: "Atlas suggests these; it never carries them out for you.",
};

/**
 * §11's context disclosure: what was actually sent, in the user's words.
 *
 * Phrased as what Atlas *read*, because that is the question a user is really
 * asking. `none` still gets a sentence — "nothing of yours was sent" is the most
 * reassuring thing this panel can say, and leaving it blank would look like an
 * omission rather than an answer.
 */
export const CLASSIFICATION_COPY: Record<InputClassification, string> = {
  none: "Atlas answered without sending any of your records.",
  metadata: "Atlas sent details about your saved records — no personal field values.",
  personal: "Atlas sent personal field values you approved for this request.",
};

/**
 * The disclosure sentence, naming the scope when there is one to name (ATL-054).
 *
 * ## Why the scope sentence is separate from the classification sentence
 *
 * They answer different questions. The classification says *what kind* of data
 * left Atlas; the scope says *whose records* it was drawn from. Folding the
 * service name into `CLASSIFICATION_COPY` would tie a privacy category to a
 * particular surface, and the next surface would need a fourth classification.
 *
 * The wording is deliberately exclusive — "only … and its own records" — because
 * the claim ATL-054 makes is a negative one, and a user cannot check a positive
 * phrasing. It is true by construction: `summarize_asset` retrieval fetches one
 * asset with its own categories and permissions and nothing else, and the
 * invariant layer rejects any citation of an id that was not sent.
 */
export function contextDisclosureText(disclosure: ContextDisclosure): string {
  const classification = CLASSIFICATION_COPY[disclosure.classification];

  return disclosure.subjectName === undefined
    ? classification
    : `${classification} Only ${disclosure.subjectName} and its own records were read.`;
}

/**
 * The **model's** confidence in its own reasoning.
 *
 * Worded as statements about the answer rather than as a grade, so it cannot be
 * mistaken for the finding's confidence badge sitting a few centimetres above it.
 */
export const AI_CONFIDENCE_COPY: Record<"low" | "medium" | "high", string> = {
  low: "Atlas is not very confident in this explanation.",
  medium: "Atlas is fairly confident in this explanation.",
  high: "Atlas is confident in this explanation.",
};

/** The short label beside the wording above. */
export const AI_CONFIDENCE_LABELS: Record<"low" | "medium" | "high", string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

/** Feedback controls (§12). Two thumbs and nothing else — no free-text box. */
export const FEEDBACK_COPY = {
  question: "Was this helpful?",
  yes: "Yes, this helped",
  no: "No, this did not help",
  recorded: "Thanks — your feedback was recorded.",
  unavailable: "Your feedback could not be saved.",
} as const;
