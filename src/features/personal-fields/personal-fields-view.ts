import type { PersonalFieldKey } from "@/lib/personal-fields";

/**
 * The view model and action shapes for Settings → Personal data (ATL-106).
 *
 * Declared here rather than imported from the route or the service, mirroring
 * `AssetActionFormState` in `asset-action-form.tsx`: **a feature does not reach
 * into `app/` or `server/`.** The route's `PersonalFieldFormState` and the
 * service's `MaskedPersonalField` are structurally identical to these, which is
 * what lets the page pass its data and its actions straight in.
 *
 * The distinction the codebase already draws, and this follows: importing a
 * *Server Action* from `app/` is established (`account-identifier.tsx` does it,
 * because a component has to be handed the function it submits to), while
 * importing a *type* from `app/` or `server/` is not — a type is cheap to declare
 * and declaring it keeps the dependency pointing one way.
 */

/**
 * One stored detail as this section renders it.
 *
 * Carries `maskedValue` and **no plaintext**. The full value reaches the browser
 * only as the resolved return of the reveal action, which audits before it
 * answers — see `personal-field-value.tsx`.
 */
export interface PersonalFieldView {
  id: string;
  fieldKey: PersonalFieldKey;
  label: string;
  /** Produced server-side by `listMasked`, which cannot return plaintext at all. */
  maskedValue: string;
  /** Null until ATL-058 gives `markUsed` its first production caller. */
  lastUsedAt: string | null;
}

/** The four failures these flows can surface. Mirrors the route's union. */
export type PersonalFieldViewFailure = "consent_required" | "invalid" | "not_found" | "unavailable";

/** Mirrors the route's `PersonalFieldFormState`. */
export interface PersonalFieldFormViewState {
  failure: PersonalFieldViewFailure | null;
  label: string | null;
  fieldKey: PersonalFieldKey | null;
  saved?: boolean;
  attempt: number;
}

export const INITIAL_FORM_VIEW_STATE: PersonalFieldFormViewState = {
  failure: null,
  label: null,
  fieldKey: null,
  attempt: 0,
};

/** Mirrors the route's `PersonalFieldActionState`. */
export interface PersonalFieldActionViewState {
  failure: PersonalFieldViewFailure | null;
  attempt: number;
}

export const INITIAL_ACTION_VIEW_STATE: PersonalFieldActionViewState = {
  failure: null,
  attempt: 0,
};

export type PersonalFieldFormAction = (
  previous: PersonalFieldFormViewState,
  formData: FormData,
) => PersonalFieldFormViewState | Promise<PersonalFieldFormViewState>;

export type PersonalFieldButtonAction = (
  previous: PersonalFieldActionViewState,
  formData: FormData,
) => PersonalFieldActionViewState | Promise<PersonalFieldActionViewState>;

export type PersonalFieldConsentAction = (
  previous: PersonalFieldActionViewState,
) => PersonalFieldActionViewState | Promise<PersonalFieldActionViewState>;
