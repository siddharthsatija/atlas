import {
  array,
  object,
  redact,
  scalar,
  type FieldPolicy,
  type RedactionOutcome,
} from "@/lib/telemetry/redaction";

/**
 * Allowlist for `digital_assets.metadata_json` (ATL-027).
 *
 * The acceptance criterion is "`metadata_json` schema-validated". This is that
 * validation, built on the ATL-085 redaction utility and the same `FieldPolicy`
 * shape ATL-068 uses for activity metadata — not a parallel validator. One
 * allowlist mechanism means one place to audit when the question is "can a
 * personal value reach storage?".
 *
 * ## Why an allowlist rather than a shape check
 *
 * A "flat object of scalars, bounded length" rule would validate the *form* of
 * the payload and nothing about its meaning, so `{ "email": "dana@example.com" }`
 * would pass. Architecture §7.2 does not enumerate this column's contents, and
 * an unenumerated free-form column on the product's central table is precisely
 * where restricted values end up. Keys are therefore listed, and anything not
 * listed is dropped rather than stored.
 *
 * ## Deliberately absent
 *
 * Any identifier, handle, username, email, phone, or URL. The account identifier
 * has its own encrypted column; the service has `service_name` and
 * `service_domain`. A second, unencrypted place to put an identifier would
 * defeat both — and `metadata_json` is not covered by the §8 encrypted-column
 * inventory, so anything restricted landing here would be stored in plaintext.
 *
 * Free text is absent for the same reason: `notes` is the one field a user may
 * type into, it is bounded and classified, and duplicating that capability here
 * would create a second path with none of the same handling.
 *
 * ## Growing this list
 *
 * Later tickets will need keys — ATL-032's creation form and connector imports
 * most obviously. Each addition belongs with the ticket that needs it, with a
 * justification, and must stay non-restricted. Widening this list is a security
 * decision, not a convenience one.
 */

/** Lowercase snake vocabulary: plan tiers, account kinds, and similar labels. */
const VOCABULARY = /^[a-z][a-z0-9_]{0,63}$/;

/** ISO-8601 date, date only — no time, which would narrow to a session. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const matches = (pattern: RegExp) => (value: unknown) =>
  typeof value === "string" && pattern.test(value);

const isInt = (min: number, max: number) => (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const isBoolean = (value: unknown) => typeof value === "boolean";

export const ASSET_METADATA_POLICY: FieldPolicy = {
  /** Subscription tier, e.g. `free`, `premium`. A label, not an entitlement. */
  plan: scalar(matches(VOCABULARY)),
  /** Kind of account, e.g. `personal`, `business`, `shared`. */
  accountKind: scalar(matches(VOCABULARY)),
  /** Whether the user reports multi-factor authentication on this account. */
  mfaEnabled: scalar(isBoolean),
  /** Date only: when the account was opened, as far as the user knows. */
  openedOn: scalar(matches(ISO_DATE)),
  /** Counts carry no identity, which is what makes them safe here. */
  linkedAccountCount: scalar(isInt(0, 10_000)),

  /**
   * Provenance for imported and connector-sourced records.
   *
   * Nested rather than flattened so the origin of a record reads as one fact.
   * `reference` is a vocabulary token — an importer's own label for a batch —
   * never a URL or an account handle.
   */
  importSource: object({
    provider: scalar(matches(VOCABULARY)),
    reference: scalar(matches(VOCABULARY)),
    importedOn: scalar(matches(ISO_DATE)),
  }),

  /**
   * Free-form user labels, from a constrained vocabulary.
   *
   * Bounded by the array cap in the redaction utility. Tags are the one place a
   * user's own organising scheme belongs, and the vocabulary pattern is what
   * keeps a tag from becoming a sentence — or an email address.
   */
  tags: array(scalar(matches(VOCABULARY))),
};

export type AssetMetadata = Record<string, unknown>;

/**
 * Filters metadata to the allowlist.
 *
 * Returns the drop and redaction counts alongside the value rather than
 * swallowing them, so a caller — and a test — can tell "nothing was removed"
 * from "the whole payload was removed". The repository surfaces a non-empty
 * count as a telemetry warning, matching the activity and audit writers.
 */
export function redactAssetMetadata(
  metadata: AssetMetadata | undefined,
): RedactionOutcome<AssetMetadata> {
  return redact<AssetMetadata>(metadata ?? {}, ASSET_METADATA_POLICY);
}
