import "server-only";
import type { AiFallbackProvider, StructuredCompletionRequest } from "../structured-completion";
import { buildFindingFallback, type FallbackReason } from "./finding-fallback";

/**
 * The deterministic fallback provider (ATL-052).
 *
 * Fills the seam ATL-050 built and ATL-049 left inert. Every failure path —
 * provider outage, rate limit, schema-invalid twice, invariant violation — now
 * arrives here, and this decides whether Atlas has something honest to say.
 *
 * ## It answers only for purposes it can actually serve
 *
 * `explain_finding` is the one purpose with deterministic source material: a
 * finding carries a title, description, evidence summary and recommended action,
 * all rendered by a versioned rule. Nothing equivalent exists for the other
 * purposes — a "deterministic asset summary" would be prose nobody wrote and no
 * rule produced. So this returns `null` for them, which the completion service
 * reports as `unavailable`, and the caller shows the calm unavailable message
 * rather than invented content.
 *
 * That is deliberately narrower than "every AI surface has a fallback". It is
 * also the only honest reading while `explain_finding` is the only registered
 * prompt: a surface that cannot run cannot fail, so it needs nothing to fail to.
 *
 * ## Synchronous, and that is a design constraint
 *
 * `provide` does no I/O. The records it needs travel on the request
 * (`fallbackSubject`), placed there by the policy layer that already retrieved
 * them. A fallback that queried the database would add a failure mode to the
 * path that exists because something else already failed.
 */
export class DeterministicFallbackProvider implements AiFallbackProvider {
  private readonly reason: FallbackReason;

  constructor(reason: FallbackReason = "ai_unavailable") {
    this.reason = reason;
  }

  provide(request: StructuredCompletionRequest): unknown {
    /**
     * No subject means the policy layer had nothing deterministic to offer —
     * either the purpose has no fallback source, or retrieval returned nothing.
     * `null` is the seam's "none available" signal.
     */
    if (!request.fallbackSubject) return null;
    if (request.prompt.purpose !== "explain_finding") return null;

    return buildFindingFallback(request.fallbackSubject, this.reason);
  }
}

/**
 * The provider used when AI is switched off (`AI_ENABLED=false`).
 *
 * Same content, different notice: "turned off" rather than "temporarily
 * unavailable", because telling a user something is temporarily broken when an
 * operator disabled it is a small lie, and small lies about the assistant erode
 * trust in everything around it.
 */
export const disabledFallbackProvider = new DeterministicFallbackProvider("ai_disabled");

/** The provider used when the AI path ran and failed. */
export const outageFallbackProvider = new DeterministicFallbackProvider("ai_unavailable");
