"use client";

/**
 * Discovery consent section for the onboarding flow (ATL-210).
 *
 * Renders consent panels for each unique consent type among active providers.
 * Returns null when no providers are active — the onboarding flow conditionally
 * mounts this component, so the empty case is invisible to the user.
 *
 * Unlike the Settings > Discovery section, there is no revoke here: onboarding
 * is a grant-only surface. Revocation is a Settings action.
 */

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { DiscoveryProviderView, DiscoveryConsentState } from "./discovery-view";
import { INITIAL_DISCOVERY_CONSENT_ACTION_STATE } from "./discovery-view";
import type { DiscoveryConsentGrantAction } from "./discovery-consent-notice";

const COPY = {
  sectionTitle: "Discovery",
  sectionDescription:
    "Allow Atlas to search external sources for information associated with your identity. You can change these settings later.",
  grantButton: "Enable",
  enabledLabel: "Enabled",
  errorUnavailable: "Something went wrong. Please try again.",
} as const;

export interface DiscoveryConsentSectionProps {
  providers: readonly DiscoveryProviderView[];
  consentStateByType: Record<string, DiscoveryConsentState>;
  grantActionFactory: (consentType: string) => DiscoveryConsentGrantAction;
}

export function DiscoveryConsentSection({
  providers,
  consentStateByType,
  grantActionFactory,
}: DiscoveryConsentSectionProps) {
  if (providers.length === 0) return null;

  const uniqueTypes = Array.from(new Set(providers.map((p) => p.consentType)));
  const providerByType = new Map(providers.map((p) => [p.consentType, p]));

  return (
    <section
      aria-labelledby="onboarding-discovery-heading"
      data-slot="discovery-consent-section"
      className="space-y-4"
    >
      <div>
        <h3 id="onboarding-discovery-heading" className="text-heading-sm text-text-primary">
          {COPY.sectionTitle}
        </h3>
        <p className="mt-1 text-body-sm text-text-secondary">{COPY.sectionDescription}</p>
      </div>

      <div className="space-y-3">
        {uniqueTypes.map((consentType) => {
          const provider = providerByType.get(consentType);
          if (!provider) return null;

          const state = consentStateByType[consentType];
          const isConsented = state?.granted ?? false;

          return (
            <ConsentRow
              key={consentType}
              provider={provider}
              isConsented={isConsented}
              grantAction={grantActionFactory(consentType)}
            />
          );
        })}
      </div>
    </section>
  );
}

interface ConsentRowProps {
  provider: DiscoveryProviderView;
  isConsented: boolean;
  grantAction: DiscoveryConsentGrantAction;
}

function ConsentRow({ provider, isConsented, grantAction }: ConsentRowProps) {
  const [state, submitGrant, pending] = useActionState(
    grantAction,
    INITIAL_DISCOVERY_CONSENT_ACTION_STATE,
  );

  return (
    <div
      data-slot="consent-row"
      data-consent-type={provider.consentType}
      className="flex items-center justify-between rounded-card border border-border-default bg-surface p-3"
    >
      <span className="font-mono text-body-sm text-text-primary">{provider.providerClass}</span>

      <div className="flex items-center gap-3">
        {state.failure !== null && (
          <p key={state.attempt} role="alert" className="text-body-sm text-danger">
            {COPY.errorUnavailable}
          </p>
        )}

        {isConsented ? (
          <span className="text-body-sm font-medium text-success">{COPY.enabledLabel}</span>
        ) : (
          <form action={submitGrant}>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={pending}
              data-slot="consent-grant-button"
            >
              {COPY.grantButton}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
