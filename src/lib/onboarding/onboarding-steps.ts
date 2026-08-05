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

/** Frontend §17, in order. */
export const ONBOARDING_STEPS = [
  "introduction",
  "privacy_goal",
  "categories",
  "starting_point",
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
 * `ready` is not skippable because it *is* the completion action.
 *
 * Everything that collects a preference is optional, so a user can reach the
 * dashboard without telling Atlas anything about themselves.
 */
export const SKIPPABLE_STEPS: readonly OnboardingStep[] = [
  "privacy_goal",
  "categories",
  "starting_point",
];

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
 * What the user chooses at step 4 (§17 "Demo data or add an asset").
 *
 * ATL-016 records the choice; **ATL-018 owns the demo seed itself**. Choosing
 * `demo` here sets `profiles.demo_data_enabled`, which is the flag ATL-018 keys
 * its separation on — it does not create any demo record.
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
