/**
 * Permission vocabularies and the broad-scope classification (ATL-029, §7.4).
 *
 * ## Only two values were documented
 *
 * §7.4 names the columns and enumerates none of them. Across the whole
 * specification exactly two permission values appear: `broad` (§11 R-004,
 * ADR-004) and `active` (R-004, R-005). Everything else here was settled as a
 * product decision, and each list is the smallest set that satisfies the rules
 * reading it — widening any of them later is additive, narrowing is not.
 *
 * ## Scope is a classification, not the grant
 *
 * ADR-004's permission factor is `100 × (1 − broad-scope active ÷ total
 * recorded)` and R-004 asks only "is this broad?". Both consumers need a binary,
 * so `scope` is that binary rather than a description of what the service may
 * do. Storing the provider's raw scope string would put free text on a child
 * table — where restricted values land — and deriving breadth from it would mean
 * inventing both a vocabulary and a mapping that no document describes.
 */

/**
 * How much a permission grants.
 *
 * `broad` is the documented value; `limited` is its complement. A richer scope
 * vocabulary can be added later without changing what the score reads, because
 * the score reads this classification and not the underlying grant.
 */
export const PERMISSION_SCOPES = ["broad", "limited"] as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/**
 * Where a permission stands.
 *
 * `active` is documented — R-004 and R-005 both scope themselves to it.
 * `revoked` records the user's own action, which is the point of tracking
 * permissions at all. `unknown` exists because the product's honesty rules do
 * not let it force someone to assert a definite state about something they
 * cannot currently check.
 */
export const PERMISSION_STATUSES = ["active", "revoked", "unknown"] as const;

export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

const SCOPES: ReadonlySet<string> = new Set(PERMISSION_SCOPES);
const STATUSES: ReadonlySet<string> = new Set(PERMISSION_STATUSES);

export function isPermissionScope(value: string): value is PermissionScope {
  return SCOPES.has(value);
}

export function isPermissionStatus(value: string): value is PermissionStatus {
  return STATUSES.has(value);
}

/** Column defaults, mirroring the migration so callers need not restate them. */
export const DEFAULT_PERMISSION_STATUS: PermissionStatus = "active";

/**
 * Shape of a `permission_type`, matching the migration's check exactly.
 *
 * The database constrains the shape; the vocabulary below constrains the
 * meaning. That split is ATL-029's decision — a SQL enum would make every future
 * addition a forward migration racing an application constant.
 */
export const PERMISSION_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function isPermissionTypeShape(value: string): boolean {
  return PERMISSION_TYPE_PATTERN.test(value);
}

/**
 * What kind of permission a service holds (ATL-033).
 *
 * **No document defines these.** §7.4 names the column and nothing more; R-004,
 * R-005 and ADR-004 all read `scope` and `status` and never the type. The list
 * was therefore settled as a product decision, and it is grouped by *what the
 * permission lets the service do to the user* rather than by any provider's
 * naming — the same question the product asks everywhere else.
 *
 * `other` exists so an incomplete list never blocks someone recording something
 * real. It is last deliberately: an escape hatch that appears first becomes the
 * default answer.
 *
 * Enforced in the service and rendered as a fixed choice, which is what stops
 * `oauth` and `oauth_access` becoming two permissions describing one grant —
 * both of which would count in ADR-004's "total recorded" denominator and move
 * the user's score without their exposure changing.
 */
export const PERMISSION_TYPES = [
  {
    id: "account_access",
    label: "Act on your behalf",
    hint: "Sign in as you, or use your account elsewhere",
  },
  {
    id: "data_sharing",
    label: "Share your data",
    hint: "Pass what it holds about you to other companies",
  },
  {
    id: "marketing",
    label: "Marketing and profiling",
    hint: "Contact you, or build a profile to target you",
  },
  {
    id: "device_access",
    label: "Reach your device",
    hint: "Camera, microphone, location, contacts, or files",
  },
  { id: "other", label: "Something else", hint: "Anything the options above do not cover" },
] as const;

export type PermissionTypeId = (typeof PERMISSION_TYPES)[number]["id"];

const TYPE_IDS: ReadonlySet<string> = new Set(PERMISSION_TYPES.map((entry) => entry.id));

export function isPermissionType(value: string): value is PermissionTypeId {
  return TYPE_IDS.has(value);
}

/** One permission, as the classification helpers below need to see it. */
export interface ClassifiablePermission {
  scope: string;
  status: string;
}

/**
 * Whether a permission counts toward R-004 and ADR-004's numerator.
 *
 * Both conditions, not either: R-004 is "**Active** permission with **broad**
 * scope", and ADR-004 counts "broad-scope **active** permissions". A revoked
 * broad permission is not current exposure — counting it would mean revoking
 * something never improved the user's score, which would make the number
 * useless as feedback on the actions Atlas asks them to take.
 */
export function isBroadExposure(permission: ClassifiablePermission): boolean {
  return permission.scope === "broad" && permission.status === "active";
}

/**
 * ADR-004's permission-exposure factor: `100 × (1 − broad active ÷ total
 * recorded)`, rounded.
 *
 * Lives here rather than in the score module because the arithmetic is a
 * property of this vocabulary — "total recorded" means *every* row regardless of
 * status, and that asymmetry with the numerator is easy to get wrong somewhere
 * further away. ATL-039 owns the score itself and is expected to call this.
 *
 * Returns `null` for an empty set rather than 100. ADR-004: "a factor with no
 * underlying records is excluded and remaining weights are renormalized" — a
 * perfect score for having recorded nothing is exactly the false confidence the
 * score-coverage rule exists to prevent.
 */
export function permissionExposureScore(
  permissions: readonly ClassifiablePermission[],
): number | null {
  if (permissions.length === 0) return null;

  const broad = permissions.filter(isBroadExposure).length;
  return Math.round(100 * (1 - broad / permissions.length));
}
