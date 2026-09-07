import type { Metadata } from "next";
import Link from "next/link";
import {
  PageContainer,
  PageHeader,
  PageTitle,
  PageDescription,
} from "@/components/layout/page-layout";
import { requireVerifiedUser } from "@/server/auth/require-user";
import { DiscoveryCandidateRepository } from "@/server/repositories/discovery-candidate-repository";
import { DiscoveryRunsRepository } from "@/server/repositories/discovery-runs-repository";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { DiscoveryRunStatusPanel } from "@/features/discovery";

export const metadata: Metadata = { title: "Discover" };

/**
 * Discover product surface (ATL-212, PRD §12 position 2).
 *
 * Shows:
 * - Current / latest discovery run status via `DiscoveryRunStatusPanel`.
 * - Count of pending candidates awaiting adjudication (drives the nav badge too).
 * - Entry point to Identity Profile (to adjust which fields drive discovery).
 * - Entry point to consent / settings (to manage discovery consent per provider).
 *
 * ## Security
 *
 * All queries are scoped to the verified session user. No plaintext identity
 * values are surfaced here. No client-supplied user IDs.
 *
 * ## No automatic polling (ATL-212 MVP)
 *
 * Run status is fetched at page render time. The user refreshes or navigates
 * back to see an updated status. Automatic polling is deferred beyond MVP.
 *
 * ## Revalidation
 *
 * Adjudication Server Actions (confirm, reject, dismiss, notSure) call
 * `revalidatePath("/discover")` so the pending count and run status reflect the
 * latest state without a manual full-page reload.
 */
export default async function DiscoverPage() {
  const user = await requireVerifiedUser();
  const db = createServiceRoleClient();

  // Parallel fetch: run status and pending count are independent.
  const [latestRun, pendingCount] = await Promise.all([
    new DiscoveryRunsRepository(db).getLatestRunForUser(user.id).catch(() => null),
    new DiscoveryCandidateRepository(db).countPending(user.id).catch(() => 0),
  ]);

  return (
    <PageContainer>
      <PageHeader>
        <PageTitle>Discover</PageTitle>
        <PageDescription>
          Review your discovery results and manage pending candidates.
        </PageDescription>
      </PageHeader>

      {/* ── Run status ─────────────────────────────────────────────────── */}
      {latestRun !== null ? (
        <section aria-labelledby="run-status-heading" className="mt-6">
          <h2
            id="run-status-heading"
            className="mb-3 text-label font-medium tracking-wide text-text-secondary uppercase"
          >
            Latest scan
          </h2>
          <DiscoveryRunStatusPanel status={latestRun.status} />
        </section>
      ) : (
        <section className="mt-6">
          <div
            data-slot="no-run-panel"
            className="rounded-card border border-border-default bg-surface p-4 text-body-sm text-text-secondary"
          >
            No discovery scan has run yet. Complete your Identity Profile to start one.
          </div>
        </section>
      )}

      {/* ── Pending candidates ─────────────────────────────────────────── */}
      {pendingCount > 0 && (
        <section aria-labelledby="pending-heading" className="mt-6">
          <h2
            id="pending-heading"
            className="mb-3 text-label font-medium tracking-wide text-text-secondary uppercase"
          >
            Pending candidates
          </h2>
          <div className="rounded-card border border-border-default bg-surface p-4">
            <p className="text-body-sm text-text-primary">
              You have <strong data-slot="pending-count">{pendingCount}</strong>{" "}
              {pendingCount === 1 ? "candidate" : "candidates"} waiting for your review.
            </p>
            <p className="mt-1 text-body-sm text-text-secondary">
              Review candidates during onboarding or revisit them here.
            </p>
          </div>
        </section>
      )}

      {pendingCount === 0 && latestRun !== null && (
        <section className="mt-6">
          <div className="rounded-card border border-border-default bg-surface p-4 text-body-sm text-text-secondary">
            No pending candidates. All results have been reviewed.
          </div>
        </section>
      )}

      {/* ── Entry points ───────────────────────────────────────────────── */}
      <section aria-labelledby="manage-heading" className="mt-8">
        <h2
          id="manage-heading"
          className="mb-3 text-label font-medium tracking-wide text-text-secondary uppercase"
        >
          Manage
        </h2>
        <ul className="flex flex-col gap-3">
          <li>
            <Link
              href="/settings"
              className="flex items-center justify-between rounded-card border border-border-default bg-surface p-4 text-body-sm font-medium text-text-primary transition-colors hover:bg-surface-subtle"
            >
              Identity Profile
              <span aria-hidden="true" className="text-text-muted">
                →
              </span>
            </Link>
          </li>
          <li>
            <Link
              href="/settings"
              className="flex items-center justify-between rounded-card border border-border-default bg-surface p-4 text-body-sm font-medium text-text-primary transition-colors hover:bg-surface-subtle"
            >
              Discovery consent &amp; settings
              <span aria-hidden="true" className="text-text-muted">
                →
              </span>
            </Link>
          </li>
        </ul>
      </section>
    </PageContainer>
  );
}
