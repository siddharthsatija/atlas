import "server-only";
import type {
  AssistantState,
  ExplanationAction,
  ExplanationSource,
  ExplanationView,
} from "@/lib/ai/explanation-view";
import { assetSummarySchema } from "../schemas/asset-summary";
import { explanationSchema } from "../schemas/explanation";
import type { FallbackExplanation } from "../fallback/finding-fallback";
import type { AiPolicyResult } from "../policy/ai-policy-service";

/**
 * Turns an `AiPolicyResult` into something a surface can render (ATL-053).
 *
 * ## Narrowing `value: unknown` honestly
 *
 * The policy layer types its payload `unknown` because the shape depends on the
 * purpose, and a cast here would be a promise nobody checked. Two contracts
 * already exist to narrow it, so nothing is duplicated:
 *
 *   - **AI**: `explanationSchema` — ATL-050's own Zod schema, re-parsed rather
 *     than redefined. It validated this value once already, so a failure here
 *     means the shape changed under us, and reporting `unavailable` is the
 *     honest response rather than rendering a half-formed answer.
 *   - **Fallback**: the `source: "fallback"` discriminant ATL-052 added for
 *     exactly this. The guard uses `in` narrowing, so TypeScript accepts the
 *     property access without an assertion.
 *
 * Neither path uses `as`.
 *
 * ## Sources are joined, not trusted
 *
 * An explanation cites ids. ATL-041 already resolved each evidence record to a
 * label and href, so those are joined by id. An id with no match is dropped
 * rather than rendered as a bare UUID — ATL-050's invariant layer has already
 * rejected references outside the context, so a gap here means an internal
 * mismatch, not a hallucination, and a user should not see either.
 */

/** The resolved evidence ATL-041 already computed for the panel. */
export interface ResolvedEvidence {
  id: string;
  label: string;
  href: string | null;
}

/**
 * Recognises ATL-052's deterministic explanation.
 *
 * `in` narrowing rather than a cast: after the guard TypeScript knows `value`
 * has a `source` property, so reading it is safe without asserting the whole
 * shape.
 */
function isFallbackExplanation(value: unknown): value is FallbackExplanation {
  if (typeof value !== "object" || value === null) return false;
  if (!("source" in value)) return false;
  return value.source === "fallback";
}

/** Joins cited ids to the labels ATL-041 resolved. Unmatched ids are dropped. */
function toSources(ids: readonly string[], evidence: readonly ResolvedEvidence[]) {
  const byId = new Map(evidence.map((record) => [record.id, record]));

  return ids.reduce<ExplanationSource[]>((sources, id) => {
    const record = byId.get(id);
    if (record) sources.push({ id, label: record.label, href: record.href });
    return sources;
  }, []);
}

export interface PresentInput {
  result: AiPolicyResult;
  /** Evidence the finding panel already resolved, for joining citations. */
  evidence: readonly ResolvedEvidence[];
}

/**
 * Builds the state a surface renders.
 *
 * `guidance` collapses to `unavailable`: the finding panel never asks a product
 * question, so that variant is unreachable here, and mapping it to a state the
 * panel understands is better than a branch that cannot run.
 */
export function presentExplanation({ result, evidence }: PresentInput): AssistantState {
  if (result.status === "consent_required") return { status: "consent_required" };
  if (result.status === "not_found") return { status: "not_found" };
  if (result.status !== "answered") return { status: "unavailable" };

  const disclosure = {
    classification: result.classification,
    recordCount: evidence.length,
  };

  const carriedId =
    result.interactionId === undefined ? {} : { interactionId: result.interactionId };

  if (result.source === "fallback") {
    if (!isFallbackExplanation(result.value)) return { status: "unavailable" };

    const explanation: ExplanationView = {
      source: "fallback",
      notice: result.value.notice,
      summary: result.value.summary,
      whyItMatters: result.value.whyItMatters,
      recommendedAction: result.value.recommendedAction,
      sources: toSources(result.value.evidenceReferences, evidence),
      /** Empty by construction — see `FallbackExplanationView.recommendedAction`. */
      actions: [],
      disclosures: [...result.value.disclosures],
      disclosure,
      ...carriedId,
    };

    return { status: "answered", explanation };
  }

  /**
   * Re-parsed with ATL-050's schema. It passed once inside the pipeline, so a
   * failure means the contract moved — `unavailable` rather than a partial
   * render.
   */
  const parsed = explanationSchema.safeParse(result.value);
  if (!parsed.success) return { status: "unavailable" };

  const actions: ExplanationAction[] = parsed.data.recommendedActions.map((action) => ({
    label: action.label,
    actionType: action.actionType,
    entityId: action.entityId,
  }));

  const explanation: ExplanationView = {
    source: "ai",
    summary: parsed.data.summary,
    whyItMatters: parsed.data.whyItMatters,
    /** The **model's** confidence. The finding's rule confidence is elsewhere. */
    confidence: parsed.data.confidence,
    uncertainties: [...parsed.data.uncertainties],
    sources: toSources(parsed.data.evidenceReferences, evidence),
    actions,
    disclosure,
    ...carriedId,
  };

  return { status: "answered", explanation };
}

export interface PresentAssetSummaryInput {
  result: AiPolicyResult;
  /** The asset, category and permission rows, resolved for display. */
  evidence: readonly ResolvedEvidence[];
  /** The service's own name, for the §11 scope disclosure. Never an id. */
  subjectName: string;
}

/**
 * Builds the state an asset surface renders (ATL-054).
 *
 * ## Why this is a second function and not a branch inside `presentExplanation`
 *
 * `presentExplanation` narrows `result.value` with `explanationSchema`, and an
 * asset summary does not satisfy it — no `whyItMatters`, no `confidence`, no
 * `recommendedActions`. Routing one through it would return `unavailable` on
 * every successful call: the surface would look like a permanent outage while
 * the model was answering correctly the whole time.
 *
 * The alternative was a purpose flag threaded into `presentExplanation` so it
 * could pick a schema. That makes one function's narrowing depend on an argument
 * rather than on the value it is narrowing, which is how the `checkInvariants`
 * ternary went wrong earlier in this ticket. Two functions, each parsing with the
 * schema that produced the value it is given, cannot make that mistake.
 *
 * Everything genuinely shared is shared: `toSources`, `ResolvedEvidence`, the
 * refusal mapping, and the interaction-id carry. `presentExplanation` is
 * unchanged.
 *
 * ## There is no fallback branch
 *
 * A locked ATL-054 decision: no deterministic asset summary exists, because
 * there is no rule to write one from — a finding has a rule definition to fall
 * back on and a service description does not. A `source: "fallback"` result here
 * therefore carries a `FallbackExplanation` about something else entirely, and
 * `unavailable` is the honest reading of it. The panel offers Try again, which
 * is the correct affordance for a temporary outage.
 */
export function presentAssetSummary({
  result,
  evidence,
  subjectName,
}: PresentAssetSummaryInput): AssistantState {
  if (result.status === "consent_required") return { status: "consent_required" };
  if (result.status === "not_found") return { status: "not_found" };
  if (result.status !== "answered") return { status: "unavailable" };
  if (result.source !== "ai") return { status: "unavailable" };

  const parsed = assetSummarySchema.safeParse(result.value);
  if (!parsed.success) return { status: "unavailable" };

  const carriedId =
    result.interactionId === undefined ? {} : { interactionId: result.interactionId };

  const explanation: ExplanationView = {
    source: "asset_summary",
    summary: parsed.data.summary,
    uncertainties: [...parsed.data.uncertainties],
    sources: toSources(parsed.data.evidenceReferences, evidence),
    disclosure: {
      classification: result.classification,
      recordCount: evidence.length,
      /**
       * The whole point of the disclosure on this surface. The name is the
       * user's own label for the service, resolved by the caller from the row it
       * fetched — never an identifier, and never taken from model output.
       */
      subjectName,
    },
    ...carriedId,
  };

  return { status: "answered", explanation };
}
