/**
 * Form state for the onboarding flow (ATL-016).
 *
 * Kept out of `actions.ts` for the same reason as the sign-in state: a
 * `"use server"` module may only export async functions, and a plain object
 * export throws at module evaluation. See `form-state.ts` in `(auth)/sign-in`
 * and the shared guard in `use-server-exports.test.ts`.
 */
export interface CompleteOnboardingState {
  /** `null` before the first submission; `"unavailable"` after a failure. */
  error: "unavailable" | null;
}

export const INITIAL_COMPLETE_STATE: CompleteOnboardingState = { error: null };
