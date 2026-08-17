import type { CreateAssetFieldErrors, PreservedAssetValues } from "@/lib/assets/asset-form";

/**
 * Form state for the edit flow (ATL-033).
 *
 * Not in `actions.ts`: a `"use server"` module may only export async functions,
 * and `use-server-exports.integration.test.ts` enforces that.
 *
 * Mirrors the create state with one addition — `not_found`, because an edit can
 * target an asset that was deleted or never belonged to this user, which
 * creation cannot.
 */
export interface EditAssetState {
  errors: CreateAssetFieldErrors;
  failure: "unavailable" | "not_found" | null;
  values: PreservedAssetValues;
  attempt: number;
}

export const INITIAL_EDIT_ASSET_STATE: EditAssetState = {
  errors: {},
  failure: null,
  values: {},
  attempt: 0,
};

/**
 * Why a single-action form on the edit page did nothing (ATL-112).
 *
 *   - `not_found` — the asset was deleted, or never belonged to this user. The
 *     service makes those indistinguishable on purpose.
 *   - `unavailable` — the write failed. Nothing changed.
 *   - `rejected` — the submitted value is not one Atlas recognises. Only
 *     reachable by a tampered or stale form, but it is still an outcome, and an
 *     outcome that renders as silence is the defect this ticket exists to fix.
 */
export type AssetActionFailure = "not_found" | "unavailable" | "rejected";

/**
 * State for the edit page's button-only forms — status, review, and the child
 * lists (ATL-112).
 *
 * Deliberately thinner than `EditAssetState`: these forms have no typed input to
 * preserve and no per-field errors to report. What they were missing is the one
 * thing here — a way to say that the operation did not happen.
 */
export interface AssetActionState {
  failure: AssetActionFailure | null;
  /**
   * Increments on every submission.
   *
   * Keys the alert, so a second identical failure is announced again rather
   * than sitting silently in the DOM: assistive technology reads a live region
   * when its content changes, and "Something went wrong" replaced by the same
   * words is not a change.
   */
  attempt: number;
}

export const INITIAL_ASSET_ACTION_STATE: AssetActionState = { failure: null, attempt: 0 };
