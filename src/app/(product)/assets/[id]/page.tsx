import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  PageContainer,
  PageDescription,
  PageHeader,
  PageTitle,
} from "@/components/layout/page-layout";
import {
  AccountIdentifier,
  AssetDetailHeaderActions,
  AssetDetailSections,
} from "@/features/assets";
import { FindingAssistant } from "@/features/findings";
import { Card, CardContent } from "@/components/ui/card";
import { ASSET_ASSISTANT_COPY } from "@/lib/ai/assistant-copy";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { AssetService } from "@/server/assets/asset-service";
import { FindingService } from "@/server/findings/finding-service";
import { ActivityEventRepository } from "@/server/repositories/activity-event-repository";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { archiveAssetAction, restoreAssetAction, summarizeAssetAction } from "./actions";

/**
 * The asset detail page (ATL-034, frontend §7).
 *
 * Replaces the ATL-032 placeholder. Eight sections: an always-visible identity
 * header, then Overview through Notes as native `<details>` disclosures in §7
 * order — `AssetDetailSections` owns that order so it can be unit tested without
 * a session or a database.
 *
 * ## The ownership read runs first, alone, and deliberately not in parallel
 *
 * All five reads are independently scoped by `user_id`, so running them together
 * could not leak another user's records — each would simply return nothing. The
 * reason they are still ordered is different: if this page fanned out
 * immediately, **every guessed or foreign id would cost five database round
 * trips instead of one**. A 404 that is expensive to produce is a load
 * amplifier, and the ids are UUIDs in the URL.
 *
 * So `getAsset` resolves ownership and answers `notFound()` on its own, exactly
 * as the placeholder did. Only once the asset is known to be this user's do the
 * remaining four run together — they are mutually independent, none of them
 * feeds another, and none has a side effect:
 *
 *   - `readMaskedAccountIdentifier` reads and masks. It writes nothing. The
 *     audited path is `revealAccountIdentifier`, which this page never calls.
 *   - `listAssetDetails`, `listFindingsForAsset` and `forEntity` are reads.
 *
 * Had any of them written an audit or activity row, parallelising would mean a
 * probe could provoke a write, and the whole set would have stayed sequential.
 *
 * ## Masking is unchanged from ATL-035
 *
 * `readMaskedAccountIdentifier` runs here, on the server, and returns a masked
 * string. The plaintext never enters the RSC payload, so it cannot be read from
 * page source or the network response — which a client-side mask would allow,
 * because masking in the browser means shipping the value and hiding it.
 *
 * No reveal logic lives here. `AccountIdentifier` receives the masked string and
 * the asset id, and the audited reveal stays in ATL-035's own action.
 *
 * ## 404, never 403
 *
 * `NOT_FOUND` covers both "no such asset" and "not yours", because the service
 * already makes them indistinguishable. A 403 on a record you do not own
 * confirms that the id names something real.
 */

export const metadata: Metadata = { title: "Service" };

/** Reads a session and per-user data, so this route is dynamic by nature. */
export const dynamic = "force-dynamic";

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireVerifiedUser();
  const { id } = await params;

  const assets = AssetService.create();

  /** The ownership gate. Nothing else runs until this succeeds — see above. */
  const result = await assets.getAsset(user.id, id);

  if (!result.ok) {
    if (result.code === "NOT_FOUND") notFound();
    throw new Error(`Could not load service: ${result.code}`);
  }

  const asset = result.data;

  const [masked, details, findings, events] = await Promise.all([
    assets.readMaskedAccountIdentifier(user.id, id),
    assets.listAssetDetails(user.id, id),
    /** Open and in-progress only, by construction (ATL-034 M1). */
    FindingService.create().listFindingsForAsset(user.id, id),
    new ActivityEventRepository(createServiceRoleClient()).forEntity(user.id, "asset", id),
  ]);

  /**
   * Child records only. `listAssetDetails` also returns the asset row, but the
   * one from `getAsset` is used for display so there is a single source of truth
   * for the asset's own fields — and so the two can never disagree if one read
   * lands either side of a concurrent edit.
   */
  const categories = details.ok ? details.data.dataCategories : [];
  const permissions = details.ok ? details.data.permissions : [];

  return (
    <PageContainer>
      <PageHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <PageTitle>{asset.serviceName}</PageTitle>
            {asset.serviceDomain && <PageDescription>{asset.serviceDomain}</PageDescription>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="tertiary" asChild>
              <Link href="/assets">Back to services</Link>
            </Button>
            {/*
              The status comes from the row this page already read, so the
              header's Archive/Restore choice and the Overview section's status
              badge cannot disagree — there is one source, and it is the
              database.
            */}
            <AssetDetailHeaderActions
              assetId={asset.id}
              serviceName={asset.serviceName}
              status={asset.status}
              archive={archiveAssetAction}
              restore={restoreAssetAction}
            />
          </div>
        </div>
      </PageHeader>

      <div className="flex flex-col gap-6 pb-16">
        <AssetDetailSections
          asset={asset}
          categories={categories}
          permissions={permissions}
          findings={findings.ok ? findings.data : []}
          events={events}
          {...(masked.ok && masked.data
            ? {
                accountIdentifier: (
                  /*
                    Masked here, revealable only by asking (ATL-035). The
                    component receives the masked string and the asset id — never
                    the value — so the plaintext is not in this payload, this
                    HTML, or the DOM until the user acts.
                  */
                  <AccountIdentifier masked={masked.data} assetId={asset.id} />
                ),
              }
            : {})}
        />

        {/*
          ATL-054's asset-context assistant, unchanged: same subject id, same
          title, same action, same asset-specific copy.

          Still last, below the user's own records. AI is contextual and must not
          overpower the user's data (UI rules) — the facts above are what the
          page is for, and the summary is something the user may ask for after
          reading them.
        */}
        <Card>
          <CardContent>
            <FindingAssistant
              subjectId={asset.id}
              title={asset.serviceName}
              request={summarizeAssetAction}
              copy={ASSET_ASSISTANT_COPY}
            />
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
