"use client";

import { SensitiveValue } from "@/components/ui/sensitive-value";
import { revealPersonalFieldAction } from "@/app/(product)/settings/actions";
import { PERSONAL_FIELDS_COPY } from "./personal-fields-copy";

/**
 * One saved value in Settings → Personal data (ATL-106).
 *
 * A thin binding, on purpose — the same shape as `account-identifier.tsx`, and
 * for the same reason it gives: `SensitiveValue` (ATL-009) already owns masking,
 * deliberate reveal, automatic re-masking, the announcement and the audit seam. A
 * second component that re-implemented any of that would be a second place for
 * the behaviour to drift, and security §8's whole point is that there is one.
 *
 * What this adds is the only thing the primitive cannot know: where the value
 * comes from.
 *
 * ## The plaintext is not on this page until the person asks
 *
 * The component receives `masked` — produced server-side by
 * `PersonalFieldService.listMasked`, which cannot return plaintext at all — and a
 * field id. The full value exists only as the resolved return of a Server Action
 * call made in response to a click, so it is absent from the initial RSC payload,
 * absent from the HTML, and absent from every prop React serialises.
 *
 * ## Reveal stays audited even here
 *
 * `revealPersonalFieldAction` calls `PersonalFieldService.reveal`, which writes
 * `personal_field.revealed` before returning. There is no path through this
 * component that produces a value without that event.
 *
 * Re-masking is the primitive's `revealDurationMs`; this does not override it, so
 * the timeout is defined once for every surface.
 */

export interface PersonalFieldValueProps {
  /** Already masked, server-side. Never the full value. */
  masked: string;
  fieldId: string;
  /** The person's own label, so assistive technology names the right row. */
  label: string;
}

export function PersonalFieldValue({ masked, fieldId, label }: PersonalFieldValueProps) {
  return (
    <SensitiveValue
      masked={masked}
      label={`${PERSONAL_FIELDS_COPY.revealLabel}: ${label}`}
      entityType="personal_field"
      entityId={fieldId}
      onReveal={async () => {
        const result = await revealPersonalFieldAction(fieldId);

        /**
         * Throwing puts the primitive into its error state, which shows a refusal
         * without a reason. The service already refuses "missing", "not yours" and
         * "the audit log is down" identically; inventing a message here would
         * undo that.
         */
        if (!result.ok || result.value === null) {
          throw new Error("personal field unavailable");
        }

        return result.value;
      }}
    />
  );
}
