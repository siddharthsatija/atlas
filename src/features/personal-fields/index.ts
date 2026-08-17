/**
 * Settings → Personal data (ATL-106).
 *
 * The section is the only component a route needs; the rest are its parts and are
 * exported for tests rather than for other features to compose. `index.ts` is the
 * feature's public surface, and the ESLint `no-restricted-imports` rule stops
 * another feature reaching past it into these files.
 */
export { PersonalFieldsSection, type PersonalFieldsSectionProps } from "./personal-fields-section";
export { PersonalFieldsConsent } from "./personal-fields-consent";
export { PersonalFieldForm, type PersonalFieldFormProps } from "./personal-field-form";
export { PersonalFieldDelete } from "./personal-field-delete";
export { PersonalFieldValue } from "./personal-field-value";
export {
  PERSONAL_FIELDS_COPY,
  PERSONAL_FIELD_KIND_LABELS,
  PERSONAL_FIELD_KIND_OPTIONS,
  type PersonalFieldsCopy,
} from "./personal-fields-copy";

/**
 * The view model, exported because the route has to build one.
 *
 * `no-restricted-imports` forbids reaching past this barrel into a feature's
 * files — and it caught the page doing exactly that. The type belongs in the
 * feature (it describes what the section renders, not what the service stores),
 * so the fix is to publish it here rather than to move it or widen the rule.
 */
export type {
  PersonalFieldView,
  PersonalFieldViewFailure,
  PersonalFieldFormViewState,
  PersonalFieldActionViewState,
  PersonalFieldFormAction,
  PersonalFieldButtonAction,
  PersonalFieldConsentAction,
} from "./personal-fields-view";
