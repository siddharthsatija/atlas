"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { PersonalFieldKey } from "@/lib/personal-fields";
import {
  DiscoveryToggle,
  PersonalFieldsConsent,
  PERSONAL_FIELD_KIND_LABELS,
  type PersonalFieldConsentAction,
  type PersonalFieldToggleAction,
} from "@/features/personal-fields";
import { ONBOARDING_STEP_COPY } from "./onboarding-copy";

/**
 * ATL-209: Identity Profile onboarding step.
 *
 * This component is in `features/onboarding` so that the onboarding route can
 * import it without creating a cross-feature cycle. The route
 * (`app/(onboarding)/onboarding/`) imports both this component *and* the server
 * actions, then passes the actions as props. The component never imports from
 * `app/` — see architecture §10 and the module boundary note in
 * `identity-profile-actions.ts`.
 *
 * ## Local state, not revalidatePath
 *
 * Unlike settings, there is no product page to revalidate. The step holds its
 * own field list and updates it from the structured return values of each
 * action, so the UI stays consistent without a full server round-trip.
 *
 * ## Consent gate
 *
 * If `isStoragePermitted` is false, the `PersonalFieldsConsent` panel is shown
 * instead of the add form. Once the user grants permission, the onboarding page
 * rerenders (because `grantConsentAction` revalidates or the parent advances),
 * and this component receives `isStoragePermitted = true`.
 *
 * Calling `grantConsentAction` directly from this step, not from
 * `settings/actions`, keeps the onboarding server-action module self-contained
 * (architecture note in `identity-profile-actions.ts`).
 *
 * ## Soft email gate
 *
 * The step shows a visible warning when no email field has
 * `includeInDiscovery = true`, because an email address is the most effective
 * discovery starting point. Continue is never blocked — the gate is informational,
 * not a barrier.
 *
 * ## Field keys
 *
 * Only email, full_name, phone, and address are offered. The `username` and
 * `other` keys are excluded from the ATL-209 UI in both onboarding and settings
 * (the schema and service still support them).
 *
 * ## Upgrade mode
 *
 * Pre-M13 users arrive here with `isUpgradeMode = true`. `completeAction` calls
 * `redirect("/overview")` in that case, which throws — the `onAdvance` callback
 * is never reached. For new users, `completeAction` returns normally and
 * `onAdvance()` is called to advance to the `ready` step.
 */

/** The four field keys offered in the ATL-209 UI. */
const ONBOARDING_FIELD_KEYS = ["email", "full_name", "phone", "address"] as const;
type OnboardingFieldKey = (typeof ONBOARDING_FIELD_KEYS)[number];

/** One field as this step renders it. */
export interface IdentityProfileFieldView {
  id: string;
  fieldKey: PersonalFieldKey;
  label: string;
  maskedValue: string;
  includeInDiscovery: boolean;
}

// ---- Action result types ---------------------------------------------------
// Declared here rather than imported from `app/` — a feature cannot reach into
// the route's module. The shapes match `SaveFieldResult` and `RemoveFieldResult`
// in `identity-profile-actions.ts` structurally, so TypeScript accepts the
// server actions directly where these prop types are expected.

type AddFieldResult =
  | { ok: true; field: IdentityProfileFieldView }
  | { ok: false; failure: "invalid" | "consent_required" | "unavailable" };

type RemoveFieldResult =
  | { ok: true }
  | { ok: false; fieldInUse: boolean; failure: "field_in_use" | "not_found" | "unavailable" };

// ---- Props -----------------------------------------------------------------

export interface IdentityProfileStepProps {
  /** From `PersonalFieldService.isStoragePermitted`, resolved server-side. */
  isStoragePermitted: boolean;
  /** Server-loaded fields. The step adds/removes from this locally. */
  initialFields: IdentityProfileFieldView[];
  /**
   * True for pre-M13 users who completed onboarding before this step existed.
   * `completeAction` calls `redirect("/overview")` in this case — the `onAdvance`
   * callback is never reached.
   */
  isUpgradeMode: boolean;
  /** Passed to `PersonalFieldsConsent`. Uses ConsentService directly, not settings/actions. */
  grantConsentAction: PersonalFieldConsentAction;
  /** Adds one field. Restricted to the four discovery-relevant keys server-side. */
  addFieldAction: (
    fieldKey: PersonalFieldKey,
    label: string,
    value: string,
  ) => Promise<AddFieldResult>;
  /** Toggles `include_in_discovery` on one field. */
  setDiscoveryAction: PersonalFieldToggleAction;
  /** Deletes one field. Uses `removeField()` to block deletions during active runs. */
  removeFieldAction: (fieldId: string) => Promise<RemoveFieldResult>;
  /**
   * Stamps `identity_profile_step_completed_at`.
   * For upgrade-mode users, throws a Next.js redirect to `/overview`.
   * For new users, returns normally.
   */
  completeAction: (isUpgradeMode: boolean) => Promise<void>;
  /** Advance to the next onboarding step. Only called when not in upgrade mode. */
  onAdvance: () => void;
}

// ---- Per-field ephemeral state ---------------------------------------------

interface FieldRowState {
  confirming: boolean;
  removing: boolean;
  removeError: string | null;
}

// ---- Component -------------------------------------------------------------

const copy = ONBOARDING_STEP_COPY.identity_profile;

export function IdentityProfileStep({
  isStoragePermitted,
  initialFields,
  isUpgradeMode,
  grantConsentAction,
  addFieldAction,
  setDiscoveryAction,
  removeFieldAction,
  completeAction,
  onAdvance,
}: IdentityProfileStepProps) {
  // ---- Field list state ---------------------------------------------------
  const [fields, setFields] = useState<IdentityProfileFieldView[]>(initialFields);

  // ---- Add-form state -----------------------------------------------------
  const [formKey, setFormKey] = useState<OnboardingFieldKey>("email");
  const [formLabel, setFormLabel] = useState("");
  const [formValue, setFormValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [addPending, startAddTransition] = useTransition();

  // ---- Per-field state (confirm/remove) ------------------------------------
  const [rowStates, setRowStates] = useState<Map<string, FieldRowState>>(new Map());

  function getRowState(id: string): FieldRowState {
    return rowStates.get(id) ?? { confirming: false, removing: false, removeError: null };
  }

  function setRowState(id: string, patch: Partial<FieldRowState>) {
    setRowStates((prev) => {
      const next = new Map(prev);
      next.set(id, { ...getRowStateFromMap(prev, id), ...patch });
      return next;
    });
  }

  function getRowStateFromMap(map: Map<string, FieldRowState>, id: string): FieldRowState {
    return map.get(id) ?? { confirming: false, removing: false, removeError: null };
  }

  // ---- Continue state ------------------------------------------------------
  const [completePending, startCompleteTransition] = useTransition();

  // ---- Derived state -------------------------------------------------------

  /**
   * Soft email gate: no email with includeInDiscovery = true.
   *
   * Visible warning, but Continue is always available regardless.
   */
  const hasDiscoverableEmail = fields.some((f) => f.fieldKey === "email" && f.includeInDiscovery);

  // ---- Handlers -----------------------------------------------------------

  function handleAdd() {
    setFormError(null);
    startAddTransition(async () => {
      const result = await addFieldAction(formKey, formLabel, formValue);
      if (result.ok) {
        setFields((prev) => [...prev, result.field]);
        setFormLabel("");
        setFormValue("");
      } else {
        if (result.failure === "consent_required") {
          setFormError(copy.consentPreamble);
        } else if (result.failure === "invalid") {
          setFormError("A label and a value are both needed.");
        } else {
          setFormError("Atlas could not save that just now. Please try again.");
        }
      }
    });
  }

  function handleRemoveClick(fieldId: string) {
    setRowState(fieldId, { confirming: true, removeError: null });
  }

  function handleRemoveCancel(fieldId: string) {
    setRowState(fieldId, { confirming: false, removeError: null });
  }

  function handleRemoveConfirm(fieldId: string) {
    setRowState(fieldId, { removing: true, removeError: null });
    void (async () => {
      const result = await removeFieldAction(fieldId);
      if (result.ok) {
        setFields((prev) => prev.filter((f) => f.id !== fieldId));
        setRowStates((prev) => {
          const next = new Map(prev);
          next.delete(fieldId);
          return next;
        });
      } else {
        const msg =
          result.failure === "field_in_use"
            ? copy.fieldInUseError
            : result.failure === "not_found"
              ? "That detail is no longer here."
              : "Atlas could not remove that just now. Please try again.";
        setRowState(fieldId, { removing: false, confirming: false, removeError: msg });
      }
    })();
  }

  function handleContinue() {
    startCompleteTransition(async () => {
      await completeAction(isUpgradeMode);
      // Upgrade mode calls redirect(), which throws — we never reach here.
      // New users return normally and advance.
      onAdvance();
    });
  }

  // ---- Render --------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6" data-slot="identity-profile-step">
      <div className="flex flex-col gap-1">
        <h2 className="text-heading-sm text-text-primary">{copy.title}</h2>
        <p className="text-body-sm text-text-secondary">{copy.lede}</p>
      </div>

      {/* Soft email gate warning */}
      {isStoragePermitted && fields.length > 0 && !hasDiscoverableEmail && (
        <p
          role="status"
          data-slot="identity-profile-email-gate"
          className="rounded-control border border-border-default bg-surface px-3 py-2 text-body-sm text-text-secondary"
        >
          {copy.softGateWarning}
        </p>
      )}

      {/* Field list */}
      {fields.length > 0 && (
        <ul className="flex flex-col gap-3" data-slot="identity-profile-fields">
          {fields.map((field) => {
            const row = getRowState(field.id);
            return (
              <li
                key={field.id}
                data-slot="identity-profile-field-row"
                className="flex flex-col gap-3 rounded-card border border-border-default bg-surface p-4"
              >
                {/* Header: label + kind */}
                <div className="flex flex-col gap-0.5">
                  <span className="text-label font-medium text-text-primary">{field.label}</span>
                  <span className="text-body-sm text-text-muted">
                    {PERSONAL_FIELD_KIND_LABELS[field.fieldKey]}
                  </span>
                  <span className="text-body-sm text-text-muted">{field.maskedValue}</span>
                </div>

                {/* Discovery toggle */}
                <DiscoveryToggle
                  fieldId={field.id}
                  enabled={field.includeInDiscovery}
                  action={setDiscoveryAction}
                />

                {/* Remove controls */}
                {row.confirming ? (
                  <div
                    className="flex flex-col gap-2"
                    data-slot="identity-profile-field-confirm-remove"
                  >
                    <p className="text-body-sm text-text-primary">
                      Permanently delete &ldquo;{field.label}&rdquo;? This cannot be undone.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={row.removing}
                        onClick={() => handleRemoveConfirm(field.id)}
                        data-slot="identity-profile-field-confirm-delete"
                      >
                        Delete permanently
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={row.removing}
                        onClick={() => handleRemoveCancel(field.id)}
                        data-slot="identity-profile-field-cancel-delete"
                      >
                        Keep it
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={row.removing}
                    onClick={() => handleRemoveClick(field.id)}
                    aria-label={`Delete: ${field.label}`}
                    data-slot="identity-profile-field-delete-trigger"
                  >
                    Delete
                  </Button>
                )}

                {/* Per-field remove error (durable, not a toast) */}
                {row.removeError !== null && (
                  <p
                    role="alert"
                    data-slot="identity-profile-field-remove-error"
                    className="rounded-control bg-danger/10 p-3 text-body-sm text-danger"
                  >
                    {row.removeError}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* No fields yet */}
      {isStoragePermitted && fields.length === 0 && (
        <p className="text-body-sm text-text-muted" data-slot="identity-profile-empty">
          {copy.noFieldsYet}
        </p>
      )}

      {/* Consent gate or add form */}
      {!isStoragePermitted ? (
        <div className="flex flex-col gap-3" data-slot="identity-profile-consent-gate">
          <p className="text-body-sm text-text-secondary">{copy.consentPreamble}</p>
          <PersonalFieldsConsent action={grantConsentAction} disclosures={true} />
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-slot="identity-profile-add-form">
          <h3 className="text-label font-medium text-text-primary">{copy.addFieldTitle}</h3>

          {/* Field type selector */}
          <div className="flex flex-col gap-1">
            <label htmlFor="identity-field-key" className="text-label text-text-primary">
              Kind of detail
            </label>
            <select
              id="identity-field-key"
              value={formKey}
              onChange={(e) => setFormKey(e.target.value as OnboardingFieldKey)}
              disabled={addPending}
              className="focus-visible:ring-ring rounded-control border border-border-default bg-background px-3 py-2 text-body-sm text-text-primary focus-visible:ring-2 focus-visible:outline-none"
            >
              {ONBOARDING_FIELD_KEYS.map((key) => (
                <option key={key} value={key}>
                  {PERSONAL_FIELD_KIND_LABELS[key]}
                </option>
              ))}
            </select>
          </div>

          {/* Label input */}
          <div className="flex flex-col gap-1">
            <label htmlFor="identity-field-label" className="text-label text-text-primary">
              Label
            </label>
            <input
              id="identity-field-label"
              type="text"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              disabled={addPending}
              placeholder="e.g. Work email"
              className="focus-visible:ring-ring rounded-control border border-border-default bg-background px-3 py-2 text-body-sm text-text-primary placeholder:text-text-muted focus-visible:ring-2 focus-visible:outline-none"
            />
            <p className="text-body-sm text-text-muted">
              Your own name for it, so you can tell two of the same kind apart.
            </p>
          </div>

          {/* Value input */}
          <div className="flex flex-col gap-1">
            <label htmlFor="identity-field-value" className="text-label text-text-primary">
              Value
            </label>
            <input
              id="identity-field-value"
              type="text"
              value={formValue}
              onChange={(e) => setFormValue(e.target.value)}
              disabled={addPending}
              className="focus-visible:ring-ring rounded-control border border-border-default bg-background px-3 py-2 text-body-sm text-text-primary placeholder:text-text-muted focus-visible:ring-2 focus-visible:outline-none"
            />
          </div>

          <Button
            type="button"
            disabled={addPending || !formLabel.trim() || !formValue.trim()}
            onClick={handleAdd}
            data-slot="identity-profile-add-submit"
          >
            {copy.addSubmit}
          </Button>

          {/* Add-form error (durable) */}
          {formError !== null && (
            <p
              role="alert"
              data-slot="identity-profile-add-error"
              className="rounded-control bg-danger/10 p-3 text-body-sm text-danger"
            >
              {formError}
            </p>
          )}
        </div>
      )}

      {/* Continue */}
      <Button
        type="button"
        disabled={completePending}
        onClick={handleContinue}
        data-slot="identity-profile-continue"
      >
        Continue
      </Button>
    </div>
  );
}
