"use client";

/**
 * Discovery consent notice component (ATL-210).
 *
 * Renders the consent state for one provider: a grant panel when not consented,
 * or a consented state with optional revoke trigger when consented.
 */

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { DiscoveryProviderView, DiscoveryConsentActionState } from "./discovery-view";
import { INITIAL_DISCOVERY_CONSENT_ACTION_STATE } from "./discovery-view";

export type DiscoveryConsentGrantAction = (
  prev: DiscoveryConsentActionState,
  formData: FormData,
) => Promise<DiscoveryConsentActionState>;

export type DiscoveryConsentRevokeAction = (
  prev: DiscoveryConsentActionState,
  formData: FormData,
) => Promise<DiscoveryConsentActionState>;

// Stable no-op fallback used when revokeAction is undefined.
function noopAction(prev: DiscoveryConsentActionState): Promise<DiscoveryConsentActionState> {
  return Promise.resolve(prev);
}

const COPY = {
  grantHeading: "Enable discovery",
  grantDescription:
    "Allow Atlas to search this provider for information associated with your identity fields.",
  grantButton: "Enable",
  grantedHeading: "Discovery enabled",
  grantedDescription: "This provider is active and may be used in future discovery runs.",
  revokeButton: "Revoke",
  errorUnavailable: "Something went wrong. Please try again.",
} as const;

export interface DiscoveryConsentNoticeProps {
  provider: DiscoveryProviderView;
  isConsented: boolean;
  grantedAt: string | null;
  grantAction: DiscoveryConsentGrantAction;
  revokeAction?: DiscoveryConsentRevokeAction;
}

export function DiscoveryConsentNotice({
  provider,
  isConsented,
  grantedAt,
  grantAction,
  revokeAction,
}: DiscoveryConsentNoticeProps) {
  const [grantState, submitGrant, grantPending] = useActionState(
    grantAction,
    INITIAL_DISCOVERY_CONSENT_ACTION_STATE,
  );
  const [revokeState, submitRevoke, revokePending] = useActionState(
    revokeAction ?? noopAction,
    INITIAL_DISCOVERY_CONSENT_ACTION_STATE,
  );

  const actionState = isConsented ? revokeState : grantState;

  return (
    <div
      data-slot="discovery-consent-notice"
      data-provider-class={provider.providerClass}
      data-consent-type={provider.consentType}
      className="rounded-card border border-border-default bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <p className="text-body-sm font-medium text-text-primary">
            {isConsented ? COPY.grantedHeading : COPY.grantHeading}
          </p>
          <p className="mt-1 text-body-sm text-text-secondary">
            {isConsented ? COPY.grantedDescription : COPY.grantDescription}
          </p>
          {isConsented && grantedAt && (
            <p className="text-text-tertiary mt-1 text-body-sm">
              Enabled{" "}
              <time dateTime={grantedAt}>
                {new Date(grantedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </time>
            </p>
          )}
        </div>

        <div className="shrink-0">
          {isConsented ? (
            revokeAction ? (
              <form action={submitRevoke}>
                <Button
                  type="submit"
                  variant="tertiary"
                  disabled={revokePending}
                  data-slot="consent-revoke-button"
                >
                  {COPY.revokeButton}
                </Button>
              </form>
            ) : null
          ) : (
            <form action={submitGrant}>
              <Button
                type="submit"
                variant="primary"
                disabled={grantPending}
                data-slot="consent-grant-button"
              >
                {COPY.grantButton}
              </Button>
            </form>
          )}
        </div>
      </div>

      {actionState.failure !== null && (
        <p
          key={actionState.attempt}
          role="alert"
          data-slot="consent-error"
          className="mt-3 rounded-control bg-danger/10 p-3 text-body-sm text-danger"
        >
          {COPY.errorUnavailable}
        </p>
      )}
    </div>
  );
}
