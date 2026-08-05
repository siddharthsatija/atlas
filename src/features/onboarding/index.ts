/**
 * Public surface of the onboarding feature (ATL-016).
 *
 * The ESLint boundary rule restricts deep imports into a feature — its internals
 * are its own. Everything the route needs is re-exported here, so the module
 * layout inside this folder can change without touching a caller.
 */

export { OnboardingProgress } from "./onboarding-progress";
export {
  AI_CONSENT_COPY,
  ONBOARDING_INTRO,
  ONBOARDING_LIMITATIONS,
  ONBOARDING_STEP_COPY,
} from "./onboarding-copy";
