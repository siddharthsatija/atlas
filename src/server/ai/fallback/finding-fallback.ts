import {
  AI_DISABLED_NOTICE,
  FALLBACK_DEMO_NOTE,
  FALLBACK_LOW_CONFIDENCE_NOTE,
  FALLBACK_NOTICE,
  FALLBACK_WHY_PREFIX,
} from "@/lib/ai/fallback-copy";
import type { FindingConfidence, FindingSourceType } from "@/lib/findings/findings";

/**
 * The deterministic finding explanation (ATL-052, AI behavior §11).
 *
 * ## Why this is a different type, not an `ExplanationOutput`
 *
 * ATL-050's explanation schema carries `confidence`, documented as *the model's*
 * certainty about its own reasoning. A deterministic explanation has no model,
 * so any value in that field would be a fabrication — and copying the finding's
 * rule confidence into it would be worse, because the two mean different things
 * and the UI would render one as the other.
 *
 * So the fallback is its own type with no `confidence` field at all. It shares
 * `summary`, `whyItMatters`, `recommendedAction` and `evidenceReferences` so
 * ATL-055 can render both through one component, and the discriminant `source`
 * makes the difference impossible to lose.
 *
 * ## Still rule-derived, without touching the catalog
 *
 * The ticket asks for "rule-based template text (from the rule catalog's
 * evidence templates)". Those templates are applied at evaluation time and
 * rendered into `evidenceSummary`, which is stored on the finding — there is no
 * separate template artefact to render from later. Building the fallback from
 * the persisted fields therefore *is* using the rule's template output, and it
 * avoids adding an explanation template to `catalog.ts`, which would trip the
 * documented rule that changing any template there requires bumping
 * `RULES_VERSION` — re-stamping the provenance of findings whose logic never
 * changed.
 *
 * ## Nothing here is generated
 *
 * Every sentence is either a fixed constant or a persisted field. There is no
 * interpolation of user free text beyond what the rule engine already committed
 * to `evidenceSummary`, which §11.1 guarantees contains no restricted values.
 *
 * ## `severity` is deliberately not read
 *
 * It was on the approved source list, but it earns no place in the prose: the
 * finding surface already renders severity as its own element, and restating
 * "this is a high-severity finding" would duplicate a badge rather than tell the
 * user anything. An input the builder never reads is dead weight that invites
 * someone to start using it inconsistently later, so it is absent from the input
 * type rather than accepted and ignored.
 */

/** The subset of a finding this builder reads. Persisted fields only. */
export interface FallbackFindingInput {
  id: string;
  title: string;
  description: string;
  evidenceSummary: string;
  recommendedAction: string;
  confidence: FindingConfidence;
  sourceType: FindingSourceType;
  /** Evidence record ids already resolved by `FindingService.getFindingDetail`. */
  evidenceIds: readonly string[];
}

/**
 * A deterministic explanation.
 *
 * **No `confidence`.** See the module note: the schema's field means model
 * certainty, and there is no model here. The finding's own rule confidence stays
 * on the finding, where it has a truthful meaning and the UI already renders it.
 */
export interface FallbackExplanation {
  readonly source: "fallback";
  /** Why the user is seeing deterministic text rather than an AI answer. */
  readonly notice: string;
  readonly summary: string;
  readonly whyItMatters: string;
  readonly recommendedAction: string;
  /** Ids of records the rule actually read. Always a subset of what was stored. */
  readonly evidenceReferences: readonly string[];
  /** Disclosures §4 requires: demo data, unverified sources. */
  readonly disclosures: readonly string[];
}

/** Why the deterministic path was taken. Decides the notice, nothing else. */
export type FallbackReason = "ai_unavailable" | "ai_disabled";

/**
 * Builds the explanation.
 *
 * Pure and total: given a finding it always produces something renderable, which
 * is the point — this is the path that runs when everything else failed, so it
 * cannot have failure modes of its own.
 */
export function buildFindingFallback(
  finding: FallbackFindingInput,
  reason: FallbackReason = "ai_unavailable",
): FallbackExplanation {
  const disclosures: string[] = [];

  /**
   * §4: demo data must be disclosed. The rule engine marks demo-seeded findings
   * with `source_type = 'demo'`, so this is read rather than inferred.
   */
  if (finding.sourceType === "demo") disclosures.push(FALLBACK_DEMO_NOTE);

  /**
   * ADR-001 derives confidence from source and staleness. Reporting a `low`
   * derivation in words is honest; restating it as a number the user cannot act
   * on is not.
   */
  if (finding.confidence === "low") disclosures.push(FALLBACK_LOW_CONFIDENCE_NOTE);

  return Object.freeze({
    source: "fallback",
    notice: reason === "ai_disabled" ? AI_DISABLED_NOTICE : FALLBACK_NOTICE,
    summary: finding.title,
    /**
     * `description` says what the condition is; `evidenceSummary` says what the
     * rule actually read. Together they answer "why does this matter to me"
     * without a model, and both were produced by the versioned rule.
     */
    whyItMatters:
      `${FALLBACK_WHY_PREFIX}: ${finding.description} ${finding.evidenceSummary}`.trim(),
    recommendedAction: finding.recommendedAction,
    /**
     * The finding's own id is included alongside its evidence records: it is the
     * record this explanation is about, and ATL-050's invariant model treats an
     * explanation citing nothing as ungrounded.
     */
    evidenceReferences: Object.freeze([finding.id, ...finding.evidenceIds]),
    disclosures: Object.freeze(disclosures),
  });
}
