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
} from "./actions";

export const metadata: Metadata = { title: "Settings" };

/**
 * Settings, currently carrying one section: Personal data (ATL-106).
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
 */
export default async function SettingsPage() {
  const user = await requireVerifiedUser();
  const service = PersonalFieldService.create();

  const [listed, permitted] = await Promise.all([
    service.listMasked(user.id),
    service.isStoragePermitted(user.id),
  ]);

  /**
   * Mapped into the feature's own view model rather than passed through.
   * `MaskedPersonalField` carries `userId`, `createdAt` and `updatedAt` that no
   * part of this surface renders, and a component that receives fields it does not
   * use is a component that can start using them without anyone deciding to.
   */
  const fields: PersonalFieldView[] = listed.ok
    ? listed.data.map((field) => ({
        id: field.id,
        fieldKey: field.fieldKey,
        label: field.label,
        maskedValue: field.maskedValue,
        lastUsedAt: field.lastUsedAt,
      }))
    : [];

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
      />
    </PageContainer>
  );
}
