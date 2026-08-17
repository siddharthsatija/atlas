import type { InputClassification } from "./interaction-vocabulary";

/**
 * The view model an assistant surface renders (ATL-053).
 *
 * In `lib/` and deliberately free of server imports: the client component types
 * its props from here, while the builder that produces it stays server-side
 * (`src/server/ai/presentation/`). Splitting them is what lets a client render
 * an explanation without pulling `server-only` modules into the bundle.
 *
 * ## Why AI and fallback are separate variants
 *
 * ATL-052 made `source` a discriminant precisely so a surface cannot confuse the
 * two, and ATL-055 kept model confidence off the deterministic path. Encoding
 * that here means a component **cannot** render an AI confidence on a fallback:
 * the field does not exist on that variant, so it is a type error rather than a
 * code review catch.
 *
 * `confidence` on the AI variant is the **model's** certainty about its own
 * reasoning. It is not the finding's rule confidence, which ADR-001 derives from
 * source and staleness and which the finding panel already renders separately.
 * The two must never be shown under one label.
 */

/** One evidence record the explanation cites, resolved for display (ATL-041). */
export interface ExplanationSource {
  id: string;
  /** What the record is, in the user's words. Never an identifier. */
  label: string;
  /** Where it can be seen, or null when it no longer exists. */
  href: string | null;
}

/** A next step the assistant proposed. Proposals only — never executed. */
export interface ExplanationAction {
  label: string;
  actionType: string;
  entityId: string;
}

/** What was actually sent to the provider, for the §11 context disclosure. */
export interface ContextDisclosure {
  classification: InputClassification;
  /** How many of the user's records entered the context block. */
  recordCount: number;
  /**
   * The one record retrieval was scoped to, in the user's own words (ATL-054).
   *
   * Present only where the scope is a *choice the user should be able to check*.
   * On an asset page the whole privacy claim is "only this service was read",
   * and a disclosure that does not name the service cannot be verified by the
   * person reading it — they would have to take the scope on trust, which is the
   * thing §11 exists to avoid.
   *
   * Absent on the finding panel, where the subject is the finding the drawer is
   * already titled with, so naming it again would be repetition rather than
   * disclosure.
   *
   * A **label**, never an identifier: this is displayed prose.
   */
  subjectName?: string | undefined;
}

interface ExplanationBase {
  summary: string;
  whyItMatters: string;
  /** Records the explanation cites, joined back to their resolved labels. */
  sources: ExplanationSource[];
  actions: ExplanationAction[];
  disclosure: ContextDisclosure;
  /**
   * The `ai_interactions` row, when one exists (task #109).
   *
   * Feedback is offered only when present — there is nothing to attach it to
   * otherwise.
   */
  interactionId?: string | undefined;
}

export interface AiExplanationView extends ExplanationBase {
  source: "ai";
  /** The **model's** certainty about its own reasoning. Never the rule's. */
  confidence: "low" | "medium" | "high";
  uncertainties: string[];
}

export interface FallbackExplanationView extends ExplanationBase {
  source: "fallback";
  /** Why deterministic text is being shown instead of an AI answer. */
  notice: string;
  /**
   * The rule's recommended action, as prose.
   *
   * Not an `ExplanationAction`: those carry an `actionType` and an `entityId`,
   * and the deterministic path has neither. Inventing them to make the two
   * shapes match would turn a sentence into a button that claims to know what
   * it operates on. So `actions` stays empty on this variant and the
   * recommendation is rendered as text.
   */
  recommendedAction: string;
  /** Demo and staleness disclosures (AI behavior §4). */
  disclosures: string[];
  /**
   * No `confidence`. There is no model, so any value would be fabricated, and
   * reusing the finding's rule confidence would put a different quantity under
   * the same name.
   */
}

/**
 * An asset summary (ATL-054).
 *
 * ## Why this is a third variant and not a reuse of `AiExplanationView`
 *
 * Reuse was tried first and is not available, for two independent reasons — and
 * both are the view model working, not failing.
 *
 * `AiExplanationView` requires `whyItMatters` and `confidence`. The
 * `asset_summary` schema has neither, deliberately: the prompt says "describe
 * what is recorded, do not evaluate", so there is no judgement to justify, and
 * the schema note explains why a certainty score does not belong on a
 * description of the user's own records. Rendering this through the AI variant
 * would mean **fabricating both** — inventing a sentence of significance the
 * model never wrote, and a confidence it never expressed. That is precisely the
 * substitution `FallbackExplanationView` already refuses to make for the
 * deterministic path, for the same reason.
 *
 * ## No `actions`
 *
 * Not "an empty array by construction" as on the fallback variant, but absent.
 * The schema has no action concept at all, so an always-empty field would imply
 * this surface could propose next steps and simply had none this time. It
 * cannot, and the missing field says so to the compiler as well as the reader.
 */
export interface AssetSummaryView {
  source: "asset_summary";
  summary: string;
  /** The asset, category and permission rows the summary cites. */
  sources: ExplanationSource[];
  uncertainties: string[];
  disclosure: ContextDisclosure;
  interactionId?: string | undefined;
}

/**
 * Every answer shape a surface can render.
 *
 * Three-wide because one component renders all three. Adding a fourth is a
 * compile error at every `switch` on `source`, which is the property that stops
 * a new purpose being rendered through a renderer built for a different shape.
 */
export type ExplanationView = AiExplanationView | FallbackExplanationView | AssetSummaryView;

/** Everything an assistant surface can be showing. */
export type AssistantState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "answered"; explanation: ExplanationView }
  | { status: "consent_required" }
  | { status: "unavailable" }
  /** The finding is gone, or was never the caller's. Indistinguishable. */
  | { status: "not_found" };

/**
 * The outcome of submitting feedback on an answer (AI behavior §12).
 *
 * `unavailable` covers both a storage failure and an interaction that is not the
 * caller's — deliberately one status, because distinguishing them would tell a
 * caller whether some id names a real row, which is the disclosure the finding
 * lookups already refuse to make.
 */
export type AiFeedbackState =
  { status: "idle" } | { status: "recorded" } | { status: "unavailable" };
