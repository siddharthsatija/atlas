"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { AssetService } from "@/server/assets/asset-service";
import {
  parseCreateAssetForm,
  preservedValues,
  readCreateAssetForm,
} from "@/lib/assets/asset-form";
import type { CreateAssetState } from "./form-state";

/**
 * Create-asset Server Action (ATL-032).
 *
 * A Server Action rather than a route handler: Next.js applies origin checking,
 * and there is no browser-initiated request shape here a form cannot express
 * (`src/app/api/README.md`).
 *
 * The user id comes from `requireVerifiedUser`, never from the form. Architecture
 * §10 is explicit that a client-supplied `user_id` is never authority, and
 * `AssetService.createAsset` takes the id as its own argument for the same
 * reason.
 *
 * ## Validation happens here, whatever the client did
 *
 * The same Zod schema runs in the browser for immediate feedback, but that is a
 * convenience and not a control — a form is not a trustworthy source. This parse
 * is the one that decides.
 */
export async function createAssetAction(
  previous: CreateAssetState,
  formData: FormData,
): Promise<CreateAssetState> {
  const user = await requireVerifiedUser();

  const fields = readCreateAssetForm(formData);
  const attempt = previous.attempt + 1;
  const preserved = preservedValues(fields);

  const parsed = parseCreateAssetForm(fields);
  if (!parsed.success || !parsed.values) {
    return { errors: parsed.errors, failure: null, values: preserved, attempt };
  }

  const result = await AssetService.create().createAsset(user.id, {
    serviceName: parsed.values.serviceName,
    category: parsed.values.category,
    ...(parsed.values.serviceDomain ? { serviceDomain: parsed.values.serviceDomain } : {}),
    ...(parsed.values.accountIdentifier
      ? { accountIdentifier: parsed.values.accountIdentifier }
      : {}),
    ...(parsed.values.notes ? { notes: parsed.values.notes } : {}),
  });

  if (!result.ok) {
    /**
     * The code is not shown to the user, and the identifier is never echoed.
     * `UNAVAILABLE` is the only failure `createAsset` can return here — there is
     * no id to be `NOT_FOUND` and ownership came from the session — so the copy
     * can be specific without branching on a code the user cannot act on.
     */
    return { errors: {}, failure: "unavailable", values: preserved, attempt };
  }

  /**
   * The list is cached per path, and a newly created asset must appear on it.
   * Revalidating before the redirect means the user does not arrive at a list
   * that is missing the thing they just made.
   */
  revalidatePath("/assets");

  // Outside any try: `redirect` signals by throwing, and catching it would turn
  // a successful creation into an error banner.
  redirect(`/assets/${result.data.id}`);
}
