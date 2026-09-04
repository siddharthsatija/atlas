import type { Metadata } from "next";
import {
  PageContainer,
  PageHeader,
  PageTitle,
  PageDescription,
} from "@/components/layout/page-layout";
import { PersonalFieldsSection, type PersonalFieldView } from "@/features/personal-fields";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { PersonalFieldService } from "@/server/personal-fields/personal-field-service";
import {
  addPersonalFieldAction,
  deletePersonalFieldAction,
  editPersonalFieldAction,
  setIncludeInDiscoveryAction,
} from "./actions";
import { grantDiscoveryConsentAction, revokeDiscoveryConsentAction } from "./discovery-actions";
import { DiscoverySection } from "@/features/discovery";
import type { DiscoveryAcknowledgmentView, DiscoveryConsentState } from "@/features/discovery";
import { DiscoveryConsentService } from "@/server/discovery/discovery-consent-service";
import {
  DisclosureAcknowledgmentRepository,
  type DisclosureAcknowledgmentRecord,
} from "@/server/repositories/disclosure-acknowledgment-repository";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { getUiVisibleProviders } from "@/lib/discovery/discovery-provider-registry";

export const metadata: Metadata = { title: "Settings" };

/**
 * Settings, currently carrying one section: Personal data (ATL-106, ATL-209).
 *
 * The shell — navigation between Profile, Security, Privacy and AI, Notifications
 * and Data — is **ATL-074 – ATL-077** and is deliberately not built here. This
 * renders the one section ATL-106 owns, so those tickets add theirs alongside
 * rather than around a structure this ticket invented for them.
 *
 * ## A server component, because that is what keeps the plaintext away
 *
 * Both reads happen here: `listMasked`, which cannot return a full value at all,
 * and `isStoragePermitted`, which is the consent decision ATL-105 owns. The
 * section receives masked strings and a boolean. Nothing on this page can put a
 * stored value into the RSC payload — the only way to a plaintext is the reveal
 * action, called from the browser in response to a click, which audits first.
 *
 * ## Failures do not blank the section
 *
 * A failed `listMasked` renders as an empty list rather than an error page: the
 * consent panel and the disclosures are still true and still useful, and losing
 * them would leave someone unable to read how their data is handled because a
 * query failed. The service has already logged the fault.
 *
 * ## ATL-209: includeInDiscovery and setDiscoveryAction
 *
 * `listMasked` now returns `includeInDiscovery` on each record. The field mapping
 * forwards it to the view model so `PersonalFieldsSection` can render
 * `DiscoveryToggle` per row. `setIncludeInDiscoveryAction` is passed as the
 * toggle's action — it is a direct-call server action, not a `useActionState`
 * action, matching the `PersonalFieldToggleAction` contract.
 */
export default async function SettingsPage() {
  const user = await requireVerifiedUser();
  const service = PersonalFieldService.create();

  const [listed, permitted] = await Promise.all([
    service.listMasked(user.id),
    service.isStoragePermitted(user.id),
  ]);

  // ATL-210: resolve discovery providers, consent state, and ack history.
  const activeProviders = getUiVisibleProviders();
  const uniqueConsentTypes = Array.from(new Set(activeProviders.map((p) => p.consentType)));

  const db = createServiceRoleClient();
  const discoveryService = DiscoveryConsentService.create(db);
  const ackRepo = new DisclosureAcknowledgmentRepository(db);

  // Consent checks — one per unique consent type. Empty in ATL-210 ship state.
  const consentCheckResults = await Promise.all(
    uniqueConsentTypes.map(async (consentType) => {
      try {
        const granted = await discoveryService.hasActiveConsent(user.id, consentType);
        return { consentType, granted };
      } catch {
        return { consentType, granted: false };
      }
    }),
  );

  // Acknowledgment history.
  let rawAckHistoryRows: DisclosureAcknowledgmentRecord[] = [];
  let acknowledgmentHistoryUnavailable = false;
  if (activeProviders.length > 0) {
    try {
      rawAckHistoryRows = await ackRepo.listByUser(user.id);
    } catch {
      acknowledgmentHistoryUnavailable = true;
    }
  }

  /**
   * Mapped into the feature's own view model rather than passed through.
   * `MaskedPersonalField` carries `userId`, `createdAt` and `updatedAt` that no
   * part of this surface renders, and a component that receives fields it does not
   * use is a component that can start using them without anyone deciding to.
   *
   * `includeInDiscovery` is included (ATL-209): the section needs it to initialise
   * each `DiscoveryToggle`.
   */
  const fields: PersonalFieldView[] = listed.ok
    ? listed.data.map((field) => ({
        id: field.id,
        fieldKey: field.fieldKey,
        label: field.label,
        maskedValue: field.maskedValue,
        lastUsedAt: field.lastUsedAt,
        includeInDiscovery: field.includeInDiscovery,
      }))
    : [];

  // Build discovery consent state map.
  const discoveryConsentStateByType: Record<string, DiscoveryConsentState> = {};
  for (const result of consentCheckResults) {
    discoveryConsentStateByType[result.consentType] = {
      consentType: result.consentType,
      granted: result.granted,
      grantedAt: null,
    };
  }

  // Join acknowledgment rows with masked field data for display.
  const maskedFieldMap = new Map(
    (listed.ok ? listed.data : []).map((f) => [
      f.id,
      { label: f.label, maskedValue: f.maskedValue },
    ]),
  );

  const acknowledgmentHistory: DiscoveryAcknowledgmentView[] = rawAckHistoryRows.map((row) => {
    const fieldData = maskedFieldMap.get(row.fieldId);
    return {
      fieldId: row.fieldId,
      fieldLabel: fieldData?.label ?? row.fieldId,
      maskedValue: fieldData?.maskedValue ?? "••••",
      providerClass: row.providerClass,
      disclosureContractVersion: row.disclosureContractVersion,
      acknowledgedAt: row.acknowledgedAt,
    };
  });

  const activeDiscoveryProviders = activeProviders.map((p) => ({
    providerClass: p.providerClass,
    consentType: p.consentType,
    disclosureClass: p.disclosureClass,
    disclosureContractVersion: p.disclosureContractVersion,
  }));

  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Settings</PageTitle>
        <PageDescription>Profile, security, privacy, and data controls.</PageDescription>
      </PageHeader>

      <PersonalFieldsSection
        fields={fields}
        permitted={permitted}
        addAction={addPersonalFieldAction}
        editAction={editPersonalFieldAction}
        deleteAction={deletePersonalFieldAction}
        setDiscoveryAction={setIncludeInDiscoveryAction}
      />

      <DiscoverySection
        providers={activeDiscoveryProviders}
        consentStateByType={discoveryConsentStateByType}
        acknowledgmentHistory={acknowledgmentHistory}
        acknowledgmentHistoryUnavailable={acknowledgmentHistoryUnavailable}
        grantActionFactory={(consentType) =>
          grantDiscoveryConsentAction.bind(
            null,
            consentType as Parameters<typeof grantDiscoveryConsentAction>[0],
          )
        }
        revokeActionFactory={(consentType) =>
          revokeDiscoveryConsentAction.bind(
            null,
            consentType as Parameters<typeof revokeDiscoveryConsentAction>[0],
          )
        }
      />
    </PageContainer>
  );
}
