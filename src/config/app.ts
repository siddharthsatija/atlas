/**
 * Non-secret application constants. Safe to import anywhere.
 *
 * Product copy does not belong here — it lives with the surface that renders it and
 * is reviewed against the honesty rules in docs/01-product-requirements.md and
 * .claude/skills/product/SKILL.md.
 */

export const APP_NAME = "Atlas";

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
