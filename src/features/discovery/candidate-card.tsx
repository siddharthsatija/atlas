"use client";

/**
 * Candidate adjudication card (ATL-211).
 *
 * Renders one discovery candidate. The card variant changes based on the
 * effective status — the persisted status from the server, overridden by a
 * successful client-side adjudication action:
 *
 *   pending   → four adjudication action buttons (Confirm / Reject / Dismiss / Not sure)
 *   confirmed → inline success badge + link to the newly created asset
 *   rejected  → card unmounts immediately (null render)
 *   dismissed → informational badge, no action buttons
 *   not_sure  → informational badge, no action buttons
 *
 * ATL-208 prohibits mutations from `dismissed` or `not_sure` states, so those
 * variants intentionally have no action buttons.
 *
 * ## RSC boundary safety
 *
 * This component is `"use client"`. It does NOT import Server Actions — it
 * receives them as pre-bound props from `CandidateReviewSection`.
 *
 * ## Why four separate forms rather than one form with a hidden action field
 *
 * Each `useActionState` hook manages its own optimistic state and pending
 * indicator. Sharing one `useActionState` across four buttons would leave
 * three of them without a way to know which action is currently pending.
 */

import { useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import type {
  CandidateReviewItem,
  AdjudicationActionState,
  AdjudicationOutcome,
} from "./candidate-view";
import { INITIAL_ADJUDICATION_ACTION_STATE } from "./candidate-view";

/** A Server Action already bound to a candidateId, ready for useActionState. */
export type BoundAdjudicationAction = (
  prev: AdjudicationActionState,
  formData: FormData,
) => Promise<AdjudicationActionState>;

export interface CandidateCardProps {
  candidate: CandidateReviewItem;
  confirmAction: BoundAdjudicationAction;
  rejectAction: BoundAdjudicationAction;
  dismissAction: BoundAdjudicationAction;
  notSureAction: BoundAdjudicationAction;
  /**
   * Called once when a client-side adjudication action succeeds, so the parent
   * (`CandidateReviewSection`) can immediately update its section grouping.
   */
  onOutcomeChange?: (
    candidateId: string,
    outcome: AdjudicationOutcome,
    assetId: string | null,
  ) => void;
  /**
   * Called synchronously when the user submits the confirm form, before the
   * Server Action round-trip starts.
   *
   * Used by `CandidateReviewSection` to add this candidate to its
   * `confirmedGhosts` map so the card stays mounted through the automatic RSC
   * refresh that excludes confirmed candidates from `listForReview`. Without
   * this signal, the RSC refresh removes the card from the `candidates` prop in
   * the same React render pass as the SA result, so the card's `useActionState`
   * result is never committed and the "Confirmed" branch never renders (ATL-211).
   *
   * Must NOT be called for any other action (reject / dismiss / not_sure) —
   * only confirm causes the RSC refresh to exclude the candidate.
   */
  onConfirmAttempt?: (candidateId: string) => void;
}

const COPY = {
  confirm: "Confirm",
  reject: "Reject",
  dismiss: "Dismiss",
  notSure: "Not sure",
  confirmedLabel: "Confirmed",
  viewAsset: "View asset",
  dismissedLabel: "Deferred",
  notSureLabel: "Not sure",
  errorNotFound: "This item is no longer available.",
  errorNotPending: "This item has already been actioned.",
  errorUnavailable: "Something went wrong. Please try again.",
} as const;

function errorMessage(failure: AdjudicationActionState["failure"]): string | null {
  if (failure === "not_found") return COPY.errorNotFound;
  if (failure === "not_pending") return COPY.errorNotPending;
  if (failure === "unavailable") return COPY.errorUnavailable;
  return null;
}

const cardBase = "rounded-card border border-border-default bg-surface p-4";

export function CandidateCard({
  candidate,
  confirmAction,
  rejectAction,
  dismissAction,
  notSureAction,
  onOutcomeChange,
  onConfirmAttempt,
}: CandidateCardProps) {
  const [confirmState, submitConfirm, confirmPending] = useActionState(
    confirmAction,
    INITIAL_ADJUDICATION_ACTION_STATE,
  );
  const [rejectState, submitReject, rejectPending] = useActionState(
    rejectAction,
    INITIAL_ADJUDICATION_ACTION_STATE,
  );
  const [dismissState, submitDismiss, dismissPending] = useActionState(
    dismissAction,
    INITIAL_ADJUDICATION_ACTION_STATE,
  );
  const [notSureState, submitNotSure, notSurePending] = useActionState(
    notSureAction,
    INITIAL_ADJUDICATION_ACTION_STATE,
  );

  // Client outcome: whichever action state first reports a non-idle outcome wins.
  const clientOutcome: AdjudicationOutcome =
    confirmState.outcome !== "idle"
      ? confirmState.outcome
      : rejectState.outcome !== "idle"
        ? rejectState.outcome
        : dismissState.outcome !== "idle"
          ? dismissState.outcome
          : notSureState.outcome !== "idle"
            ? notSureState.outcome
            : "idle";

  const clientAssetId = confirmState.assetId;

  // Effective status: client outcome overrides the persisted candidate.status.
  const effectiveStatus: "pending" | "confirmed" | "rejected" | "dismissed" | "not_sure" =
    clientOutcome !== "idle" ? clientOutcome : candidate.status;

  // Notify parent once per outcome change so section grouping updates immediately.
  const prevOutcomeRef = useRef<AdjudicationOutcome>("idle");
  useEffect(() => {
    if (clientOutcome !== "idle" && clientOutcome !== prevOutcomeRef.current) {
      prevOutcomeRef.current = clientOutcome;
      onOutcomeChange?.(candidate.id, clientOutcome, clientAssetId);
    }
  }, [clientOutcome, clientAssetId, candidate.id, onOutcomeChange]);

  // ── Rejected: unmount immediately ─────────────────────────────────────────
  if (effectiveStatus === "rejected") return null;

  // Shared header used by all visible variants.
  const header = (
    <div>
      <p className="text-body-sm font-medium text-text-primary">{candidate.sourceIdentifier}</p>
      <p className="mt-0.5 text-body-sm text-text-secondary">{candidate.evidenceSummary}</p>
      <span className="text-body-xs mt-1 inline-block rounded-full bg-surface-raised px-2 py-0.5 text-text-secondary">
        {candidate.evidenceType}
      </span>
    </div>
  );

  // ── Confirmed: inline success + asset link ─────────────────────────────────
  if (effectiveStatus === "confirmed") {
    return (
      <div data-slot="candidate-card" data-candidate-id={candidate.id} className={cardBase}>
        <div className="flex flex-col gap-3">
          {header}
          <div className="flex items-center gap-2">
            <span className="bg-surface-success text-body-xs inline-block rounded-full px-2 py-0.5 font-medium text-success">
              {COPY.confirmedLabel}
            </span>
            {clientAssetId && (
              <a href={`/assets/${clientAssetId}`} className="text-link text-body-sm underline">
                {COPY.viewAsset}
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Dismissed: deferred informational card, no action buttons ─────────────
  if (effectiveStatus === "dismissed") {
    return (
      <div
        data-slot="candidate-card"
        data-candidate-id={candidate.id}
        className={`${cardBase} opacity-60`}
      >
        <div className="flex flex-col gap-3">
          {header}
          <span className="text-body-xs inline-block rounded-full bg-surface-raised px-2 py-0.5 text-text-secondary">
            {COPY.dismissedLabel}
          </span>
        </div>
      </div>
    );
  }

  // ── Not sure: informational card with indicator, no action buttons ─────────
  if (effectiveStatus === "not_sure") {
    return (
      <div data-slot="candidate-card" data-candidate-id={candidate.id} className={cardBase}>
        <div className="flex flex-col gap-3">
          {header}
          <span className="bg-surface-warning text-body-xs inline-block rounded-full px-2 py-0.5 text-text-secondary">
            {COPY.notSureLabel}
          </span>
        </div>
      </div>
    );
  }

  // ── Pending: full adjudication card with all four action buttons ───────────
  const anyPending = confirmPending || rejectPending || dismissPending || notSurePending;
  const activeFailure =
    confirmState.failure ?? rejectState.failure ?? dismissState.failure ?? notSureState.failure;
  const error = errorMessage(activeFailure);

  return (
    <div data-slot="candidate-card" data-candidate-id={candidate.id} className={cardBase}>
      <div className="flex flex-col gap-3">
        {/* Header */}
        {header}

        {/* Error message */}
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          <form action={submitConfirm} onSubmit={() => onConfirmAttempt?.(candidate.id)}>
            <Button type="submit" size="sm" loading={confirmPending} disabled={anyPending}>
              {COPY.confirm}
            </Button>
          </form>

          <form action={submitReject}>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={rejectPending}
              disabled={anyPending}
            >
              {COPY.reject}
            </Button>
          </form>

          <form action={submitDismiss}>
            <Button
              type="submit"
              variant="tertiary"
              size="sm"
              loading={dismissPending}
              disabled={anyPending}
            >
              {COPY.dismiss}
            </Button>
          </form>

          <form action={submitNotSure}>
            <Button
              type="submit"
              variant="tertiary"
              size="sm"
              loading={notSurePending}
              disabled={anyPending}
            >
              {COPY.notSure}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
