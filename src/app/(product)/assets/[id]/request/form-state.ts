import type { PersonalFieldKey } from "@/lib/personal-fields";

/**
 * State for Step 1 of the request flow (ATL-058).
 *
 * Not in `actions.ts`: a `"use server"` module may export only async functions,
 * and `use-server-exports.integration.test.ts` enforces that. The same split
 * `settings/form-state.ts` and `assets/[id]/edit/form-state.ts` already use.
 *
 * ## The failure vocabulary
 *
 * Four conditions can surface, and each needs different words:
 *
 *   - `missing_recipient` — nothing was entered. Asks for something.
 *   - `invalid_recipient` — what was entered will not work. Says so. Collapsing
 *     the two would tell someone who typed a typo that they typed nothing.
 *   - `not_found` — no such service, or not this person's. Indistinguishable by
 *     design, the non-oracle rule ATL-030 established.
 *   - `unavailable` — the write failed. Nothing was prepared.
 *
 * **No value is preserved across a failure.** The recipient is re-rendered from
 * the *stored* draft, not from the refused submission, for the reason
 * `settings/form-state.ts` records: re-populating a value Atlas declined to store
 * puts it back into the RSC payload and the DOM. The person retypes one address;
 * that is the cheaper mistake.
 */
export type RequestReviewFailure =
  "missing_recipient" | "invalid_recipient" | "not_found" | "unavailable";

export interface RequestReviewFormState {
  failure: RequestReviewFailure | null;
  /**
   * Increments on every submission, so a repeated identical failure is announced
   * again — a live region is read when its content changes.
   */
  attempt: number;
}

export const INITIAL_REQUEST_REVIEW_STATE: RequestReviewFormState = {
  failure: null,
  attempt: 0,
};

/**
 * State for the just-in-time field capture, mirroring the settings flow's.
 *
 * Structurally identical to `PersonalFieldFormState` because it drives the same
 * component — `PersonalFieldForm` is reused unchanged, so saving a field here
 * records consent exactly as saving one in Settings does (ADR-002, FR-13).
 */
export interface FieldCaptureFormState {
  failure: "consent_required" | "field_in_use" | "invalid" | "not_found" | "unavailable" | null;
  label: string | null;
  fieldKey: PersonalFieldKey | null;
  saved?: boolean;
  attempt: number;
}

export const INITIAL_FIELD_CAPTURE_STATE: FieldCaptureFormState = {
  failure: null,
  label: null,
  fieldKey: null,
  attempt: 0,
};
