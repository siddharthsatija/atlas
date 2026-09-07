"use client";

/**
 * Candidate review section (ATL-211).
 *
 * Renders the full list of candidates (pending, dismissed, not_sure) in three
 * visual sections:
 *
 *   PRIMARY   — pending candidates + any inline confirmed cards
 *   NOT SURE  — candidates the user marked as "not sure"
 *   DEFERRED  — candidates the user dismissed
 *
 * ATL-208 prohibits mutations from `dismissed` or `not_sure` states, so
 * CandidateCard renders those variants with no action buttons. Only the PRIMARY
 * section contains cards with buttons.
 *
 * ## Local outcome tracking
 *
 * After a successful adjudication action, CandidateCard calls `onOutcomeChange`
 * with the new outcome. This section keeps an `outcomeMap` in local state and
 * uses it to override `candidate.status` for grouping — so dismissed/not_sure
 * cards move between sections immediately, without waiting for a server round
 * trip.
 *
 * ## RSC boundary
 *
 * This component is `"use client"` because it renders `CandidateCard`, which
 * uses `useActionState`. It does NOT import Server Actions directly — it
 * receives action factories from the caller (OnboardingFlow in `app/`), which
 * can import from `app/`. This keeps the dependency edge: app/ → features/,
 * never the reverse.
 *
 * ## Action factory pattern
 *
 * The caller supplies `confirmActionFactory(candidateId)` etc. This component
 * calls each factory to bind the candidateId before passing the bound action
 * to `CandidateCard`. Mirrors the `grantActionFactory` pattern in
 * `DiscoveryConsentSection`.
 */

import { useState, useCallback } from "react";
import { CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { CandidateCard, type BoundAdjudicationAction } from "./candidate-card";
import type {
  CandidateReviewItem,
  AggregatorEvidenceItem,
  AdjudicationOutcome,
} from "./candidate-view";

export type AdjudicationActionFactory = (candidateId: string) => BoundAdjudicationAction;

export interface CandidateReviewSectionProps {
  candidates: readonly CandidateReviewItem[];
  aggregatorEvidence: readonly AggregatorEvidenceItem[];
  confirmActionFactory: AdjudicationActionFactory;
  rejectActionFactory: AdjudicationActionFactory;
  dismissActionFactory: AdjudicationActionFactory;
  notSureActionFactory: AdjudicationActionFactory;
  /**
   * Called when the user submits any confirm form, before the SA round-trip.
   *
   * Wired by `OnboardingFlow` to set a `hasConfirmedAttempt` flag that guards
   * the auto-advance `useEffect`. Without this guard, the step advances to
   * `ready` before the confirmed CandidateCard can render its success branch,
   * because the RSC refresh that excludes the confirmed candidate from
   * `listForReview` arrives in the same React render batch as the SA result
   * (ATL-211 confirm fix).
   */
  onFirstConfirmedAttempt?: () => void;
}

const COPY = {
  title: "Review your findings",
  lede: "We found accounts associated with your identity. Review each one and confirm whether it belongs to you.",
  noCandidates: "No accounts to review right now.",
  notSureHeading: "Not sure about these",
  deferredHeading: "Deferred",
  aggregatorTitle: "Additional context",
  aggregatorLede:
    "The following signals were found but cannot be individually confirmed or rejected from here.",
} as const;

type EffectiveStatus = "pending" | "dismissed" | "not_sure" | "confirmed" | "rejected";

export function CandidateReviewSection({
  candidates,
  aggregatorEvidence,
  confirmActionFactory,
  rejectActionFactory,
  dismissActionFactory,
  notSureActionFactory,
  onFirstConfirmedAttempt,
}: CandidateReviewSectionProps) {
  const [outcomeMap, setOutcomeMap] = useState<Map<string, AdjudicationOutcome>>(() => new Map());

  /**
   * Ephemeral ghost map — keeps confirmed candidates mounted through the RSC
   * refresh that removes them from `listForReview` (ATL-211 confirm fix).
   *
   * Added when the user submits a confirm form (before the SA round-trip).
   * Deduplicated against `candidates` so a failed SA — where the RSC refresh
   * still includes the candidate — produces no duplicate card.
   * Never persisted; a fresh page render starts with an empty map, so the
   * confirmed candidate is correctly absent (authoritative DB state wins).
   */
  const [confirmedGhosts, setConfirmedGhosts] = useState<Map<string, CandidateReviewItem>>(
    () => new Map(),
  );

  const handleOutcomeChange = useCallback((candidateId: string, outcome: AdjudicationOutcome) => {
    setOutcomeMap((prev) => {
      const next = new Map(prev);
      next.set(candidateId, outcome);
      return next;
    });
  }, []);

  /**
   * Called synchronously from CandidateCard's confirm form `onSubmit`, before
   * the SA starts. Stores the candidate in `confirmedGhosts` so the card
   * remains in the JSX tree when the RSC refresh arrives with `candidates = []`.
   * Because the key is preserved, React keeps the same CandidateCard instance
   * and its `useActionState` state — the confirmed branch renders normally once
   * the SA result is committed.
   */
  const handleConfirmAttempt = useCallback(
    (candidateId: string) => {
      const candidate = candidates.find((c) => c.id === candidateId);
      if (!candidate) return;
      setConfirmedGhosts((prev) => {
        if (prev.has(candidateId)) return prev; // idempotent
        const next = new Map(prev);
        next.set(candidateId, candidate);
        return next;
      });
      onFirstConfirmedAttempt?.();
    },
    [candidates, onFirstConfirmedAttempt],
  );

  function effectiveStatus(c: CandidateReviewItem): EffectiveStatus {
    const override = outcomeMap.get(c.id);
    if (override !== undefined && override !== "idle") {
      return override;
    }
    return c.status;
  }

  // Groups based on effective status.
  // PRIMARY: pending + confirmed (any status that is not dismissed, not_sure, or rejected)
  const primaryCandidates = candidates.filter((c) => {
    const s = effectiveStatus(c);
    return s !== "dismissed" && s !== "not_sure" && s !== "rejected";
  });
  const notSureCandidates = candidates.filter((c) => effectiveStatus(c) === "not_sure");
  const deferredCandidates = candidates.filter((c) => effectiveStatus(c) === "dismissed");

  // Ghost candidates: confirmed but absent from the server-supplied list.
  // Deduplication ensures no duplicate card when a failed SA leaves the
  // candidate in `candidates` on the next RSC refresh.
  const ghostPrimary = [...confirmedGhosts.values()].filter(
    (ghost) => !candidates.some((c) => c.id === ghost.id),
  );

  // Merge into one array so React sees all primary cards in the SAME reconciliation
  // slot. If ghosts were rendered in a separate .map() call they would occupy a
  // different "child slot" in the parent fragment, and React would unmount/remount
  // the card when it transitions from candidate → ghost, losing useActionState
  // state and preventing the confirmed branch from rendering (ATL-211 confirm fix).
  const mergedPrimary = [...primaryCandidates, ...ghostPrimary];

  const totalVisible = mergedPrimary.length + notSureCandidates.length + deferredCandidates.length;

  return (
    <>
      <CardHeader>
        <h1 className="text-h3 font-semibold">{COPY.title}</h1>
        <CardDescription>{COPY.lede}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {totalVisible === 0 && aggregatorEvidence.length === 0 ? (
          <p className="text-body-sm text-text-secondary">{COPY.noCandidates}</p>
        ) : (
          <>
            {/* PRIMARY: pending + confirmed inline + ghost cards (ATL-211).
                All rendered in one .map() so React assigns them a stable
                position in the reconciliation tree. When a confirmed candidate
                transitions from primaryCandidates → ghostPrimary, its key stays
                in the same array slot and React preserves the CandidateCard
                instance together with its useActionState state. */}
            {mergedPrimary.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                confirmAction={confirmActionFactory(candidate.id)}
                rejectAction={rejectActionFactory(candidate.id)}
                dismissAction={dismissActionFactory(candidate.id)}
                notSureAction={notSureActionFactory(candidate.id)}
                onOutcomeChange={handleOutcomeChange}
                onConfirmAttempt={handleConfirmAttempt}
              />
            ))}

            {/* NOT SURE section */}
            {notSureCandidates.length > 0 && (
              <section aria-labelledby="not-sure-heading" className="mt-4 space-y-2">
                <h2 id="not-sure-heading" className="text-body-sm font-medium text-text-secondary">
                  {COPY.notSureHeading}
                </h2>
                {notSureCandidates.map((candidate) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    confirmAction={confirmActionFactory(candidate.id)}
                    rejectAction={rejectActionFactory(candidate.id)}
                    dismissAction={dismissActionFactory(candidate.id)}
                    notSureAction={notSureActionFactory(candidate.id)}
                    onOutcomeChange={handleOutcomeChange}
                  />
                ))}
              </section>
            )}

            {/* DEFERRED section */}
            {deferredCandidates.length > 0 && (
              <section aria-labelledby="deferred-heading" className="mt-4 space-y-2">
                <h2 id="deferred-heading" className="text-body-sm font-medium text-text-secondary">
                  {COPY.deferredHeading}
                </h2>
                {deferredCandidates.map((candidate) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    confirmAction={confirmActionFactory(candidate.id)}
                    rejectAction={rejectActionFactory(candidate.id)}
                    dismissAction={dismissActionFactory(candidate.id)}
                    notSureAction={notSureActionFactory(candidate.id)}
                    onOutcomeChange={handleOutcomeChange}
                  />
                ))}
              </section>
            )}

            {/* Aggregator evidence rows — no adjudication actions */}
            {aggregatorEvidence.length > 0 && (
              <section aria-labelledby="aggregator-evidence-heading" className="mt-4 space-y-2">
                <h2
                  id="aggregator-evidence-heading"
                  className="text-body-sm font-medium text-text-primary"
                >
                  {COPY.aggregatorTitle}
                </h2>
                <p className="text-body-sm text-text-secondary">{COPY.aggregatorLede}</p>
                <div className="space-y-2">
                  {aggregatorEvidence.map((evidence) => (
                    <div
                      key={evidence.id}
                      data-slot="aggregator-evidence-row"
                      className="rounded-card border border-border-default bg-surface-raised p-3"
                    >
                      <p className="text-body-sm font-medium text-text-primary">
                        {evidence.sourceIdentifier}
                      </p>
                      <p className="mt-0.5 text-body-sm text-text-secondary">
                        {evidence.evidenceSummary}
                      </p>
                      <span className="text-body-xs mt-1 inline-block rounded-full bg-surface px-2 py-0.5 text-text-secondary">
                        {evidence.evidenceType}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </CardContent>
    </>
  );
}
