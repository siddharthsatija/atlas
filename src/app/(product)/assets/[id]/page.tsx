import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  PageContainer,
  PageDescription,
  PageHeader,
  PageTitle,
} from "@/components/layout/page-layout";
import { ASSET_CATEGORIES } from "@/lib/assets/categories";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { AssetService } from "@/server/assets/asset-service";

/**
 * Minimal asset detail (ATL-032).
 *
 * **ATL-034 builds this surface properly** — identity header, overview,
 * information held, permissions, findings, requests, activity, and notes, per
 * frontend §7. What exists here is the destination ATL-032 needs: its criteria
 * are "success routes to the asset detail" and "identifier stored encrypted and
 * masked immediately", and neither can be true without a page to be true on.
 *
 * This follows the ATL-005 precedent, which created a placeholder route for
 * every navigation destination so the shell could be verified before the
 * surfaces existed. ATL-034 replaces this file wholesale.
 *
 * ## The identifier is masked on the server
 *
 * `maskValue` runs here, so the plaintext never enters the payload sent to the
 * browser — masking in a client component would mean shipping the value and
 * hiding it, which is not the same thing. Reveal is an explicit, audited action
 * owned by ATL-035; until then there is no way to see the full value on this
 * page, which is the correct default rather than a limitation.
 */

export const metadata: Metadata = { title: "Service" };

/** Reads a session and per-user data, so this route is dynamic by nature. */
export const dynamic = "force-dynamic";

const CATEGORY_LABELS = new Map(ASSET_CATEGORIES.map((entry) => [entry.id, entry.label]));

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireVerifiedUser();
  const { id } = await params;

  const result = await AssetService.create().getAsset(user.id, id);

  if (!result.ok) {
    /**
     * 404 for both "no such asset" and "not yours" — the service already makes
     * them indistinguishable, and ATL-034's criteria require a cross-user access
     * to answer 404 rather than leak existence through a 403.
     */
    if (result.code === "NOT_FOUND") notFound();
    throw new Error(`Could not load service: ${result.code}`);
  }

  const asset = result.data;

  /**
   * Masked by the service, on the server.
   *
   * `readMaskedAccountIdentifier` never returns plaintext, so the full value is
   * not serialised into the RSC payload and cannot be read from the page source
   * or the network response — which a client-side mask would allow, because
   * masking in the browser means shipping the value and hiding it.
   */
  const masked = await AssetService.create().readMaskedAccountIdentifier(user.id, id);

  return (
    <PageContainer>
      <PageHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <PageTitle>{asset.serviceName}</PageTitle>
            {asset.serviceDomain && <PageDescription>{asset.serviceDomain}</PageDescription>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="tertiary" asChild>
              <Link href="/assets">Back to services</Link>
            </Button>
            <Button asChild>
              <Link href={`/assets/${asset.id}/edit`}>Edit</Link>
            </Button>
          </div>
        </div>
      </PageHeader>

      <div className="flex flex-col gap-6 pb-16">
        <Card>
          <CardHeader>
            <h2 className="text-body font-medium text-text-primary">Overview</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={asset.status === "archived" ? "archived" : "active"} />
              <Badge tone="neutral">{CATEGORY_LABELS.get(asset.category) ?? asset.category}</Badge>
              {asset.sourceType === "demo" && <Badge tone="accent">Demo</Badge>}
            </div>

            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-body-sm text-text-muted">Account identifier</dt>
                <dd className="text-body-sm text-text-primary">
                  {masked.ok ? (masked.data ?? "Not recorded") : "Not recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-body-sm text-text-muted">Last reviewed</dt>
                <dd className="text-body-sm text-text-primary">
                  {asset.lastVerifiedAt ? asset.lastVerifiedAt.slice(0, 10) : "Never"}
                </dd>
              </div>
            </dl>

            {asset.notes && (
              <div>
                <h3 className="text-body-sm text-text-muted">Notes</h3>
                <p className="text-body-sm whitespace-pre-wrap text-text-primary">{asset.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-body-sm text-text-muted">
          What this service stores, what it is allowed to do, and its related findings appear here
          once those sections are built.
        </p>
      </div>
    </PageContainer>
  );
}
