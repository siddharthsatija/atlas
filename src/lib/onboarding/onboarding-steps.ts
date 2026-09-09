/**
 * The onboarding step model (ATL-016, frontend §17, PRD §9.1 and FR-02).
 *
 * Pure data and pure functions: the step order, which steps may be skipped, and
 * the choices each offers. The UI renders it and the server validates against
 * it, so a value that cannot be chosen also cannot be submitted.
 *
 * ## What this file does not do
 *
 * It holds no progress state. Saving and resuming `profiles.onboarding_state_json`
 * is **ATL-017**, and the step ids here are the vocabulary that ticket will
 * persist — which is why they are stable strings rather than array indices. An
 * index would silently mean something different the moment a step is inserted.
 */

/**
 * Phase 1 primary onboarding graph (frontend §17, PRD §9.1, Repair #2).
 *
 * `categories` and `starting_point` have been removed from the primary journey:
 * Phase 1 does not ask users to manually enumerate account categories or choose
 * between demo and their own accounts. Discovery is the primary path.
 *
 * `identity_profile` (ATL-209) is mandatory — it must NOT be added to
 * `SKIPPABLE_STEPS`. Pre-M13 users who already completed onboarding are also
 * routed to it as a one-step upgrade (they only see `identity_profile`, not the
 * preceding steps).
 */
export const ONBOARDING_STEPS = [
  "introduction",
  "privacy_goal",
  "identity_profile",
  "candidate_review",
  "ready",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const STEPS: ReadonlySet<string> = new Set(ONBOARDING_STEPS);

export function isOnboardingStep(value: string): value is OnboardingStep {
  return STEPS.has(value);
}

/**
 * Steps a user may pass without answering (§17 "back and skip where safe",
 * FR-02 "allow skipping optional steps").
 *
 * `introduction` is not skippable because there is nothing to skip — it asks
 * nothing and carries the limitations copy the product is obliged to show.
 * `identity_profile` is not skippable — it is mandatory (ATL-209).
 * `ready` is not skippable because it *is* the completion action.
 */
export const SKIPPABLE_STEPS: readonly OnboardingStep[] = ["privacy_goal", "candidate_review"];

export function isSkippable(step: OnboardingStep): boolean {
  return SKIPPABLE_STEPS.includes(step);
}

/** 1-based position, for the progress indicator. */
export function stepPosition(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step) + 1;
}

export function nextStep(step: OnboardingStep): OnboardingStep | null {
  return ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(step) + 1] ?? null;
}

export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  return index > 0 ? (ONBOARDING_STEPS[index - 1] ?? null) : null;
}

/**
 * The privacy goals a user may choose from.
 *
 * A fixed set rather than a text box, and ATL-015's migration says why:
 * *"Stored as text rather than an enum so ATL-016 can adjust the options without
 * a schema migration; the allowed values are enforced in the service."* It also
 * satisfies the acceptance criterion that onboarding requests no sensitive
 * fields — a free-text goal is an invitation to type something personal, and it
 * would then be a Confidential value in a column nothing masks.
 *
 * The goals describe *why someone is here*, not anything about them.
 */
export const PRIVACY_GOALS = [
  {
    id: "reduce_exposure",
    label: "Reduce my exposure",
    hint: "Find accounts I no longer use and close them down",
  },
  {
    id: "understand_footprint",
    label: "Understand my footprint",
    hint: "See what exists before deciding what to change",
  },
  {
    id: "control_data",
    label: "Take back my data",
    hint: "Ask services what they hold and request deletion",
  },
  {
    id: "stay_organised",
    label: "Stay on top of it",
    hint: "Keep track of accounts and permissions over time",
  },
] as const;

export type PrivacyGoalId = (typeof PRIVACY_GOALS)[number]["id"];

const GOAL_IDS: ReadonlySet<string> = new Set(PRIVACY_GOALS.map((g) => g.id));

export function isPrivacyGoal(value: string): value is PrivacyGoalId {
  return GOAL_IDS.has(value);
}

/**
 * Legacy backward-compatibility vocabulary — retained for safe parsing of
 * stored `onboarding_state_json` rows written before Repair #2.
 *
 * The `starting_point` UI step has been removed from the primary onboarding
 * journey (OQ-03: demo mode is post-signup only). These types and validators
 * remain so that `parseOnboardingState` can safely recover old persisted rows
 * without throwing or discarding other valid fields. No primary-flow code reads
 * or writes `startingPoint` via user interaction; the Zod `.catch(null)` in
 * `onboarding-state.ts` handles unknown or stale values gracefully.
 *
 * Do not render these options in the primary onboarding UI.
 */
export const STARTING_POINTS = [
  {
    id: "demo",
    label: "Explore with sample data",
    hint: "See how Atlas works using clearly-labelled example accounts you can remove at any time",
  },
  {
    id: "own",
    label: "Start with my own accounts",
    hint: "Add your first account yourself. You can do this later instead",
  },
] as const;

export type StartingPointId = (typeof STARTING_POINTS)[number]["id"];

const STARTING_POINT_IDS: ReadonlySet<string> = new Set(STARTING_POINTS.map((s) => s.id));

export function isStartingPoint(value: string): value is StartingPointId {
  return STARTING_POINT_IDS.has(value);
}
