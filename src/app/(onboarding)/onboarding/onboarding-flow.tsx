"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { ASSET_CATEGORIES } from "@/lib/assets/categories";
import { INITIAL_ONBOARDING_STATE, type OnboardingState } from "@/lib/onboarding/onboarding-state";
import {
  PRIVACY_GOALS,
  STARTING_POINTS,
  isSkippable,
  nextStep,
  previousStep,
  type OnboardingStep,
} from "@/lib/onboarding/onboarding-steps";
import {
  AI_CONSENT_COPY,
  ONBOARDING_INTRO,
  ONBOARDING_LIMITATIONS,
  ONBOARDING_STEP_COPY,
  OnboardingProgress,
  IdentityProfileStep,
  type IdentityProfileFieldView,
} from "@/features/onboarding";
import { completeOnboardingAction } from "./actions";
import {
  grantStorageConsentForOnboardingAction,
  saveOnboardingFieldAction,
  setOnboardingFieldDiscoveryAction,
  removeOnboardingFieldAction,
  completeIdentityProfileStepAction,
} from "./identity-profile-actions";
import { INITIAL_COMPLETE_STATE } from "./form-state";
import { cn } from "@/lib/utils";

/**
 * The onboarding flow (ATL-016, frontend §17).
 *
 * A client component because the step sequence is interaction state: moving
 * between steps must not cost a round trip, and the back button should return to
 * the previous *step* rather than the previous page.
 *
 * ## State lives here, and is mirrored to storage
 *
 * Choices are held in component state and submitted once, at the end. **ATL-017**
 * additionally mirrors the step and the answers to
 * `profiles.onboarding_state_json` as the user moves, so a refresh or a return
 * the next day resumes where they left off.
 *
 * The mirror is one-way and best-effort: this component remains the source of
 * truth for the session, and a failed save costs the user their saved position,
 * never their current one. `aiConsent` is the one field that is never mirrored —
 * see `onboarding-state.ts` for why restoring a ticked consent box would be
 * worse than asking again.
 *
 * ## Nothing sensitive is collected (except in identity_profile)
 *
 * Every input on steps 1–4 is a choice from a fixed set. The identity_profile
 * step (ATL-209) collects contact details — email, name, phone, address. Those
 * are handled by `IdentityProfileStep`, which manages its own field state and
 * interacts with dedicated server actions isolated from `settings/actions.ts`.
 *
 * ## Upgrade mode (ATL-209)
 *
 * Pre-M13 users who completed onboarding before `identity_profile` existed are
 * sent here with `isUpgradeMode = true`. They see only the identity_profile step.
 * The flow starts there, hides the progress indicator and outer navigation, and
 * `completeIdentityProfileStepAction(true)` redirects to `/overview` on success.
 */

interface Answers {
  privacyGoal: string | null;
  categories: string[];
  startingPoint: string | null;
  aiConsent: boolean;
}

export interface OnboardingFlowProps {
  /**
   * Progress restored from `profiles.onboarding_state_json` (ATL-017).
   *
   * Server-resolved rather than fetched after mount, so a returning user sees
   * their step immediately instead of the introduction flashing past — the same
   * reasoning as ATL-006's server-resolved sidebar state.
   */
  initialState?: OnboardingState;
  /**
   * Persists progress. Injected rather than imported so this component stays
   * testable with a plain spy, matching the ATL-006 sidebar contract.
   *
   * Optional: the flow is fully usable without it, the position simply does not
   * survive a refresh.
   */
  onStateChange?: (state: OnboardingState) => void | Promise<void>;

  // ---- ATL-209: identity profile step props --------------------------------

  /**
   * Whether the user has granted `personal_fields_storage` consent.
   *
   * Resolved server-side by the page so the consent panel or the add form
   * renders on the first paint without a loading state.
   */
  isStoragePermitted?: boolean;
  /**
   * The user's current identity-profile fields, loaded by the page.
   *
   * Empty for first-time visitors; may contain existing fields for returning
   * users who navigated back to this step.
   */
  identityProfileFields?: IdentityProfileFieldView[];
  /**
   * True for pre-M13 users who completed onboarding before this step existed.
   *
   * When true, the flow starts at `identity_profile`, hides the progress
   * indicator and outer navigation, and the complete action redirects to
   * `/overview` rather than advancing to `ready`.
   */
  isUpgradeMode?: boolean;
}

export function OnboardingFlow({
  initialState,
  onStateChange,
  isStoragePermitted = false,
  identityProfileFields = [],
  isUpgradeMode = false,
}: OnboardingFlowProps = {}) {
  const resumed = initialState ?? INITIAL_ONBOARDING_STATE;

  const [step, setStep] = useState<OnboardingStep>(
    isUpgradeMode ? "identity_profile" : resumed.step,
  );
  const [answers, setAnswers] = useState<Answers>({
    privacyGoal: resumed.privacyGoal,
    categories: resumed.categories,
    startingPoint: resumed.startingPoint,
    // Never restored. ATL-016 requires this box to be unchecked and never
    // pre-selected, so consent is asked fresh on every return.
    aiConsent: false,
  });
  const [state, submit, pending] = useActionState(completeOnboardingAction, INITIAL_COMPLETE_STATE);
  const [, startSaveTransition] = useTransition();

  const back = previousStep(step);

  /**
   * Applies a step + answers change locally, then persists it.
   *
   * Fire-and-forget inside a transition: the step change renders immediately and
   * the save follows. A user pressing Continue is telling us where they want to
   * be, not asking permission to go there.
   */
  const persist = (nextState: OnboardingState) => {
    startSaveTransition(() => {
      void onStateChange?.(nextState);
    });
  };

  const goToStep = (next: OnboardingStep) => {
    setStep(next);
    persist({
      step: next,
      privacyGoal: answers.privacyGoal,
      categories: answers.categories,
      startingPoint: answers.startingPoint,
    });
  };

  /**
   * Records an answer and saves it against the step the user is on.
   *
   * The next value is computed from the current one *outside* `setAnswers`
   * rather than in an updater callback. An updater runs during the render pass,
   * and starting a transition from there is a React violation — the same trap
   * ATL-006 hit with the sidebar. Every caller here is a discrete user event, so
   * the closed-over value is current.
   */
  const answer = (change: Partial<Answers>) => {
    const updated = { ...answers, ...change };
    setAnswers(updated);
    persist({
      step,
      privacyGoal: updated.privacyGoal,
      categories: updated.categories,
      startingPoint: updated.startingPoint,
    });
  };

  /** Advances, or does nothing on the last step where the form takes over. */
  const advance = () => {
    const next = nextStep(step);
    if (next) goToStep(next);
  };

  return (
    <div>
      {/*
        Upgrade-mode users see only the identity_profile step and no progress
        bar — showing step 5 of 6 for a one-step flow would confuse them.
      */}
      {!isUpgradeMode && <OnboardingProgress step={step} />}

      <Card>
        {step === "introduction" && <IntroductionStep />}
        {step === "privacy_goal" && (
          <ChoiceStep
            copy={ONBOARDING_STEP_COPY.privacy_goal}
            options={PRIVACY_GOALS}
            selected={answers.privacyGoal ? [answers.privacyGoal] : []}
            onSelect={(id) => answer({ privacyGoal: id })}
          />
        )}
        {step === "categories" && (
          <ChoiceStep
            copy={ONBOARDING_STEP_COPY.categories}
            options={ASSET_CATEGORIES}
            multiple
            selected={answers.categories}
            onSelect={(id) =>
              answer({
                categories: answers.categories.includes(id)
                  ? answers.categories.filter((c) => c !== id)
                  : [...answers.categories, id],
              })
            }
          />
        )}
        {step === "starting_point" && (
          <ChoiceStep
            copy={ONBOARDING_STEP_COPY.starting_point}
            options={STARTING_POINTS}
            selected={answers.startingPoint ? [answers.startingPoint] : []}
            onSelect={(id) => answer({ startingPoint: id })}
          />
        )}

        {/*
          ATL-209: identity profile step.

          The flow imports the server actions directly (it is in `app/`) and
          passes them as props to the feature component, which is in `features/`
          and cannot import from `app/`. This keeps the dependency edge
          app/ → features/ and never the reverse.

          The step manages its own Continue button and calls completeAction
          which either redirects (upgrade mode) or returns so onAdvance fires.
          The outer navigation is therefore hidden for this step.
        */}
        {step === "identity_profile" && (
          <CardContent>
            <IdentityProfileStep
              isStoragePermitted={isStoragePermitted}
              initialFields={identityProfileFields}
              isUpgradeMode={isUpgradeMode}
              grantConsentAction={grantStorageConsentForOnboardingAction}
              addFieldAction={saveOnboardingFieldAction}
              setDiscoveryAction={setOnboardingFieldDiscoveryAction}
              removeFieldAction={removeOnboardingFieldAction}
              completeAction={completeIdentityProfileStepAction}
              onAdvance={advance}
            />
          </CardContent>
        )}

        {step === "ready" && (
          <ReadyStep
            answers={answers}
            onConsentChange={(aiConsent) => setAnswers({ ...answers, aiConsent })}
            submit={submit}
            pending={pending}
            failed={state.error !== null}
          />
        )}
      </Card>

      {/*
        Outer navigation.

        Hidden for `ready` (the form provides its own submit).
        Hidden for `identity_profile` (IdentityProfileStep provides Continue).

        For `identity_profile` in the full flow (not upgrade mode), a Back
        button is still shown so the user can revisit `starting_point`.
        In upgrade mode, there is nothing to go back to.
      */}
      {step !== "ready" && step !== "identity_profile" && (
        <div className="mt-6 flex items-center justify-between gap-3">
          <div>
            {back && (
              <Button variant="tertiary" onClick={() => goToStep(back)}>
                Back
              </Button>
            )}
          </div>

          <div className="flex items-center gap-3">
            {isSkippable(step) && (
              <Button variant="tertiary" onClick={advance}>
                Skip
              </Button>
            )}
            <Button onClick={advance}>Continue</Button>
          </div>
        </div>
      )}

      {step === "identity_profile" && !isUpgradeMode && back && (
        <div className="mt-6 flex items-center justify-start gap-3">
          <Button variant="tertiary" onClick={() => goToStep(back)}>
            Back
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The step question, rendered as the page's `h1`.
 *
 * `CardTitle` is an `h3`, which would leave these routes with no `h1` at all —
 * they render outside `AppShell`, so nothing else supplies one, and frontend §20
 * requires exactly one per page. The question *is* what the page is about, so it
 * is the right heading rather than a decorative one bolted above it.
 */
function StepTitle({ children }: { children: React.ReactNode }) {
  return <h1 className="text-h3 font-semibold">{children}</h1>;
}

function IntroductionStep() {
  return (
    <>
      <CardHeader>
        <StepTitle>{ONBOARDING_INTRO.title}</StepTitle>
        <CardDescription>{ONBOARDING_INTRO.lede}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ul className="space-y-2 text-body-sm text-text-secondary">
          {ONBOARDING_INTRO.capabilities.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        {/*
          The limitations carry the same visual weight as the capabilities
          above — a heading and full sentences, not fine print. PRD honesty
          rules; ATL-016 acceptance criteria.
        */}
        <section aria-labelledby="onboarding-limitations">
          <h2 id="onboarding-limitations" className="mb-3 text-body font-medium">
            {ONBOARDING_LIMITATIONS.title}
          </h2>
          <ul className="space-y-4">
            {ONBOARDING_LIMITATIONS.items.map((item) => (
              <li key={item.title}>
                <p className="text-body-sm font-medium text-text-primary">{item.title}</p>
                <p className="text-body-sm text-text-secondary">{item.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </CardContent>
    </>
  );
}

interface Option {
  id: string;
  label: string;
  hint: string;
}

/**
 * A step that asks the user to pick from a fixed set.
 *
 * Rendered as real radio or checkbox inputs rather than styled buttons: the
 * grouping, arrow-key behaviour, and announced state come from the platform,
 * and a `role="radiogroup"` reimplementation would have to rebuild all three.
 */
function ChoiceStep({
  copy,
  options,
  selected,
  onSelect,
  multiple = false,
}: {
  copy: { title: string; lede: string };
  options: readonly Option[];
  selected: string[];
  onSelect: (id: string) => void;
  multiple?: boolean;
}) {
  const name = multiple ? "categories" : "choice";

  return (
    <>
      <CardHeader>
        <StepTitle>{copy.title}</StepTitle>
        <CardDescription>{copy.lede}</CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset className="space-y-2">
          <legend className="sr-only">{copy.title}</legend>

          {options.map((option) => {
            const isSelected = selected.includes(option.id);

            return (
              <label
                key={option.id}
                htmlFor={`onboarding-${option.id}`}
                className={cn(
                  "grid cursor-pointer grid-cols-[auto_1fr] items-start gap-x-3 rounded-control border p-3",
                  "focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2",
                  isSelected
                    ? "border-accent bg-accent-subtle"
                    : "border-border-default hover:border-border-strong",
                )}
              >
                <input
                  id={`onboarding-${option.id}`}
                  type={multiple ? "checkbox" : "radio"}
                  name={name}
                  value={option.id}
                  checked={isSelected}
                  onChange={() => onSelect(option.id)}
                  aria-describedby={`onboarding-${option.id}-hint`}
                  className="mt-0.5 size-4 accent-[var(--color-accent)]"
                />
                {/* Label text sits directly in the label so it is the accessible
                    name; the hint is associated separately rather than folded
                    into that name, which would make it read as one long phrase. */}
                <span className="text-body-sm font-medium text-text-primary">{option.label}</span>
                <span
                  id={`onboarding-${option.id}-hint`}
                  className="col-start-2 text-body-sm text-text-secondary"
                >
                  {option.hint}
                </span>
              </label>
            );
          })}
        </fieldset>
      </CardContent>
    </>
  );
}

/**
 * The final step: confirms the choices, asks for AI consent, and submits.
 *
 * The answers travel as hidden inputs so the whole flow submits as one form —
 * which is also what lets the action read them without this component holding a
 * second copy of the vocabulary.
 */
function ReadyStep({
  answers,
  onConsentChange,
  submit,
  pending,
  failed,
}: {
  answers: Answers;
  onConsentChange: (value: boolean) => void;
  submit: (formData: FormData) => void;
  pending: boolean;
  failed: boolean;
}) {
  return (
    <>
      <CardHeader>
        <StepTitle>{ONBOARDING_STEP_COPY.ready.title}</StepTitle>
        <CardDescription>{ONBOARDING_STEP_COPY.ready.lede}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={submit} className="space-y-6">
          {answers.privacyGoal && (
            <input type="hidden" name="privacyGoal" value={answers.privacyGoal} />
          )}
          {answers.startingPoint && (
            <input type="hidden" name="startingPoint" value={answers.startingPoint} />
          )}
          {answers.categories.map((category) => (
            <input key={category} type="hidden" name="categories" value={category} />
          ))}

          {/*
            Unchecked by default and never pre-selected. A pre-ticked box would
            produce a consent record that means nothing (ATL-078, security §10).
          */}
          <label
            htmlFor="ai-processing-consent"
            className="grid grid-cols-[auto_1fr] items-start gap-x-3 rounded-control border border-border-default p-3 focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2"
          >
            <input
              id="ai-processing-consent"
              type="checkbox"
              name="aiProcessingConsent"
              checked={answers.aiConsent}
              onChange={(event) => onConsentChange(event.target.checked)}
              aria-describedby="ai-processing-consent-detail"
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
            />
            <span className="text-body-sm font-medium text-text-primary">
              {AI_CONSENT_COPY.label}
            </span>
            <span
              id="ai-processing-consent-detail"
              className="col-start-2 text-body-sm text-text-secondary"
            >
              {AI_CONSENT_COPY.body}
            </span>
          </label>

          {failed && (
            <p role="status" className="text-body-sm text-danger">
              Something went wrong finishing setup. Please try again.
            </p>
          )}

          <Button type="submit" loading={pending} className="w-full">
            Go to my dashboard
          </Button>
        </form>
      </CardContent>
    </>
  );
}
