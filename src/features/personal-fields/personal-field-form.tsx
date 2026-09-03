"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PERSONAL_FIELD_LABEL_MAX_LENGTH, type PersonalFieldKey } from "@/lib/personal-fields";
import { PERSONAL_FIELDS_COPY, PERSONAL_FIELD_KIND_OPTIONS } from "./personal-fields-copy";
import {
  INITIAL_FORM_VIEW_STATE,
  type PersonalFieldFormAction,
  type PersonalFieldFormViewState,
} from "./personal-fields-view";

/**
 * The add and edit form for a personal detail (ATL-106).
 *
 * One component for both, because the two differ only in which fields are shown
 * and which action receives them. Two components would be two places for the
 * value-handling rules below to drift, and those rules are the security-relevant
 * part.
 *
 * ## The value input is never pre-filled
 *
 * On edit, `Label` carries the current text but the value box starts empty and an
 * empty value means "leave it alone" (the action only forwards a value the person
 * typed). Pre-filling would require sending the plaintext to the browser to render
 * it — which is exactly what `listMasked` exists to avoid, and what would put a
 * secret into the RSC payload and the DOM for anyone who merely opened the form.
 *
 * The same rule applies after a failure: `PersonalFieldFormState` preserves the
 * label and the kind but deliberately not the value, so a refused save does not
 * put the secret back on screen.
 *
 * ## Why a client component
 *
 * `useActionState` is the only way to get an action's return value back into the
 * page, and it is a hook. The trade `AssetActionForm` already made for the same
 * reason: the submission itself still posts through a real `<form action>` and
 * works without JavaScript; only the *display of a failure* needs it.
 */

export interface PersonalFieldFormProps {
  mode: "add" | "edit";
  action: PersonalFieldFormAction;
  /** Present on edit: the row being changed. */
  fieldId?: string;
  /** Present on edit: the current label, so it can be adjusted rather than retyped. */
  currentLabel?: string;
  /** Present on edit: the current kind, shown as read-only text. */
  currentFieldKey?: PersonalFieldKey;
  /** Rendered when writes are unavailable — withdrawn consent disables the form. */
  disabled?: boolean;
  onDone?: () => void;
}

const FAILURE_COPY: Record<NonNullable<PersonalFieldFormViewState["failure"]>, string> = {
  consent_required: PERSONAL_FIELDS_COPY.failureConsentRequired,
  field_in_use: PERSONAL_FIELDS_COPY.failureFieldInUse,
  invalid: PERSONAL_FIELDS_COPY.failureInvalid,
  not_found: PERSONAL_FIELDS_COPY.failureNotFound,
  unavailable: PERSONAL_FIELDS_COPY.failureUnavailable,
};

export function PersonalFieldForm({
  mode,
  action,
  fieldId,
  currentLabel,
  currentFieldKey,
  disabled = false,
  onDone,
}: PersonalFieldFormProps) {
  const [state, submit, pending] = useActionState(action, INITIAL_FORM_VIEW_STATE);

  /** Fires once a write has actually landed, so a parent can close the editor. */
  if (state.saved === true && onDone) onDone();

  const idPrefix = mode === "add" ? "add-personal-field" : `edit-personal-field-${fieldId ?? ""}`;

  return (
    <form action={submit} className="flex flex-col gap-3" data-slot={`personal-field-${mode}-form`}>
      {mode === "edit" && <input type="hidden" name="fieldId" value={fieldId ?? ""} />}

      {mode === "add" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-kind`}>{PERSONAL_FIELDS_COPY.kindField}</Label>
          {/*
            A native select rather than a custom listbox: this is a short list of
            six known values, and the platform control is keyboard- and
            screen-reader-correct without any of the roving-tabindex work a
            bespoke one would need.
          */}
          <select
            id={`${idPrefix}-kind`}
            name="fieldKey"
            required
            disabled={disabled}
            defaultValue={state.fieldKey ?? PERSONAL_FIELD_KIND_OPTIONS[0]?.key}
            className="rounded-control border border-border-default bg-surface px-3 py-2 text-body-sm text-text-primary"
          >
            {PERSONAL_FIELD_KIND_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        currentFieldKey !== undefined && (
          <p className="text-body-sm text-text-muted">
            {PERSONAL_FIELDS_COPY.kindField}:{" "}
            <span className="text-text-primary">
              {PERSONAL_FIELD_KIND_OPTIONS.find((o) => o.key === currentFieldKey)?.label}
            </span>
          </p>
        )
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-label`}>{PERSONAL_FIELDS_COPY.labelField}</Label>
        <Input
          id={`${idPrefix}-label`}
          name="label"
          required={mode === "add"}
          maxLength={PERSONAL_FIELD_LABEL_MAX_LENGTH}
          disabled={disabled}
          defaultValue={state.label ?? currentLabel ?? ""}
          aria-describedby={`${idPrefix}-label-hint`}
        />
        <p id={`${idPrefix}-label-hint`} className="text-body-sm text-text-muted">
          {PERSONAL_FIELDS_COPY.labelHint}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-value`}>{PERSONAL_FIELDS_COPY.valueField}</Label>
        {/*
          `autoComplete="off"` so a browser does not offer to remember a value
          Atlas is about to encrypt, and never a `defaultValue` — see the module
          note on why the plaintext is not sent here.
        */}
        <Input
          id={`${idPrefix}-value`}
          name="value"
          required={mode === "add"}
          disabled={disabled}
          autoComplete="off"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={disabled || pending}>
          {mode === "add" ? PERSONAL_FIELDS_COPY.addSubmit : PERSONAL_FIELDS_COPY.editSubmit}
        </Button>
        {mode === "edit" && onDone && (
          <Button type="button" variant="secondary" onClick={onDone}>
            {PERSONAL_FIELDS_COPY.editCancel}
          </Button>
        )}
      </div>

      {/*
        Durable, keyed on `attempt` so a repeated identical failure is announced
        again — a live region is read when its content changes (frontend §19).
      */}
      {state.failure !== null && (
        <p
          key={state.attempt}
          role="alert"
          data-slot="personal-field-form-error"
          className="rounded-control bg-danger/10 p-3 text-body-sm text-danger"
        >
          {FAILURE_COPY[state.failure]}
        </p>
      )}
    </form>
  );
}
