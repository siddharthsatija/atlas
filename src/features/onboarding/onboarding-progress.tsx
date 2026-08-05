import {
  ONBOARDING_STEPS,
  stepPosition,
  type OnboardingStep,
} from "@/lib/onboarding/onboarding-steps";
import { cn } from "@/lib/utils";

/**
 * Progress indicator (frontend §17 "Progress indicator").
 *
 * Built here rather than as a shared primitive: nothing else in the product is a
 * linear wizard, and a general-purpose stepper invented for one caller is a
 * guess about the second one.
 *
 * ## Accessibility
 *
 * The bar is decorative and hidden from assistive technology; the step count is
 * carried by real text instead. A screen-reader user gets "Step 2 of 5" as a
 * sentence rather than having to interpret a row of dots, and the text is
 * visible to everyone rather than being an `sr-only` translation of a graphic
 * only some users can see.
 */
export function OnboardingProgress({ step }: { step: OnboardingStep }) {
  const position = stepPosition(step);
  const total = ONBOARDING_STEPS.length;

  return (
    <div className="mb-6">
      <p className="mb-2 text-body-sm text-text-secondary">
        Step {position} of {total}
      </p>

      <div aria-hidden="true" className="flex gap-1.5">
        {ONBOARDING_STEPS.map((each, index) => (
          <span
            key={each}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              index < position ? "bg-accent" : "bg-surface-subtle",
            )}
          />
        ))}
      </div>
    </div>
  );
}
