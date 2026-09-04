"use client";

/**
 * Settings > Discovery section (ATL-210).
 *
 * Renders the full discovery management surface for Settings.
 */

import { useState } from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { DiscoveryConsentNotice } from "./discovery-consent-notice";
import type {
  DiscoveryProviderView,
  DiscoveryConsentState,
  DiscoveryAcknowledgmentView,
} from "./discovery-view";
import { INITIAL_DISCOVERY_CONSENT_ACTION_STATE } from "./discovery-view";
import type { DiscoveryConsentActionState } from "./discovery-view";
import type {
  DiscoveryConsentGrantAction,
  DiscoveryConsentRevokeAction,
} from "./discovery-consent-notice";

// ---- Copy -------------------------------------------------------------------

const COPY = {
  sectionTitle: "Discovery",
  sectionDescription:
    "Atlas can search external sources to find information associated with your identity. Manage which providers are enabled and review what data has been shared.",
  noProvidersTitle: "No discovery providers configured",
  noProvidersBody:
    "Discovery providers will appear here when Atlas has search integrations enabled.",
  historyTitle: "First-disclosure history",
  historyDescription:
    "Each entry records that you acknowledged data transmission to a provider for a specific identity field.",
  historyEmpty: "No acknowledgments recorded.",
  historyUnavailable:
    "Acknowledgment history could not be retrieved. This is a temporary error — your history has not been deleted.",
  historyFieldLabel: "Field",
  historyProviderLabel: "Provider",
  historyVersionLabel: "Contract version",
  historyDateLabel: "Acknowledged",
  revokeConfirmHeading: "Confirm revocation",
  revokeConfirmNote:
    "Revoking consent prevents future lookups. Lookups that are already running continue until they reach a terminal state — consent revocation does not cancel them.",
  revokeConfirmButton: "Confirm revocation",
  revokeCancelButton: "Keep enabled",
  errorUnavailable: "Something went wrong. Please try again.",
} as const;

// ---- Props ------------------------------------------------------------------

export interface DiscoverySectionProps {
  providers: readonly DiscoveryProviderView[];
  consentStateByType: Record<string, DiscoveryConsentState>;
  acknowledgmentHistory: readonly DiscoveryAcknowledgmentView[];
  acknowledgmentHistoryUnavailable?: boolean;
  grantActionFactory: (consentType: string) => DiscoveryConsentGrantAction;
  revokeActionFactory: (consentType: string) => DiscoveryConsentRevokeAction;
}

// ---- Component --------------------------------------------------------------

export function DiscoverySection({
  providers,
  consentStateByType,
  acknowledgmentHistory,
  acknowledgmentHistoryUnavailable = false,
  grantActionFactory,
  revokeActionFactory,
}: DiscoverySectionProps) {
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);

  const uniqueTypes = Array.from(new Set(providers.map((p) => p.consentType)));
  const providerByType = new Map(providers.map((p) => [p.consentType, p]));

  return (
    <section
      aria-labelledby="discovery-section-heading"
      data-slot="discovery-section"
      className="space-y-6"
    >
      <div>
        <h2 id="discovery-section-heading" className="text-heading-md text-text-primary">
          {COPY.sectionTitle}
        </h2>
        <p className="mt-1 text-body-sm text-text-secondary">{COPY.sectionDescription}</p>
      </div>

      {providers.length === 0 ? (
        <div
          data-slot="discovery-no-providers"
          className="rounded-card border border-border-default bg-surface p-4"
        >
          <p className="text-body-sm font-medium text-text-primary">{COPY.noProvidersTitle}</p>
          <p className="mt-1 text-body-sm text-text-secondary">{COPY.noProvidersBody}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {uniqueTypes.map((consentType) => {
            const provider = providerByType.get(consentType);
            if (!provider) return null;

            const state = consentStateByType[consentType];
            const isConsented = state?.granted ?? false;
            const grantedAt = state?.grantedAt ?? null;
            const isConfirming = confirmingRevoke === consentType;

            if (isConsented && isConfirming) {
              return (
                <RevokeConfirmPanel
                  key={consentType}
                  consentType={consentType}
                  revokeActionFactory={revokeActionFactory}
                  onCancel={() => setConfirmingRevoke(null)}
                />
              );
            }

            return (
              <div key={consentType}>
                <DiscoveryConsentNotice
                  provider={provider}
                  isConsented={isConsented}
                  grantedAt={grantedAt}
                  grantAction={grantActionFactory(consentType)}
                  {...(isConsented
                    ? {
                        revokeAction: (prev: DiscoveryConsentActionState) => {
                          setConfirmingRevoke(consentType);
                          return Promise.resolve(prev);
                        },
                      }
                    : {})}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Acknowledgment history ---------------------------------------- */}
      <div className="space-y-3">
        <div>
          <h3 className="text-heading-sm text-text-primary">{COPY.historyTitle}</h3>
          <p className="mt-1 text-body-sm text-text-secondary">{COPY.historyDescription}</p>
        </div>

        {acknowledgmentHistoryUnavailable ? (
          <p
            role="alert"
            className="text-body-sm text-warning"
            data-slot="discovery-history-unavailable"
          >
            {COPY.historyUnavailable}
          </p>
        ) : acknowledgmentHistory.length === 0 ? (
          <p className="text-body-sm text-text-secondary" data-slot="discovery-history-empty">
            {COPY.historyEmpty}
          </p>
        ) : (
          <div
            className="overflow-x-auto rounded-card border border-border-default"
            data-slot="discovery-history-table"
          >
            <table className="w-full text-body-sm">
              <thead>
                <tr className="border-b border-border-default bg-surface-subtle">
                  <th className="text-label-sm px-4 py-2 text-left text-text-secondary">
                    {COPY.historyFieldLabel}
                  </th>
                  <th className="text-label-sm px-4 py-2 text-left text-text-secondary">
                    {COPY.historyProviderLabel}
                  </th>
                  <th className="text-label-sm px-4 py-2 text-left text-text-secondary">
                    {COPY.historyVersionLabel}
                  </th>
                  <th className="text-label-sm px-4 py-2 text-left text-text-secondary">
                    {COPY.historyDateLabel}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {acknowledgmentHistory.map((ack, i) => (
                  <tr key={i} className="bg-surface">
                    <td className="px-4 py-2 text-text-primary">
                      <span className="font-medium">{ack.fieldLabel}</span>
                      <span className="text-text-tertiary ml-2">{ack.maskedValue}</span>
                    </td>
                    <td className="px-4 py-2 text-text-secondary">{ack.providerClass}</td>
                    <td className="px-4 py-2 font-mono text-text-secondary">
                      {ack.disclosureContractVersion}
                    </td>
                    <td className="px-4 py-2 text-text-secondary">
                      <time dateTime={ack.acknowledgedAt}>
                        {new Date(ack.acknowledgedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ---- Revoke confirmation panel ---------------------------------------------

interface RevokeConfirmPanelProps {
  consentType: string;
  revokeActionFactory: (consentType: string) => DiscoveryConsentRevokeAction;
  onCancel: () => void;
}

function RevokeConfirmPanel({
  consentType,
  revokeActionFactory,
  onCancel,
}: RevokeConfirmPanelProps) {
  const [state, submitRevoke, revokePending] = useActionState(
    revokeActionFactory(consentType),
    INITIAL_DISCOVERY_CONSENT_ACTION_STATE,
  );

  return (
    <div
      data-slot="revoke-confirm-panel"
      data-consent-type={consentType}
      className="flex flex-col gap-3 rounded-card border border-danger/30 bg-danger/5 p-4"
    >
      <h3 className="text-heading-sm text-text-primary">{COPY.revokeConfirmHeading}</h3>
      <p className="text-body-sm text-text-secondary">{COPY.revokeConfirmNote}</p>

      {state.failure !== null && (
        <p
          key={state.attempt}
          role="alert"
          data-slot="revoke-error"
          className="rounded-control bg-danger/10 p-3 text-body-sm text-danger"
        >
          {COPY.errorUnavailable}
        </p>
      )}

      <div className="flex items-center gap-3">
        <form action={submitRevoke}>
          <Button
            type="submit"
            variant="destructive"
            disabled={revokePending}
            data-slot="revoke-confirm-button"
          >
            {COPY.revokeConfirmButton}
          </Button>
        </form>
        <Button variant="tertiary" onClick={onCancel} data-slot="revoke-cancel-button">
          {COPY.revokeCancelButton}
        </Button>
      </div>
    </div>
  );
}
