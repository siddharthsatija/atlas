/**
 * Consent vocabulary (ATL-078).
 *
 * Deliberately in `lib/` rather than `server/`: Settings renders consent history
 * (ATL-076) and the onboarding flow captures AI-processing consent (ATL-016),
 * so both server code and UI need these names. The layer boundaries stop
 * components importing `src/server`, so a type parked there would have to be
 * duplicated for the UI — and two lists of consent types that drift apart is
 * exactly how a gate ends up checking a type nothing ever writes.
 *
 * This module holds no logic and reads no secret, so it is safe to import
 * anywhere. Recording and checking consent are server-only and live in
 * `src/server/consent`.
 */

/**
 * The four MVP consent types (ATL-078, PRD §12, ADR-002).
 *
 * Mirrored by a check constraint on `consents.consent_type`. Both exist on
 * purpose: the constraint stops an unrecognised value reaching storage, and the
 * union stops one being written in the first place.
 */
export const CONSENT_TYPES = [
  /** Processing a user's data with the AI assistant. Captured at onboarding. */
  "ai_processing",
  /** Storing identity fields in the encrypted vault (ADR-002). */
  "personal_fields_storage",
  /** Retaining AI conversation history rather than discarding it. */
  "ai_conversation_history",
  /** Optional product update emails. The only non-functional consent here. */
  "product_updates",
] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

const TYPES: ReadonlySet<string> = new Set(CONSENT_TYPES);

export function isConsentType(value: string): value is ConsentType {
  return TYPES.has(value);
}
