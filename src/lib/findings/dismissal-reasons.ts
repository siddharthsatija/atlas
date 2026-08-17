/**
 * Why a user dismissed a finding (ATL-043, frontend §5.4).
 *
 * ## Two reasons, not three
 *
 * Frontend §5.4 asks for an optional reason and the ticket names three:
 * incorrect, not relevant, accepted risk. Only two are here.
 *
 * `incorrect` was removed by the OQ-04 sign-off, which resolved disputed
 * findings as **correction, not compensation**: a user who believes a finding is
 * wrong corrects the record it was computed from, and the engine re-evaluates
 * honestly. Offering it as a dismissal reason would let someone declare the
 * finding wrong while the data that produced it stayed exactly as it was — the
 * deduction retained, the dispute unrecorded, and nothing actually fixed. It
 * belongs to the correction path (ADR-004's amendment), not to this vocabulary.
 *
 * ## What these two mean for the score: nothing
 *
 * ADR-004 keeps a dismissed finding's full deduction until the underlying
 * condition clears, and the OQ-04 amendment makes that a rule rather than a
 * default — a dismissal never improves the score by itself. Neither reason is
 * read by anything: ATL-102's re-fire suppression turns on the input hash alone,
 * and the score model does not branch on it. The reason is recorded because the
 * user's stated intent is worth keeping, not because a computation needs it.
 *
 * ## Why a closed vocabulary
 *
 * The same three reasons as ATL-042's resolution actions: free text on a finding
 * is where personal data would eventually land; the ids satisfy the activity
 * metadata allowlist's identifier pattern by construction; and a fixed set can
 * be counted later without parsing.
 */

export interface DismissalReasonOption {
  id: string;
  /** What the user sees. First person, because they are describing their own decision. */
  label: string;
  /** What choosing it commits to, stated plainly. */
  description: string;
}

export const DISMISSAL_REASONS = [
  {
    id: "not_relevant",
    label: "This is not relevant to me",
    description: "The finding is accurate, but it does not matter for how you use this service.",
  },
  {
    id: "accepted_risk",
    label: "I accept this risk",
    description: "You understand the exposure and have decided to live with it.",
  },
] as const satisfies readonly DismissalReasonOption[];

export type DismissalReason = (typeof DISMISSAL_REASONS)[number]["id"];

const IDS: ReadonlySet<string> = new Set(DISMISSAL_REASONS.map((entry) => entry.id));

/**
 * Whether a submitted value is one Atlas knows.
 *
 * Applied at the Server Action boundary, where the value arrives untrusted. The
 * activity metadata allowlist is the second gate, not the first — a value that
 * failed there would be silently dropped, leaving a dismissal that claimed a
 * reason nobody could read.
 */
export function isDismissalReason(value: string): value is DismissalReason {
  return IDS.has(value);
}

const LABELS = new Map<string, string>(DISMISSAL_REASONS.map((entry) => [entry.id, entry.label]));

/** The label for a stored id, or the id itself if it is somehow unknown. */
export function dismissalReasonLabel(id: string): string {
  return LABELS.get(id) ?? id;
}
