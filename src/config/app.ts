/**
 * Non-secret application constants. Safe to import anywhere.
 *
 * Product copy does not belong here — it lives with the surface that renders it and
 * is reviewed against the honesty rules in docs/01-product-requirements.md and
 * .claude/skills/product/SKILL.md.
 */

export const APP_NAME = "Atlas";

/**
 * The privacy-policy version consent is recorded against (ATL-078).
 *
 * A reviewed constant rather than an environment variable, deliberately. Consent
 * is a legal record, and what matters is being able to answer "which terms did
 * this user agree to, and when did those terms change" years later. A constant
 * makes every change a code change with an author, a date, and a diff; an
 * environment variable makes it invisible to git and lets two environments
 * disagree about what the user agreed to.
 *
 * **Bump this whenever the policy text changes in a way that requires
 * re-consent.** Stored rows keep the version in force when they were written and
 * are never back-filled, so comparing a stored value against this one is how
 * stale consent is detected.
 */
export const CONSENT_POLICY_VERSION = "2026-08-01";

/** docs/README.md — used for document metadata, not marketing copy. */
export const APP_TAGLINE = "Map your digital identity.";

/**
 * Primary navigation order. Defined by PRD §12 and frontend spec §3.
 * Labels only — the shell that consumes this is ATL-005.
 */
export const NAV_ORDER = [
  "overview",
  "assets",
  "insights",
  "requests",
  "activity",
  "archive",
  "settings",
] as const;

export type NavKey = (typeof NAV_ORDER)[number];

/** Frontend spec §21. Content-driven adjustments are preferred over device labels. */
export const BREAKPOINTS = { sm: 640, md: 1024, lg: 1440 } as const;

/**
 * Above this length, mailto handoff truncates silently in common clients, so the
 * UI must steer to the copy path instead (PRD FR-08, ATL-062).
 */
export const MAILTO_SAFE_LENGTH = 1800;
