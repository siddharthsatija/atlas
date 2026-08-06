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
