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

/**
 * The three discovery consent types (ATL-205, ADR-007 §5, ADR-008 §12).
 *
 * Kept separate from the MVP `CONSENT_TYPES` so the existing `ConsentType` guard
 * (`isConsentType`) stays scoped to the four MVP types — preserving existing UI
 * and API validation boundaries. Discovery consent is granted/revoked through
 * `DiscoveryConsentService`, not through the general consent endpoints.
 *
 * The provider-class string and the consent-type string are identical for all
 * three discovery types (ADR-007 §5 table). No lookup table is needed; the
 * mapping is the identity function.
 *
 * Mirrored by the `consents.consent_type` check constraint (ATL-200 migration).
 */
export const DISCOVERY_CONSENT_TYPES = [
  /** Partial SHA-1 prefix lookup (HIBP k-anonymity). Plaintext email never leaves Atlas. */
  "discovery_hashed_query",
  /** Handle or value transmitted to a third-party API (username enumeration). */
  "discovery_identifying",
  /** Per-connection OAuth inward access grant. Deferred — ADR-008 §11. */
  "discovery_connected_sources",
] as const;

export type DiscoveryConsentType = (typeof DISCOVERY_CONSENT_TYPES)[number];

const DISCOVERY_TYPES: ReadonlySet<string> = new Set(DISCOVERY_CONSENT_TYPES);

export function isDiscoveryConsentType(value: string): value is DiscoveryConsentType {
  return DISCOVERY_TYPES.has(value);
}
