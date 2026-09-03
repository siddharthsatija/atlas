/**
 * Finding vocabularies (ATL-038, architecture §7.5 and §11.1).
 *
 * The application half of the deliberate duplication described in §7.2: the
 * migration constrains these values in SQL *and* they are listed here, because
 * §11.1's rules and ADR-004's factors read them, and a drifted value would
 * silently change what a rule means or what a score deducts.
 *
 * `finding_type` is the exception — shape-checked in SQL, vocabulary owned here,
 * the same split `digital_assets.category` uses. Adding a fifth category is then
 * an application change rather than a forward migration racing a constant.
 *
 * ATL-101 owns the rule catalog itself. Nothing here evaluates a predicate,
 * derives a confidence, or renders evidence; this module is the shared spelling
 * of the values those things produce.
 */

/**
 * What kind of concern a finding describes — §11.1's four rule categories.
 *
 * Not the rule's name. `rule_id` is null for demo-seeded findings (§7.5), so a
 * rule-named type would leave those typed after a rule that never ran, and would
 * duplicate `rule_id` everywhere else. The category is also the grouping a user
 * reads, which is what a type column is for.
 *
 * The mapping to the catalog, for reference: R-001/R-002 are `hygiene`,
 * R-003/R-006/R-008 are `exposure`, R-004/R-005 are `permissions`, R-007 is
 * `requests`.
 */
export const FINDING_TYPES = [
  { id: "hygiene", label: "Account hygiene" },
  { id: "exposure", label: "Data exposure" },
  { id: "permissions", label: "Permissions" },
  { id: "requests", label: "Requests" },
] as const;

export type FindingType = (typeof FINDING_TYPES)[number]["id"];

/**
 * How serious a finding is (§11.1).
 *
 * ADR-004's open-findings factor deducts 40, 25, 10 and 4 respectively, so these
 * are not adjectives — each one is a number subtracted from the user's score.
 * Frontend §8 reserves critical styling for genuinely critical, verified
 * findings.
 */
export const FINDING_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * Where a finding stands (§11.1's lifecycle: open → in_progress → resolved or
 * dismissed).
 *
 * ADR-004: a dismissed finding keeps its full deduction until the underlying
 * condition clears. Dismissal is the user saying "I have seen this", not "this
 * is no longer true", and the score reflects that distinction.
 */
export const FINDING_STATUSES = ["open", "in_progress", "resolved", "dismissed"] as const;

export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** The statuses that still count as live exposure — ADR-004's deduction population. */
export const OPEN_FINDING_STATUSES: readonly FindingStatus[] = ["open", "in_progress"];

/**
 * Who ended a finding.
 *
 * `system` means the rule's predicate stopped holding and the engine resolved it
 * (§11.1). The distinction is load-bearing: ADR-004's protective-actions factor
 * credits resolutions, and crediting the user for a condition that simply
 * expired would inflate the score for doing nothing.
 */
export const FINDING_RESOLVERS = ["user", "system"] as const;

export type FindingResolver = (typeof FINDING_RESOLVERS)[number];

/**
 * How much Atlas trusts a finding (§11.1's confidence model).
 *
 * Derived from the source and staleness of the inputs, never asserted by a rule:
 * inputs older than 180 days cap it at medium, older than 365 days at low, and a
 * finding's confidence is the minimum across its inputs. The same three values
 * as `digital_assets.confidence`, because it is the same scale.
 */
export const FINDING_CONFIDENCES = ["low", "medium", "high"] as const;

export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];

/**
 * Where the underlying records came from, reusing `digital_assets.source_type`.
 *
 * §11.1 pins only `demo`: findings generated over demo records carry it and are
 * removed with the demo data (ATL-083), and §11.2 forbids demo and real records
 * mixing in one calculation. The rest are inherited rather than invented.
 */
export const FINDING_SOURCE_TYPES = ["manual", "demo", "connector", "import", "discovery"] as const;

export type FindingSourceType = (typeof FINDING_SOURCE_TYPES)[number];

/**
 * Shape of a `finding_type`, matching the migration's check exactly.
 *
 * The database constrains the shape; the vocabulary above constrains the
 * meaning. Both are asserted against each other in the schema test, so the two
 * cannot drift without something failing.
 */
export const FINDING_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const TYPE_IDS: ReadonlySet<string> = new Set(FINDING_TYPES.map((entry) => entry.id));
const SEVERITIES: ReadonlySet<string> = new Set(FINDING_SEVERITIES);
const STATUSES: ReadonlySet<string> = new Set(FINDING_STATUSES);
const RESOLVERS: ReadonlySet<string> = new Set(FINDING_RESOLVERS);
const CONFIDENCES: ReadonlySet<string> = new Set(FINDING_CONFIDENCES);
const SOURCE_TYPES: ReadonlySet<string> = new Set(FINDING_SOURCE_TYPES);

export function isFindingType(value: string): value is FindingType {
  return TYPE_IDS.has(value);
}

export function isFindingTypeShape(value: string): boolean {
  return FINDING_TYPE_PATTERN.test(value);
}

export function isFindingSeverity(value: string): value is FindingSeverity {
  return SEVERITIES.has(value);
}

export function isFindingStatus(value: string): value is FindingStatus {
  return STATUSES.has(value);
}

export function isFindingResolver(value: string): value is FindingResolver {
  return RESOLVERS.has(value);
}

export function isFindingConfidence(value: string): value is FindingConfidence {
  return CONFIDENCES.has(value);
}

export function isFindingSourceType(value: string): value is FindingSourceType {
  return SOURCE_TYPES.has(value);
}

/** Whether a finding still counts as live exposure, for ADR-004's deductions. */
export function isOpenFinding(status: string): boolean {
  return OPEN_FINDING_STATUSES.some((open) => open === status);
}

/** Column defaults, mirroring the migration so callers need not restate them. */
export const DEFAULT_FINDING_STATUS: FindingStatus = "open";
export const DEFAULT_FINDING_CONFIDENCE: FindingConfidence = "medium";
export const DEFAULT_FINDING_SOURCE_TYPE: FindingSourceType = "manual";
