"use client";

import { SensitiveValue } from "@/components/ui/sensitive-value";
import { revealAccountIdentifierAction } from "@/app/(product)/assets/[id]/actions";

/**
 * The account identifier on the asset detail page (ATL-035).
 *
 * A thin binding, on purpose. `SensitiveValue` (ATL-009) already owns masking,
 * deliberate reveal, automatic re-masking, the announcement, and the audit seam;
 * a second component that re-implemented any of that would be a second place for
 * the behaviour to drift, and security §8's whole point is that there is one.
 *
 * What this adds is the only thing the primitive cannot know: where the value
 * comes from.
 *
 * ## The plaintext is not on this page until the user asks
 *
 * The component receives `masked` — produced server-side by
 * `readMaskedAccountIdentifier`, which cannot return plaintext at all — and an
 * asset id. The full value exists only as the resolved return of a Server Action
 * call made in response to a click, so it is absent from the initial RSC payload,
 * absent from the HTML, and absent from every prop React serialises. Masking a
 * value the server already sent would be hiding, not protecting.
 *
 * Re-masking is the primitive's `revealDurationMs`; this component does not
 * override it, so the timeout is defined once for every surface.
 */

export interface AccountIdentifierProps {
  /** Already masked, server-side. Never the full value. */
  masked: string;
  assetId: string;
}

export function AccountIdentifier({ masked, assetId }: AccountIdentifierProps) {
  return (
    <SensitiveValue
      masked={masked}
      label="Account identifier"
      entityType="asset"
      entityId={assetId}
      onReveal={async () => {
        const result = await revealAccountIdentifierAction(assetId);

        /**
         * Throwing puts the primitive into its error state, which shows a
         * refusal without a reason. The service already refuses "missing",
         * "not yours" and "the audit log is down" identically; inventing a
         * message here would undo that.
         */
        if (!result.ok || result.value === null) {
          throw new Error("identifier unavailable");
        }

        return result.value;
      }}
    />
  );
}
