"use client";

import { useOptimistic, useTransition } from "react";
import { PERSONAL_FIELDS_COPY } from "./personal-fields-copy";
import type { PersonalFieldToggleAction } from "./personal-fields-view";

/**
 * ATL-209: `include_in_discovery` toggle for personal-field rows.
 *
 * Used in both the identity-profile onboarding step and Settings → Personal
 * data. The containing component passes the current persisted state and an
 * action; the toggle manages optimistic updates locally via `useOptimistic`.
 *
 * ## Optimistic state
 *
 * The switch flips immediately on click and the action runs in the background.
 * If the server call fails, React rolls the optimistic value back to the last
 * committed value (the `enabled` prop). The component does not surface a
 * per-toggle error message: the field list rerenders on the next page visit
 * with the true persisted state, and a transient failure here is not a
 * data-loss scenario — the user can toggle again.
 *
 * ## Accessibility
 *
 * `role="switch"` + `aria-checked` is the ARIA pattern for a two-state
 * toggle (WAI-ARIA 1.2, §6.2.8). The label is visible text; the hint beneath
 * it is associated via `aria-describedby` so screen readers read the full
 * context when focusing the control.
 *
 * ## Why not a form
 *
 * The toggle is a boolean flip with no other data — a form would add a hidden
 * input, a submit button, and a `formData` parse round-trip for no benefit.
 * The direct-call pattern (`PersonalFieldToggleAction`) keeps the call site
 * and the server action's signature identical.
 */

export interface DiscoveryToggleProps {
  fieldId: string;
  /** Current persisted state. `useOptimistic` initialises from this. */
  enabled: boolean;
  action: PersonalFieldToggleAction;
}

export function DiscoveryToggle({ fieldId, enabled, action }: DiscoveryToggleProps) {
  const [optimisticEnabled, setOptimisticEnabled] = useOptimistic(enabled);
  const [, startTransition] = useTransition();

  const hintId = `discovery-hint-${fieldId}`;
  const labelId = `discovery-label-${fieldId}`;

  function toggle() {
    const next = !optimisticEnabled;
    startTransition(async () => {
      setOptimisticEnabled(next);
      await action(fieldId, next);
    });
  }

  return (
    <div className="flex items-start gap-3" data-slot="discovery-toggle-row">
      <button
        type="button"
        role="switch"
        aria-checked={optimisticEnabled}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onClick={toggle}
        data-slot="discovery-toggle"
        data-state={optimisticEnabled ? "checked" : "unchecked"}
        className={[
          "relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full",
          "border-2 border-transparent transition-colors",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
          "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={[
            "pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm",
            "transition-transform",
            optimisticEnabled ? "translate-x-4" : "translate-x-0",
          ].join(" ")}
        />
      </button>

      <div className="flex flex-col gap-0.5">
        <span id={labelId} className="text-label text-text-primary">
          {PERSONAL_FIELDS_COPY.discoveryToggleLabel}
        </span>
        <span id={hintId} className="text-body-sm text-text-secondary">
          {PERSONAL_FIELDS_COPY.discoveryToggleHint}
        </span>
      </div>
    </div>
  );
}
