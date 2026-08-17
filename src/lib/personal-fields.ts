/**
 * Personal-field vocabulary (ATL-105, ADR-002, architecture §7.13).
 *
 * Deliberately in `lib/` rather than `server/`, for the reason `src/lib/consent.ts`
 * gives: Settings renders this list (ATL-106) and the draft approval step will
 * offer it as checkboxes (ATL-058), so both server code and UI need these names.
 * The layer boundaries stop components importing `src/server`, so a type parked
 * there would have to be duplicated for the UI — and two lists that drift apart
 * is how a gate ends up checking a key nothing ever writes.
 *
 * This module holds no logic and reads no secret, so it is safe to import
 * anywhere. Storing, reading and revealing values are server-only and live in
 * `src/server/personal-fields`.
 */

/**
 * The six field keys architecture §7.13 enumerates.
 *
 * Mirrored by a check constraint on `user_personal_fields.field_key`. Both exist
 * on purpose: the constraint stops an unrecognised value reaching storage, and
 * the union stops one being written in the first place.
 */
export const PERSONAL_FIELD_KEYS = [
  /** Legal or preferred name, as a service would know it. */
  "full_name",
  /** The address used *with a given service*, which often is not the sign-in one. */
  "email",
  "phone",
  "address",
  /** A service-specific handle, where an email is not the identifier. */
  "username",
  /** Anything the five above do not describe. The label carries the meaning. */
  "other",
] as const;

export type PersonalFieldKey = (typeof PERSONAL_FIELD_KEYS)[number];

const KEYS: ReadonlySet<string> = new Set(PERSONAL_FIELD_KEYS);

export function isPersonalFieldKey(value: string): value is PersonalFieldKey {
  return KEYS.has(value);
}

/** Matches the `label` check constraint, so the two cannot disagree. */
export const PERSONAL_FIELD_LABEL_MAX_LENGTH = 100;
