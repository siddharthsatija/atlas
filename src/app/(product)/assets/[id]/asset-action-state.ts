import { revalidatePath } from "next/cache";
import type { AssetActionState } from "./edit/form-state";
import type { AssetResult } from "@/server/assets/asset-service";

/**
 * Shared plumbing for the asset surfaces' button-only Server Actions.
 *
 * ## Why this module exists
 *
 * These three helpers were defined inside `edit/actions.ts`, where they could
 * not be reused: a `"use server"` module may export only async functions, so a
 * helper exported from one throws at module evaluation — invisible to tsc,
 * ESLint and Vitest, and visible only as a broken request.
 *
 * ATL-036 added archive and restore on the *detail* page, which need the same
 * failure vocabulary and the same attempt semantics. Copying the mapping would
 * have created a second definition of what `not_found` means, free to drift from
 * the first. Extracting it keeps one.
 *
 * This module is deliberately **not** `"use server"`. It exports plain
 * functions, called by action modules that are.
 */

/**
 * Reads one field as text.
 *
 * `FormData.get` returns `string | File`, and a `File` stringifies to
 * `[object File]` — which would sail through as a plausible-looking id. Anything
 * that is not a string is treated as absent.
 */
export function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Invalidates every route that reads an asset: the detail page, the edit page,
 * and the list.
 *
 * **The edit path is the load-bearing half**, and it was once missing. A
 * Playwright trace of "Mark as reviewed" showed the action posting to
 * `/assets/{id}/edit`, returning `200` with `x-action-revalidated: 1`, and the
 * router then refetching `/assets/{id}` — the only path that had been
 * invalidated — while the page the user was looking at kept its cached tree.
 * The write had succeeded; the screen went on saying "Never reviewed."
 *
 * ## Why `/assets` joined them (ATL-036 M5)
 *
 * Archive and restore change *membership of the default list*, not just the
 * asset's own fields. Since ATL-036 M2 the list hides archived rows unless a
 * status was asked for, so an archive that did not invalidate `/assets` would
 * leave the archived service sitting in the active list — the one place the
 * user goes to see what is active — until they happened to hard-reload.
 *
 * It is correct for the other callers too, and was arguably missing from them:
 * a status change and a review both alter what the card renders (`Inactive`,
 * `Reviewed 14 Mar 2026`), and both reached the list only by luck of navigation.
 *
 * All three paths, not a subset: each renders the same mutated data, and
 * dropping any one invalidation moves the bug rather than fixing it.
 */
export function revalidateAssetViews(assetId: string): void {
  revalidatePath(`/assets/${assetId}`);
  revalidatePath(`/assets/${assetId}/edit`);
  revalidatePath("/assets");
}

/**
 * Turns a service result into the next form state (ATL-112).
 *
 * The button-only actions used to `await` an `AssetResult` and drop it, then
 * revalidate regardless. A failed write was therefore indistinguishable from a
 * successful one: the page redrew with the old data and said nothing, so a user
 * who clicked during a database fault had no way to tell.
 *
 * `NOT_FOUND` and everything else are separated because the situations differ —
 * "that asset is not yours, or is gone" against "the write failed". The service
 * already makes missing and foreign indistinguishable, so this mapping does not
 * widen what a caller can learn.
 *
 * Revalidation happens only on success. Invalidating caches for a write that did
 * not occur is work with no purpose, and it is the step that made the failure
 * look like a completed round trip.
 */
export function toActionState(
  previous: AssetActionState,
  result: AssetResult<unknown>,
  assetId: string,
): AssetActionState {
  const attempt = previous.attempt + 1;

  if (!result.ok) {
    return { failure: result.code === "NOT_FOUND" ? "not_found" : "unavailable", attempt };
  }

  revalidateAssetViews(assetId);
  return { failure: null, attempt };
}

/** A submission Atlas will not act on, because the value is not one it knows. */
export function rejected(previous: AssetActionState): AssetActionState {
  return { failure: "rejected", attempt: previous.attempt + 1 };
}
