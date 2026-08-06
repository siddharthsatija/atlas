import { z } from "zod";
import { isAssetCategory } from "@/lib/assets/categories";
import {
  ONBOARDING_STEPS,
  isPrivacyGoal,
  isStartingPoint,
  type OnboardingStep,
} from "./onboarding-steps";

/**
 * Resumable onboarding progress (ATL-017, frontend §17 "Save progress").
 *
 * ATL-016 built the flow with its step and answers in component state, so a
 * refresh lost everything and a user who left mid-setup started again. This
 * module defines what gets written to `profiles.onboarding_state_json` and — more
 * importantly — how it is read back.
 *
 * ## The column is untrusted input
 *
 * It is `jsonb` with only a `jsonb_typeof(...) = 'object'` check, so the database
 * guarantees an object and nothing about what is inside it. Anything could be in
 * there: a shape from an older release, a hand-edited row, a partial write. Since
 * the value decides which step a user lands on, a bad value must degrade to a
 * usable flow rather than a crashed one — hence `parseOnboardingState`, which
 * never throws.
 *
 * ## No sensitive values
 *
 * Every field is an id from a closed vocabulary that this module re-checks on the
 * way in and on the way out (ATL-015's migration: *"NO SENSITIVE VALUES"*). There
 * is no free-text field for anything personal to travel in, which is the same
 * line `OnboardingService.complete` holds — deliberately the same predicates, so
 * the two cannot drift apart.
 *
 * ## AI consent is deliberately not persisted
 *
 * ATL-016 requires the consent box to be *"unchecked by default and never
 * pre-selected"*, because a pre-ticked box produces a consent record that means
 * nothing (ATL-078, security §10). Saving the tick and restoring it on return
 * would reintroduce exactly that — a box the user finds already checked, agreeing
 * on their behalf to something they may never have submitted. So progress
 * persistence covers where the user got to and what they picked, and the consent
 * question is asked fresh every time they reach it.
 */

/** What a resumed session restores. */
export interface OnboardingState {
  /** The step to resume at. */
  step: OnboardingStep;
  /** Chosen privacy goal, or null when unanswered or skipped. */
  privacyGoal: string | null;
  /** Chosen asset categories. */
  categories: string[];
  /** `demo` or `own`, or null when unanswered or skipped. */
  startingPoint: string | null;
}

/**
 * A user who has saved nothing, and the recovery target for state that cannot be
 * salvaged at all.
 *
 * The first step is the safe one in both directions: it asks nothing, so nobody
 * loses an answer by landing there, and it carries the limitations copy the
 * product is obliged to show (ATL-016 acceptance criteria). Sending a confused
 * session forward instead — to a step whose prerequisites may be missing — would
 * skip that copy for the users whose state was already unreliable.
 */
export const INITIAL_ONBOARDING_STATE = {
  step: ONBOARDING_STEPS[0],
  privacyGoal: null,
  categories: [] as string[],
  startingPoint: null,
} satisfies OnboardingState;

/** Matches ATL-015's `selected_categories` bound, so state cannot outgrow the column it feeds. */
export const MAX_SELECTED_CATEGORIES = 32;

/**
 * The stored shape.
 *
 * Every field carries its own `.catch`, which is what makes recovery
 * field-by-field rather than all-or-nothing. A single unrecognised category
 * should not discard the step the user reached and the goal they chose — losing
 * four answers to repair one is a worse outcome for them than for us, and the
 * acceptance criterion asks for recovery to the *nearest* safe step, not to the
 * beginning.
 *
 * The vocabulary predicates are the same ones `OnboardingService.complete` uses,
 * so a value that cannot be chosen also cannot be resumed.
 */
export const onboardingStateSchema = z
  .object({
    /**
     * The one field with no partial answer: the flow has to render *somewhere*,
     * and guessing forward from broken state could place a user past the
     * limitations copy. So this alone falls back to the start, while the answers
     * below are still recovered — returning to step one with your choices intact
     * is a far smaller loss than returning to an empty flow.
     */
    step: z.enum(ONBOARDING_STEPS).catch(ONBOARDING_STEPS[0]),
    privacyGoal: z.string().refine(isPrivacyGoal).nullable().catch(null),
    startingPoint: z.string().refine(isStartingPoint).nullable().catch(null),
    /**
     * Entries are filtered rather than validated as a whole, so one stale id
     * does not cost the user every category they picked. Deduplicated because
     * the column it feeds is a set in meaning if not in type, and bounded so a
     * tampered row cannot outgrow what `selected_categories` accepts.
     */
    categories: z
      .array(z.unknown())
      .catch([])
      .transform((entries) =>
        [
          ...new Set(
            entries.filter(
              (entry): entry is string => typeof entry === "string" && isAssetCategory(entry),
            ),
          ),
        ].slice(0, MAX_SELECTED_CATEGORIES),
      ),
  })
  // Anything that is not an object at all — null, an array, a string, a number.
  .catch(INITIAL_ONBOARDING_STATE);

/**
 * Reads stored progress, salvaging whatever is still valid.
 *
 * Never throws. Every failure path resolves to a state the flow can render,
 * which is the whole point: this value decides which step a user lands on, and
 * it comes from a column the database barely constrains.
 */
export function parseOnboardingState(value: unknown): OnboardingState {
  return onboardingStateSchema.parse(value);
}

/**
 * The value written to `onboarding_state_json`.
 *
 * Re-parsed on the way out so the stored shape can never be wider than the
 * schema, and returned as a plain record because the generated `Json` type
 * requires an index signature that a named interface does not have.
 */
export function serializeOnboardingState(
  state: OnboardingState,
): Record<string, string | string[] | null> {
  const parsed = parseOnboardingState(state);
  return {
    step: parsed.step,
    privacyGoal: parsed.privacyGoal,
    categories: parsed.categories,
    startingPoint: parsed.startingPoint,
  };
}

/**
 * True when the state holds nothing worth restoring.
 *
 * Lets the caller skip a write that would store `{}` over `{}`, and lets the UI
 * tell "never started" from "started and chose nothing".
 */
export function isInitialOnboardingState(state: OnboardingState): boolean {
  return (
    state.step === INITIAL_ONBOARDING_STATE.step &&
    state.privacyGoal === null &&
    state.startingPoint === null &&
    state.categories.length === 0
  );
}
