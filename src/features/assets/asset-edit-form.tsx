"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ASSET_CATEGORIES } from "@/lib/assets/categories";
import {
  MAX_ACCOUNT_IDENTIFIER_LENGTH,
  parseCreateAssetForm,
  type CreateAssetFieldErrors,
} from "@/lib/assets/asset-form";
import { MAX_NOTES_LENGTH, MAX_SERVICE_NAME_LENGTH } from "@/lib/assets/asset-fields";
import { cn } from "@/lib/utils";

/**
 * Edit a service (ATL-033, frontend §7 header action "Edit").
 *
 * A client component because it validates as the user submits and re-renders
 * field errors without a round trip. The write itself is a Server Action — no
 * Supabase call is made from the browser, so no credential reaches the bundle.
 *
 * ## The same schema runs twice, on purpose
 *
 * `parseCreateAssetForm` is imported here *and* by the action. The client parse
 * gives immediate feedback; the server parse is the one that decides. Sharing
 * the schema is what stops the two disagreeing — the failure mode of two
 * schemas is that the form accepts something the server then silently rejects.
 *
 * ## Every field is controlled, and that is load-bearing
 *
 * React resets a form after its action completes, and `defaultValue` is only
 * read when an input mounts. So an uncontrolled form gets the worst of both:
 * fields the user should keep are wiped by the reset, and the one field that
 * must be wiped survives — because on the client-rejected path the action never
 * runs and nothing resets anything.
 *
 * Both halves of ATL-032's contract therefore depend on React owning these
 * values:
 *
 *  1. **Everything except the identifier is preserved** across a failed
 *     submission, re-seeded from what the server returned.
 *  2. **The account identifier is cleared** on any failure, from either path. It
 *     is Restricted (security §3), `preservedValues` keeps it out of the
 *     response payload, and controlling the input is what keeps it out of the
 *     DOM.
 *
 * The hint text tells the user the identifier will need retyping, so the empty
 * field is explained rather than surprising.
 */

export interface AssetEditFormState {
  errors: CreateAssetFieldErrors;
  failure: "unavailable" | "not_found" | null;
  values: Record<string, string>;
  attempt: number;
}

export interface AssetEditFormProps {
  action: (state: AssetEditFormState, formData: FormData) => Promise<AssetEditFormState>;
  initialState: AssetEditFormState;
  assetId: string;
  /** The asset's current values, seeding the first render. */
  asset: { serviceName: string; category: string; serviceDomain: string; notes: string };
}

/** Renders a field's error and wires it to the input for assistive technology. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-body-sm text-danger">
      {message}
    </p>
  );
}

export function AssetEditForm({ action, initialState, assetId, asset }: AssetEditFormProps) {
  const [state, submit, pending] = useActionState(action, initialState);

  /**
   * Client-side errors, held separately from the server's.
   *
   * Merged at render with the server's taking precedence: the server is the
   * authority, and showing a stale client message next to a server one would be
   * two answers to the same question.
   */
  const [clientErrors, setClientErrors] = useState<CreateAssetFieldErrors>({});
  const errors: CreateAssetFieldErrors = { ...clientErrors, ...state.errors };

  /**
   * Two remount tokens, and everything else is an ordinary uncontrolled input.
   *
   * Controlling the values does not work here. React resets the form after an
   * action completes, changing the DOM *without* changing what React believes it
   * rendered — so when a re-seeded value matches the previous one, the diff finds
   * nothing to do and the DOM keeps the reset value. Remounting is the only
   * reliable correction, so the fields are keyed and read their values from
   * `defaultValue` on each fresh mount.
   *
   * `state.attempt` increments only when the Server Action returned, so the
   * preserved fields remount with whatever the server sent back.
   */
  const preservedKey = state.attempt;

  /**
   * The identifier needs its own token, incremented on **both** failure paths.
   *
   * A client-rejected submission never reaches the server, so `attempt` does not
   * move — and that is precisely the path on which the value was found lingering
   * in the DOM. This token moves on either kind of failure, and the input
   * remounts empty because it has no `defaultValue` at all.
   */
  const [clientRejections, setClientRejections] = useState(0);
  const identifierKey = `${String(state.attempt)}-${String(clientRejections)}`;

  /** Points an input at its error message and its hint, for assistive technology. */
  const describedBy = (field: string, hint?: string) => {
    const ids = [errors[field as keyof CreateAssetFieldErrors] ? `${field}-error` : null, hint]
      .filter(Boolean)
      .join(" ");
    return ids || undefined;
  };

  return (
    <form
      action={submit}
      noValidate
      onSubmit={(event) => {
        /**
         * Validates before the action runs, so an obviously invalid form does
         * not cost a round trip. `noValidate` turns off the browser's own
         * bubbles, which cannot be styled and do not match the product's voice.
         */
        const data = new FormData(event.currentTarget);
        const parsed = parseCreateAssetForm(Object.fromEntries(data));
        setClientErrors(parsed.errors);

        if (!parsed.success) {
          event.preventDefault();
          /**
           * Remounts the identifier so it comes back empty. Nothing else would
           * clear it on this path — which is exactly how the value was found
           * still sitting in the field after a failed submission. The other
           * inputs are untouched, so the user keeps what they typed while they
           * fix the problem.
           */
          setClientRejections((count) => count + 1);
        }
      }}
      className="flex max-w-2xl flex-col gap-6"
    >
      <input type="hidden" name="assetId" value={assetId} />
      {state.failure && (
        <p role="alert" className="rounded-control bg-danger/10 p-3 text-body-sm text-danger">
          {state.failure === "not_found"
            ? "This service is no longer available."
            : "Something went wrong saving this service. Your details are still here — please try again."}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor="serviceName">Service name</Label>
        <Input
          key={preservedKey}
          id="serviceName"
          name="serviceName"
          required
          maxLength={MAX_SERVICE_NAME_LENGTH}
          defaultValue={state.values.serviceName ?? asset.serviceName}
          aria-invalid={Boolean(errors.serviceName)}
          aria-describedby={describedBy("serviceName")}
        />
        <FieldError
          id="serviceName-error"
          {...(errors.serviceName && { message: errors.serviceName })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="category">Kind of service</Label>
        <select
          key={preservedKey}
          id="category"
          name="category"
          required
          defaultValue={state.values.category ?? asset.category}
          aria-invalid={Boolean(errors.category)}
          aria-describedby={describedBy("category")}
          className="h-11 rounded-control border border-border-default bg-surface px-2 text-body-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          <option value="">Choose one</option>
          {ASSET_CATEGORIES.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </select>
        <FieldError id="category-error" {...(errors.category && { message: errors.category })} />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="serviceDomain">Website (optional)</Label>
        <Input
          key={preservedKey}
          id="serviceDomain"
          name="serviceDomain"
          defaultValue={state.values.serviceDomain ?? asset.serviceDomain}
          placeholder="example.com"
          aria-invalid={Boolean(errors.serviceDomain)}
          aria-describedby={describedBy("serviceDomain", "serviceDomain-hint")}
        />
        <p id="serviceDomain-hint" className="text-body-sm text-text-muted">
          Just the domain — no https:// and no page path.
        </p>
        <FieldError
          id="serviceDomain-error"
          {...(errors.serviceDomain && { message: errors.serviceDomain })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="accountIdentifier">Account identifier (optional)</Label>
        <Input
          key={identifierKey}
          id="accountIdentifier"
          name="accountIdentifier"
          maxLength={MAX_ACCOUNT_IDENTIFIER_LENGTH}
          // No `defaultValue` at all: a fresh mount is always empty, and the
          // server never sends this field back.
          autoComplete="off"
          aria-invalid={Boolean(errors.accountIdentifier)}
          aria-describedby={describedBy("accountIdentifier", "accountIdentifier-hint")}
        />
        <p id="accountIdentifier-hint" className="text-body-sm text-text-muted">
          The username or email this account is under. Stored encrypted and shown masked. If
          something else on this form needs fixing, you will need to type this again — Atlas does
          not send it back to your browser.
        </p>
        <FieldError
          id="accountIdentifier-error"
          {...(errors.accountIdentifier && { message: errors.accountIdentifier })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="notes">Notes (optional)</Label>
        <textarea
          key={preservedKey}
          id="notes"
          name="notes"
          rows={3}
          maxLength={MAX_NOTES_LENGTH}
          defaultValue={state.values.notes ?? asset.notes}
          aria-invalid={Boolean(errors.notes)}
          aria-describedby={describedBy("notes")}
          className={cn(
            "rounded-control border border-border-default bg-surface px-3 py-2",
            "text-body-sm text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
          )}
        />
        <FieldError id="notes-error" {...(errors.notes && { message: errors.notes })} />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending}>
          Save changes
        </Button>
        <Button variant="tertiary" asChild>
          <Link href={`/assets/${assetId}`}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
