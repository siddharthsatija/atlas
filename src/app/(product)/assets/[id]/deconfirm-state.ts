/**
 * Shared action-state types and initial state for the deconfirm Server Action (ATL-211).
 *
 * Kept in a neutral module (no "use server") so that Client Components and
 * unit tests can import the initial-state constant without violating Next.js's
 * rule that "use server" files may only export async functions.
 *
 * Pattern mirrors candidate-view.ts, which holds INITIAL_ADJUDICATION_ACTION_STATE
 * for the same reason.
 */

export interface DeconfirmActionState {
  readonly failure: "not_found" | "not_confirmed" | "unavailable" | null;
  readonly attempt: number;
}

export const INITIAL_DECONFIRM_ACTION_STATE: DeconfirmActionState = {
  failure: null,
  attempt: 0,
};
