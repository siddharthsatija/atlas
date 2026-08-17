import type { ResolutionAction } from "@/lib/findings/resolution-actions";
import type { DismissalReason } from "@/lib/findings/dismissal-reasons";

/**
 * State for the inline resolution flow (ATL-042).
 *
 * Not in `actions.ts`: a `"use server"` module may export only async functions,
 * and `use-server-exports.integration.test.ts` enforces that.
 *
 * The four failures are distinct situations that need distinct words:
 *
 *   - `action_required` — no action was selected, or one Atlas does not know.
 *     Only reachable by a tampered or stale form, since the control disables
 *     Confirm until something is chosen, but silence would be worse.
 *   - `already_closed` — the finding is resolved or dismissed already. §11.1's
 *     lifecycle is one-way, and a second close would rewrite `resolved_at`.
 *   - `not_found` — no such finding, or not this user's. Indistinguishable by
 *     design, the non-oracle rule the service applies everywhere.
 *   - `unavailable` — the write failed. Nothing changed.
 */
export type ResolveFailure = "action_required" | "already_closed" | "not_found" | "unavailable";

export interface ResolveFindingState {
  failure: ResolveFailure | null;
  /**
   * The action the user chose, preserved across failures.
   *
   * Frontend §19: "preserve form input during recoverable errors". Losing the
   * selection on a store outage would make the user re-decide something they
   * had already decided.
   */
  action: ResolutionAction | null;
  /** True once the finding has actually been resolved, so the panel can say so. */
  resolved?: boolean;
  /**
   * Increments on every submission, so a repeated identical failure is
   * announced again — a live region is read when its content *changes*.
   */
  attempt: number;
}

export const INITIAL_RESOLVE_STATE: ResolveFindingState = {
  failure: null,
  action: null,
  attempt: 0,
};

/**
 * State for dismissal and its undo (ATL-043).
 *
 * Three of the four failures are the same situations `ResolveFailure` names, and
 * they are re-declared rather than shared because the fourth differs: dismissal
 * has no `action_required`, since frontend §5.4 makes the reason **optional**.
 * A union that carried a failure the flow cannot produce would be a type that
 * lies about its own values.
 *
 *   - `already_closed` — for a dismissal, the finding has already ended. For an
 *     undo, it is not dismissed at all: a *resolved* finding is not undone here,
 *     because resolution asserts the problem was dealt with and ADR-004 has
 *     already credited it.
 *   - `not_found` — no such finding, or not this user's. Indistinguishable by
 *     design.
 *   - `unavailable` — the write failed. Nothing changed.
 */
export type DismissFailure = "already_closed" | "not_found" | "unavailable";

export interface DismissFindingState {
  failure: DismissFailure | null;
  /**
   * The reason the user chose, preserved across failures — and legitimately
   * null, because dismissing without giving one is a complete dismissal.
   */
  reason: DismissalReason | null;
  /** True once the finding has actually been dismissed. */
  dismissed?: boolean;
  attempt: number;
}

export const INITIAL_DISMISS_STATE: DismissFindingState = {
  failure: null,
  reason: null,
  attempt: 0,
};

/**
 * Undo's own state (ATL-043).
 *
 * Separate from `DismissFindingState` rather than a flag on it: the two run in
 * different renders of the panel — one when the finding is open, the other when
 * it is dismissed — and sharing a state would mean a failed undo could display
 * a stale reason from a dismissal that succeeded.
 */
export interface RestoreFindingState {
  failure: DismissFailure | null;
  restored?: boolean;
  attempt: number;
}

export const INITIAL_RESTORE_STATE: RestoreFindingState = { failure: null, attempt: 0 };
