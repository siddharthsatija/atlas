"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REQUEST_REVIEW_COPY } from "./request-review-copy";

/**
 * Where the request is going (ATL-058, frontend §10, FR-08).
 *
 * ## The address is the person's, and Atlas says so
 *
 * FR-08: "The recipient address is entered or confirmed by the user in MVP (no
 * verified service directory until Phase 2) and is clearly marked unverified."
 * There is no lookup, no suggestion, and no autofill from anywhere Atlas knows —
 * offering one would imply Atlas had checked, and it has not. The unverified
 * notice sits with the field rather than in a footnote, because it qualifies
 * *this* value and a person skimming should not be able to miss it.
 *
 * ## Validation is shape only
 *
 * `checkRecipient` runs server-side on submit; `type="email"` here gives the
 * browser's own hint and the right keyboard on a phone. Neither is a claim that
 * the address is correct — only that it looks like an address. `noValidate` is
 * not set, so the browser may refuse an obviously malformed value before the
 * round trip; the server refuses it again regardless, because a client check is
 * never the gate.
 */

export interface RequestRecipientProps {
  /** Restored from a stored draft, or empty on a first visit. */
  defaultValue: string;
  /** Set when the previous submission was refused, so the field is marked. */
  invalid: boolean;
}

/**
 * No section heading here: this is one field, and a visually-hidden heading
 * repeating the label would make a screen-reader user hear "Send to" twice
 * before reaching the input. The `<Label>` is what names it.
 */
export function RequestRecipient({ defaultValue, invalid }: RequestRecipientProps) {
  return (
    <div className="flex flex-col gap-2" data-slot="request-recipient">
      <Label htmlFor="request-recipient">{REQUEST_REVIEW_COPY.recipientLabel}</Label>

      <Input
        id="request-recipient"
        name="recipient"
        type="email"
        required
        autoComplete="off"
        defaultValue={defaultValue}
        {...(invalid ? { state: "error" as const } : {})}
        aria-describedby="request-recipient-hint request-recipient-unverified"
        data-slot="request-recipient-input"
      />

      <p id="request-recipient-hint" className="text-body-sm text-text-muted">
        {REQUEST_REVIEW_COPY.recipientHint}
      </p>

      {/*
        Not a toast and not a tooltip: the claim qualifies the value, so it stays
        on screen with it. Frontend §19 — durable status appears in the page.
      */}
      <p
        id="request-recipient-unverified"
        data-slot="request-recipient-unverified"
        className="text-body-sm text-text-secondary"
      >
        {REQUEST_REVIEW_COPY.recipientUnverified}
      </p>
    </div>
  );
}
