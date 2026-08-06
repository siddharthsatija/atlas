import type { CreateAssetFieldErrors, PreservedAssetValues } from "@/lib/assets/asset-form";

/**
 * Form state for the create-asset flow (ATL-032).
 *
 * Deliberately **not** in `actions.ts`. A `"use server"` module may only export
 * async functions — every export becomes a callable server reference, so a plain
 * object is rejected at module evaluation. `use-server-exports.integration.test.ts`
 * guards the rule; the sign-in and onboarding flows use the same split.
 */
export interface CreateAssetState {
  /**
   * Field-keyed validation messages, rendered beside their inputs.
   *
   * Empty before the first submission and after a success.
   */
  errors: CreateAssetFieldErrors;
  /**
   * `null` unless something failed that the user cannot fix by editing a field
   * — a storage outage, most likely. Distinct from `errors` because the two need
   * different words and different placement.
   */
  failure: "unavailable" | null;
  /**
   * What the user typed, so a recoverable error does not empty the form
   * (ATL-032: "Form preserves input on recoverable errors").
   *
   * The account identifier is **never** here: it is Restricted, and echoing it
   * back would put it in the response payload and the React tree on every failed
   * attempt.
   */
  values: PreservedAssetValues;
  /**
   * Increments per submission so an unchanged result is still announced.
   * Without it, submitting the same invalid form twice produces an identical
   * state object and a screen reader stays silent on the second attempt — the
   * same reasoning ATL-014's sign-in state records.
   */
  attempt: number;
}

export const INITIAL_CREATE_ASSET_STATE: CreateAssetState = {
  errors: {},
  failure: null,
  values: {},
  attempt: 0,
};
