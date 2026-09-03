/**
 * Closed vocabularies for `digital_assets` (ATL-027, architecture §7.2).
 *
 * The migration constrains `status`, `source_type`, and `confidence` in SQL as
 * well. That duplication is deliberate and is the one place in this ticket where
 * a value is stated twice: these three drive the rules engine and the score
 * (§11 — R-002 reads `inactive`, R-006 reads `archived`, §11.2 keys demo
 * isolation on `demo`), so a value drifting into the table from a bad migration
 * or a direct write would quietly change what a rule means. Two gates, same
 * list, and the tests assert they agree.
 *
 * `category` is **not** here. It lives in `./categories.ts`, which ATL-016
 * created and documented as the single definition ATL-027 inherits — "a later
 * ticket may extend it, but it should not fork it". Re-listing it would be
 * exactly that fork.
 */

/**
 * Asset lifecycle (§7.2).
 *
 * `archived` and `removed` are distinct: archiving is a user putting an account
 * aside and is reversible (ATL-036), while `removed` records that the account
 * itself no longer exists. R-006 fires on the first and not the second, because
 * data left behind at a service the user has archived is still exposure.
 */
export const ASSET_STATUSES = ["active", "inactive", "archived", "removed"] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number];

/**
 * Where the record came from (§7.2).
 *
 * `demo` is the isolation key. §11.2 requires demo and real records never to mix
 * in one score calculation, and ATL-083 removes demo rows by this value, so it
 * is the one source that changes how a record is treated rather than merely how
 * it is labelled.
 */
export const ASSET_SOURCE_TYPES = ["manual", "demo", "connector", "import", "discovery"] as const;

export type AssetSourceType = (typeof ASSET_SOURCE_TYPES)[number];

/**
 * Confidence in the record (§11 "confidence is derived, not asserted").
 *
 * Stored rather than computed on read so a finding can inherit the minimum
 * across its inputs without replaying how each input aged. The derivation itself
 * belongs to the findings engine (ATL-101), not here.
 */
export const ASSET_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export type AssetConfidence = (typeof ASSET_CONFIDENCE_LEVELS)[number];

const STATUSES: ReadonlySet<string> = new Set(ASSET_STATUSES);
const SOURCE_TYPES: ReadonlySet<string> = new Set(ASSET_SOURCE_TYPES);
const CONFIDENCE_LEVELS: ReadonlySet<string> = new Set(ASSET_CONFIDENCE_LEVELS);

export function isAssetStatus(value: string): value is AssetStatus {
  return STATUSES.has(value);
}

export function isAssetSourceType(value: string): value is AssetSourceType {
  return SOURCE_TYPES.has(value);
}

export function isAssetConfidence(value: string): value is AssetConfidence {
  return CONFIDENCE_LEVELS.has(value);
}

/** Column defaults, mirroring the migration so callers need not restate them. */
/**
 * What `markReviewed` writes to `last_verified_at` (ATL-113).
 *
 * Not a timestamp, deliberately. The column is checked against the database's
 * `now()` by `digital_assets_last_verified_not_future`, and a value from this
 * process's clock compared against that one is a race — it rejected eleven
 * ordinary reviews in a single local run. `digital_assets_set_review_time`
 * resolves this sentinel to `now()` inside the same transaction as the check,
 * so the two can no longer disagree.
 *
 * `infinity` because it is always distinct from any stored value, can never be
 * mistaken for a real observation, and fails closed: without the trigger the
 * not-future constraint rejects it loudly rather than persisting a review date
 * that R-001 and ADR-004's freshness factor would then reason from.
 */
export const REVIEWED_NOW = "infinity";

export const DEFAULT_ASSET_STATUS: AssetStatus = "active";
export const DEFAULT_ASSET_SOURCE_TYPE: AssetSourceType = "manual";
export const DEFAULT_ASSET_CONFIDENCE: AssetConfidence = "medium";

/**
 * Bare hostname, no scheme and no path — the same expression the migration
 * enforces.
 *
 * A URL would invite storing a full profile link, which is a more identifying
 * thing than the service a person uses, and §7.2 asks for a domain.
 */
export const SERVICE_DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isServiceDomain(value: string): boolean {
  return SERVICE_DOMAIN_PATTERN.test(value);
}

/** Column bounds, mirroring the migration's `char_length` checks. */
export const MAX_SERVICE_NAME_LENGTH = 200;
export const MAX_SOURCE_LABEL_LENGTH = 120;
export const MAX_NOTES_LENGTH = 2000;
