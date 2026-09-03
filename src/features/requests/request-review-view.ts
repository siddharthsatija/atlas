import type { PersonalFieldKey } from "@/lib/personal-fields";
import type { EvidenceItem, SelectableField } from "@/lib/requests/request-draft";

/**
 * The view model and action shapes for Step 1 (ATL-058).
 *
 * Declared here rather than imported from the route or the service, mirroring
 * `personal-fields-view.ts`: **a feature does not reach into `app/` or
 * `server/`.** The route's form state is structurally identical to what is
 * declared here, which is what lets the page pass its actions straight in.
 *
 * `SelectableField` and `EvidenceItem` come from `lib/`, which features may
 * import — they are the shapes the pure decisions in `request-draft.ts` operate
 * on, and redeclaring them here would create two definitions of one idea.
 */

export type { SelectableField, EvidenceItem };

/** What the step needs to render, resolved server-side. */
export interface RequestReviewData {
  assetId: string;
  serviceName: string;
  /** The §11.1 scale: `low | medium | high`. */
  assetConfidence: string;
  evidence: EvidenceItem[];
  /** Already reduced to one per key by `selectableFields` (D1). */
  offeredFields: SelectableField[];
  /** Keys whose alternatives are hidden, so the copy can say so. */
  hiddenAlternativeKeys: PersonalFieldKey[];
  /** From `isStoragePermitted` — decides whether just-in-time capture is offered. */
  vaultWritable: boolean;
  /**
   * Selections restored from a stored draft, when returning to this step.
   *
   * Empty on a first visit. Once the draft exists the row is the source of
   * truth — there is no other persistence in this flow, by design.
   */
  restoredFieldKeys: PersonalFieldKey[];
  restoredRecipient: string | null;
}

/** The four failures this step can surface. Mirrors the route's union. */
export type RequestReviewFailure =
  "missing_recipient" | "invalid_recipient" | "not_found" | "unavailable";

export interface RequestReviewFormState {
  failure: RequestReviewFailure | null;
  /**
   * Increments on every submission, so a repeated identical failure is announced
   * again — a live region is read when its content *changes*.
   */
  attempt: number;
}

export const INITIAL_REVIEW_STATE: RequestReviewFormState = { failure: null, attempt: 0 };

/**
 * Submits Step 1 and creates the draft.
 *
 * On success the action redirects, so it does not return a success state — the
 * only thing it can hand back is a reason it did not.
 */
export type CreateDraftAction = (
  previous: RequestReviewFormState,
  formData: FormData,
) => RequestReviewFormState | Promise<RequestReviewFormState>;

/** Mirrors the settings flow's action state, for just-in-time field capture. */
export interface FieldCaptureState {
  failure: "consent_required" | "field_in_use" | "invalid" | "not_found" | "unavailable" | null;
  label: string | null;
  fieldKey: PersonalFieldKey | null;
  saved?: boolean;
  attempt: number;
}

export const INITIAL_CAPTURE_STATE: FieldCaptureState = {
  failure: null,
  label: null,
  fieldKey: null,
  attempt: 0,
};

export type FieldCaptureAction = (
  previous: FieldCaptureState,
  formData: FormData,
) => FieldCaptureState | Promise<FieldCaptureState>;
