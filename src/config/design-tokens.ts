/**
 * Design tokens needed in TypeScript (Framer Motion, chart configuration).
 *
 * CSS is the source of truth for anything a stylesheet can express — see
 * src/styles/tokens.css. Values here mirror docs/06-design-system.md §14 and exist
 * only because motion and chart libraries take numbers, not CSS variables.
 *
 * Keep this list minimal. Anything expressible as a utility class belongs in CSS.
 */

/** Milliseconds. Design system §14: standard 150–220, larger panels 220–300. */
export const DURATION = {
  standard: 180,
  panel: 260,
} as const;

/** Framer Motion easing arrays matching --ease-entrance / --ease-exit. */
export const EASING = {
  entrance: [0.16, 1, 0.3, 1],
  exit: [0.4, 0, 1, 1],
} as const;

/** Seconds — Framer Motion's unit. */
export const MOTION = {
  standard: { duration: DURATION.standard / 1000, ease: EASING.entrance },
  panel: { duration: DURATION.panel / 1000, ease: EASING.entrance },
  exit: { duration: DURATION.standard / 1000, ease: EASING.exit },
} as const;

/**
 * Severity and status orderings.
 *
 * Presentation only — the values themselves are defined by the data model
 * (architecture §7.5) and must always be accompanied by text, never conveyed by
 * color alone (design system §12).
 */
export const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;
export const STATUS_ORDER = [
  "neutral",
  "active",
  "pending",
  "completed",
  "archived",
  "rejected",
] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];
export type StatusTone = (typeof STATUS_ORDER)[number];
