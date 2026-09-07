import type { Metadata } from "next";
import Link from "next/link";
import {
  PageContainer,
  PageHeader,
  PageTitle,
  PageDescription,
} from "@/components/layout/page-layout";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { DiscoveryRunsRepository } from "@/server/repositories/discovery-runs-repository";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { DiscoveryRunStatusBadge } from "@/features/discovery";

export const metadata: Metadata = { title: "Overview" };

/**
 * Overview (Dashboard) page (ATL-005, ATL-212).
 *
 * ATL-212 adds a run-in-progress indicator: when the latest discovery run is
 * in `running` state, a small banner linking to the Discover surface is shown
 * at the top of the page. No other run statuses display here — the Discover
 * surface carries the full run-status display.
 *
 * The full dashboard (metrics, assets preview, findings) is built by
 * ATL-019 – ATL-026. This page adds only what ATL-212 specifies.
 */
export default async function OverviewPage() {
  const user = await requireVerifiedUser();

  // Fetch latest run status non-fatally: a failure shows no indicator rather
  // than crashing the dashboard.
  const latestRun = await new DiscoveryRunsRepository(createServiceRoleClient())
    .getLatestRunForUser(user.id)
    .catch(() => null);

  const isRunning = latestRun?.status === "running";

  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Overview</PageTitle>
        <PageDescription>Your privacy dashboard.</PageDescription>
      </PageHeader>

      {/* ATL-212: run-in-progress indicator — shown only when a run is active. */}
      {isRunning && (
        <div
          data-slot="run-in-progress-indicator"
          className="mt-4 flex items-center gap-3 rounded-card border border-border-default bg-surface px-4 py-3"
        >
          <DiscoveryRunStatusBadge status="running" />
          <p className="grow text-body-sm text-text-primary">A discovery scan is in progress.</p>
          <Link
            href="/discover"
            className="shrink-0 text-body-sm font-medium text-accent hover:underline"
          >
            View in Discover
          </Link>
        </div>
      )}
    </PageContainer>
  );
}
