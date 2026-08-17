import type { PersonalFieldKey } from "@/lib/personal-fields";

/**
 * State for the Personal data flows (ATL-106).
 *
 * Not in `actions.ts`: a `"use server"` module may export only async functions,
 * and `use-server-exports.integration.test.ts` enforces that. The same split
 * `insights/form-state.ts` and `assets/[id]/edit/form-state.ts` already use.
 *
 * ## The failure vocabulary is the service's, narrowed
 *
 * `PersonalFieldService` answers with an `ApiErrorCode`. Four of those can reach
 * these flows and each needs different words:
 *
 *   - `consent_required` — `personal_fields_storage` is absent or withdrawn.
 *     Recoverable by a user action, which is why ATL-105 gave it its own code
 *     rather than folding it into `FORBIDDEN`.
 *   - `invalid` — an empty label or value. The form marks both required, so this
 *     is only reachable by a tampered or stale submission; silence would still be
 *     worse than a sentence.
 *   - `not_found` — no such field, or not this person's. Indistinguishable by
 *     design, the non-oracle rule the service applies everywhere.
 *   - `unavailable` — the write failed. Nothing changed.
 */
export type PersonalFieldFailure = "consent_required" | "invalid" | "not_found" | "unavailable";

export interface PersonalFieldFormState {
  failure: PersonalFieldFailure | null;
  /**
   * The label and kind the person typed, preserved across failures.
   *
   * Frontend §19: "preserve form input during recoverable errors". **The value is
   * deliberately absent** — re-populating a secret into a re-rendered form would
   * put it back into the RSC payload and the DOM after Atlas had already declined
   * to store it. Losing one field's worth of typing is the cheaper mistake.
   */
  label: string | null;
  fieldKey: PersonalFieldKey | null;
  /** True once a field has actually been written, so the panel can confirm it. */
  saved?: boolean;
  /**
   * Increments on every submission, so a repeated identical failure is announced
   * again — a live region is read when its content *changes*.
   */
  attempt: number;
}

export const INITIAL_PERSONAL_FIELD_STATE: PersonalFieldFormState = {
  failure: null,
  label: null,
  fieldKey: null,
  attempt: 0,
};

/**
 * State for the one-button flows: delete, and granting consent.
 *
 * Separate from the form state rather than a flag on it, for the reason
 * `RestoreFindingState` is separate from `DismissFindingState`: these run in
 * different renders of the section, and sharing would let a failed delete
 * display a label left over from a save that succeeded.
 */
export interface PersonalFieldActionState {
  failure: PersonalFieldFailure | null;
  attempt: number;
}

export const INITIAL_PERSONAL_FIELD_ACTION_STATE: PersonalFieldActionState = {
  failure: null,
  attempt: 0,
};
