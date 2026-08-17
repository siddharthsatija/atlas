import type {
  FindingConfidence,
  FindingSeverity,
  FindingSourceType,
  FindingType,
} from "../findings";

/**
 * The shape of a rule, and the snapshot rules run against (ATL-101, ADR-001).
 *
 * Everything in this file and its catalog is **pure**. A rule receives a
 * snapshot of the user's records and returns what it concluded; it reads no
 * database, calls no service, and knows nothing about how its output is stored.
 * That is what makes ADR-001's "auditable and testable: rules are pure functions
 * with table-driven tests" achievable rather than aspirational — a rule's test
 * builds a snapshot literal and asserts the output, with no fixtures and no
 * mocking.
 *
 * The engine (`src/server/findings/findings-engine.ts`) owns everything this
 * layer deliberately does not: loading the snapshot, hashing dedup keys, writing
 * rows, resolving findings whose predicate cleared, and emitting activity.
 */

/** One asset, as a rule sees it. A projection of `DigitalAssetRecord`. */
export interface AssetInput {
  id: string;
  serviceName: string;
  category: string;
  status: string;
  sourceType: FindingSourceType;
  lastVerifiedAt: string | null;
  createdAt: string;
}

/** One data category on one asset. A projection of `AssetDataCategoryRecord`. */
export interface DataCategoryInput {
  id: string;
  assetId: string;
  category: string;
  /** Derived by the database from the category (ADR-004's high-sensitivity set). */
  sensitivity: string;
  createdAt: string;
}

/** One permission on one asset. A projection of `AssetPermissionRecord`. */
export interface PermissionInput {
  id: string;
  assetId: string;
  permissionType: string;
  scope: string;
  status: string;
  lastVerifiedAt: string | null;
  createdAt: string;
}

/**
 * Everything the catalog may read, and nothing else.
 *
 * `now` is passed in rather than read from the clock, so every time-based
 * predicate — R-001's 180 days, R-005's 365 — is a pure function of its input.
 * A rule that called `Date.now()` itself could not be tested at a boundary
 * without freezing time globally, and two rules in one evaluation could disagree
 * about what "now" was.
 *
 * **There is no `requests` field.** `data_requests` (§7.7) has no migration yet,
 * so R-007 is not in this catalog and R-006 evaluates only the conjunct it can
 * see. Adding an empty array here would let a rule read a set that means "no
 * requests exist" when it actually means "requests are not implemented", which
 * are different claims.
 */
export interface RuleInputs {
  assets: readonly AssetInput[];
  dataCategories: readonly DataCategoryInput[];
  permissions: readonly PermissionInput[];
  /** Evaluation time, injected so predicates stay pure and boundary-testable. */
  now: Date;
}

/**
 * What a rule concluded about one condition.
 *
 * Deliberately not a finding row. A candidate has no id, no status, no
 * timestamps and no dedup key — the engine derives those. A rule that returned a
 * storable row would be making decisions (when it fired, whether it is new)
 * that belong to the layer that can see the existing findings.
 */
export interface RuleCandidate {
  /** The asset this is about, or null for a footprint-wide condition (R-008). */
  assetId: string | null;
  severity: FindingSeverity;
  /**
   * Every record the rule actually read to reach this conclusion.
   *
   * Two jobs: `evidence_refs_json` (§11.1's evidence model) and the dedup key,
   * whose scope is exactly "the entity IDs in scope". Ordering does not matter —
   * the engine sorts before hashing.
   */
  evidence: EvidenceRefs;
  /**
   * Rendered from the rule's own template using only non-restricted values —
   * service names, categories, dates, counts (§11.1). Never an account
   * identifier, never a note, never free text the user typed.
   */
  evidenceSummary: string;
  title: string;
  description: string;
  /**
   * The sources and dates the engine derives confidence from.
   *
   * The rule reports what it read; `deriveConfidence` decides how much that is
   * worth. §11.1: "confidence is derived, not asserted" — a rule that returned a
   * confidence could claim high confidence in a record it had not checked in a
   * year.
   */
  inputs: readonly ConfidenceInput[];
}

/** Record ids the rule evaluated, grouped by kind. Identifiers only, never values. */
export interface EvidenceRefs {
  assetIds?: readonly string[];
  dataCategoryIds?: readonly string[];
  permissionIds?: readonly string[];
}

/** One input's provenance and age, for §11.1's confidence derivation. */
export interface ConfidenceInput {
  sourceType: FindingSourceType;
  /** When the record was last confirmed, or null when it never has been. */
  lastVerifiedAt: string | null;
  /** Fallback age when nothing has been verified: when the record was created. */
  createdAt: string;
}

/**
 * One rule in the catalog (ADR-001: each rule declares its inputs, predicate,
 * severity mapping, confidence mapping, evidence template, and recommended
 * action).
 *
 * `recommendedAction` is a property rather than a per-candidate string because
 * §11.1 attaches it to the rule, not to the occurrence — every stale review is
 * fixed the same way, and letting a rule vary it per candidate would make the
 * catalog's advice unreviewable.
 */
export interface Rule {
  /** Stable across versions. Appears in `source_reference` as `rule_id@version`. */
  id: string;
  /** §11.1's rule category, stored as the finding's `finding_type`. */
  type: FindingType;
  recommendedAction: string;
  /** Pure. Same snapshot in, same candidates out, in a stable order. */
  evaluate(inputs: RuleInputs): RuleCandidate[];
}

/** A candidate paired with the rule that produced it. */
export interface EvaluatedCandidate extends RuleCandidate {
  ruleId: string;
  findingType: FindingType;
  recommendedAction: string;
  confidence: FindingConfidence;
}
