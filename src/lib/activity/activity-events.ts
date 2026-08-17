/**
 * The activity event vocabulary and its summary templates (ATL-069).
 *
 * ## Why templates rather than caller-supplied strings
 *
 * A summary is the one user-visible free-text field in the product, and every
 * service that emits one holds restricted data at the moment it does: the asset
 * service has the account identifier, the request service has the recipient
 * address. Letting callers pass a string would make "summaries contain no
 * restricted values" a rule each of them has to remember, and the failure would
 * be invisible — an unmasked address in a timeline reads perfectly normally.
 *
 * Templates invert that. A caller supplies typed, allowlisted parameters and the
 * writer composes the sentence, so there is **no parameter that accepts free
 * text** and nothing to remember. This is the same reasoning that gave the
 * ATL-085 logger no `message` field.
 *
 * Identifiers may still appear, masked — ATL-069 permits "masked identifiers at
 * most", and a timeline that could not say *which* address a request went to
 * would be less useful without being safer.
 *
 * ## This vocabulary grows
 *
 * Only events the documentation already says are emitted are listed:
 * asset mutations and archive/restore (ATL-030, ATL-036), finding resolution,
 * dismissal, undo, and auto-resolution (ATL-043, architecture §11.1), request
 * transitions (architecture §13), and consent changes (ATL-078). Each later
 * milestone adds its own — a code change with a reviewer, exactly as the ADR-006
 * audit inventory does.
 *
 * In `lib/` because the Activity page (ATL-070) needs the type icons and labels
 * keyed off these values, and the layer boundaries stop components importing
 * `src/server`.
 */

/**
 * Parameters a template may interpolate.
 *
 * Every one is a short label or a already-masked identifier. There is no
 * free-text parameter, and adding one would defeat the design — which is why the
 * type is closed rather than `Record<string, string>`.
 */
export interface ActivityParams {
  /** A service or product name, e.g. "Acme". Never a personal value. */
  service?: string;
  /** A short human label for the entity, e.g. "Work email". */
  label?: string;
  /** An identifier that has ALREADY been masked by the caller. */
  maskedIdentifier?: string;
  /** A status or state name from a fixed vocabulary. */
  status?: string;
  fromStatus?: string;
  toStatus?: string;
  /** A category or severity label. */
  category?: string;
  severity?: string;
  /** A count, rendered into the sentence. */
  count?: number;
  /** A consent type (ATL-078). */
  consentType?: string;
}

type Template = (params: ActivityParams) => string;

/** Falls back to a generic noun when a label is absent, so a sentence never breaks. */
const named = (params: ActivityParams, fallback: string): string =>
  params.label ?? params.service ?? fallback;

/**
 * The vocabulary. Adding an entry here is the only way to add an event type.
 *
 * Summaries are written in the past tense and in the user's voice, matching the
 * product copy rules — the timeline says what happened, not what the system did.
 */
export const ACTIVITY_TEMPLATES = {
  // --- Digital assets (ATL-030, ATL-036) ---
  "asset.created": (p) => `Added ${named(p, "a service")}`,
  "asset.updated": (p) => `Updated ${named(p, "a service")}`,
  "asset.archived": (p) => `Archived ${named(p, "a service")}`,
  "asset.restored": (p) => `Restored ${named(p, "a service")}`,
  "asset.deleted": (p) => `Deleted ${named(p, "a service")}`,

  // --- Findings (ATL-043, architecture §11.1) ---
  "finding.opened": (p) =>
    p.severity
      ? `New ${p.severity} finding for ${named(p, "a service")}`
      : `New finding for ${named(p, "a service")}`,
  "finding.resolved": (p) => `Resolved a finding for ${named(p, "a service")}`,
  "finding.dismissed": (p) => `Dismissed a finding for ${named(p, "a service")}`,
  /**
   * Undo (ATL-043). Distinct from `finding.opened`, which announces a *new*
   * finding — this one returned because the user changed their mind, and a
   * timeline that said "New finding" for it would be describing something that
   * did not happen.
   */
  "finding.restored": (p) => `Restored a dismissed finding for ${named(p, "a service")}`,
  /** Written by the rules engine when a predicate stops holding. */
  "finding.auto_resolved": (p) =>
    `A finding for ${named(p, "a service")} resolved itself after your changes`,

  // --- Data requests (architecture §13) ---
  "request.created": (p) => `Drafted a data request to ${named(p, "a service")}`,
  "request.sent": (p) =>
    p.maskedIdentifier
      ? `Sent a data request to ${named(p, "a service")} (${p.maskedIdentifier})`
      : `Sent a data request to ${named(p, "a service")}`,
  "request.transitioned": (p) =>
    p.fromStatus && p.toStatus
      ? `Data request to ${named(p, "a service")} moved from ${p.fromStatus} to ${p.toStatus}`
      : `Updated a data request to ${named(p, "a service")}`,
  "request.completed": (p) => `Completed the data request to ${named(p, "a service")}`,

  // --- Consent (ATL-078) ---
  "consent.granted": (p) => `Granted consent for ${p.consentType ?? "a feature"}`,
  "consent.revoked": (p) => `Withdrew consent for ${p.consentType ?? "a feature"}`,

  // --- Onboarding (ATL-016) ---
  /**
   * The first row in every user's timeline.
   *
   * Activity only — security §12's audit inventory does not list onboarding, and
   * the part of it that does have security meaning (the AI-processing consent
   * grant) is audited by ATL-078 in its own right.
   */
  "onboarding.completed": () => "Finished setting up Atlas",

  // --- Privacy score (ADR-004) ---
  "score.recalculated": (p) =>
    p.count === undefined
      ? "Your privacy score was recalculated"
      : `Your privacy score is ${p.count}`,
} as const satisfies Record<string, Template>;

export type ActivityEventType = keyof typeof ACTIVITY_TEMPLATES;

export const ACTIVITY_EVENT_TYPES = Object.keys(ACTIVITY_TEMPLATES) as ActivityEventType[];

const TYPES: ReadonlySet<string> = new Set(ACTIVITY_EVENT_TYPES);

/**
 * Whether a string is a known event type.
 *
 * ATL-069 requires unknown types to be *rejected*, not stored. An unrecognised
 * type would render as a blank row in the timeline and would be invisible to
 * the filters, so it fails at the writer rather than surfacing later as a gap.
 */
export function isActivityEventType(value: string): value is ActivityEventType {
  return TYPES.has(value);
}

/** Builds the summary for one event. */
export function buildActivitySummary(type: ActivityEventType, params: ActivityParams = {}): string {
  return ACTIVITY_TEMPLATES[type](params);
}
