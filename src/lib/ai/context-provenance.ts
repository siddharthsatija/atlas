/**
 * Provenance labels for AI context entries (ATL-049, AI behavior §4).
 *
 * §4 requires the response to disclose demo data, stale sources, low confidence,
 * inference, and inability to verify. The model can only disclose what the
 * context tells it, so every entry is labelled with where it came from and how
 * much it can be trusted.
 *
 * In `lib/` because the assistant UI (ATL-053) shows the same provenance to the
 * user — a second copy for the client is how a label the server stopped emitting
 * keeps rendering.
 */

export const CONTEXT_PROVENANCE = [
  /** An Atlas service record: computed or confirmed by the system. */
  "verified",
  /** Entered by the user. Untrusted content, and unverified as fact. */
  "user_provided",
  /** Clearly labelled demo data (§4). Never presented as real. */
  "demo",
  /** Real, but old enough that it may no longer reflect reality. */
  "potentially_stale",
] as const;

export type ContextProvenance = (typeof CONTEXT_PROVENANCE)[number];

/**
 * What the model sees. Human-readable rather than the snake-case key, because
 * this string goes into a prompt and reads as a sentence fragment.
 */
export const PROVENANCE_LABELS: Record<ContextProvenance, string> = {
  verified: "Verified",
  user_provided: "User provided",
  demo: "Demo",
  potentially_stale: "Potentially stale",
};

export function isContextProvenance(value: string): value is ContextProvenance {
  return (CONTEXT_PROVENANCE as readonly string[]).includes(value);
}
