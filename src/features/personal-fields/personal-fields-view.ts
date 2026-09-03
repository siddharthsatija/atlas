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
 *
 * ATL-209 adds `includeInDiscovery` so the discovery toggle reflects the
 * persisted state without a separate query.
 */
export interface PersonalFieldView {
  id: string;
  fieldKey: PersonalFieldKey;
  label: string;
  /** Produced server-side by `listMasked`, which cannot return plaintext at all. */
  maskedValue: string;
  /** Null until ATL-058 gives `markUsed` its first production caller. */
  lastUsedAt: string | null;
  /**
   * ATL-209: whether this field is included in discovery runs.
   *
   * Toggled via `setIncludeInDiscoveryAction` (settings) or
   * `setOnboardingFieldDiscoveryAction` (onboarding). The `DiscoveryToggle`
   * component reads this as its initial state and then manages optimistic
   * updates locally.
   */
  includeInDiscovery: boolean;
}

/**
 * The five failures these flows can surface.
 *
 * ATL-209 adds `field_in_use`: `removeField()` returns this when a discovery
 * run holds a live reference to the field. The correct response is to wait
 * until the run finishes — there is no deferred deletion.
 */
export type PersonalFieldViewFailure =
  "consent_required" | "invalid" | "not_found" | "unavailable" | "field_in_use";

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

/**
 * ATL-209: direct-call action for toggling `include_in_discovery`.
 *
 * Direct call rather than formData, because the caller supplies the new state
 * as a typed boolean — no serialisation and no hidden input. The `DiscoveryToggle`
 * component passes `fieldId` and `enabled` as positional arguments, which matches
 * both `setIncludeInDiscoveryAction` (settings) and
 * `setOnboardingFieldDiscoveryAction` (onboarding).
 */
export type PersonalFieldToggleAction = (
  fieldId: string,
  enabled: boolean,
) => Promise<{ ok: boolean }>;
