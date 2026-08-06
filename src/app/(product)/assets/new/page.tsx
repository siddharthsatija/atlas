import type { Metadata } from "next";
import {
  PageContainer,
  PageDescription,
  PageHeader,
  PageTitle,
} from "@/components/layout/page-layout";
import { AssetCreateForm } from "@/features/assets";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { createAssetAction } from "../actions";
import { INITIAL_CREATE_ASSET_STATE } from "../form-state";

/**
 * Add a service (ATL-032).
 *
 * A Server Component that verifies the session and injects the Server Action.
 * The action is passed as a prop rather than imported by the client component,
 * keeping the layer boundary intact — `src/features` may not import `src/server`
 * — and letting the form be tested with a plain spy.
 */

export const metadata: Metadata = { title: "Add a service" };

/** Reads the session, so this route is dynamic by nature. */
export const dynamic = "force-dynamic";

export default async function NewAssetPage() {
  // First statement, as in every other product route: nothing below runs for an
  // unauthenticated caller, and no protected markup is produced to flash.
  await requireVerifiedUser();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Add a service</PageTitle>
        <PageDescription>
          Record an account you hold. You can add what it stores about you and what it is allowed to
          do once it is saved.
        </PageDescription>
      </PageHeader>

      <div className="pb-16">
        <AssetCreateForm action={createAssetAction} initialState={INITIAL_CREATE_ASSET_STATE} />
      </div>
    </PageContainer>
  );
}
