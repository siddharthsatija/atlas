"use client";

/**
 * Discovery run-status display components (ATL-210 §3).
 *
 * Renders the six possible states of a discovery run. These are pure display
 * components — they accept status as a prop. ATL-212 (the Discover surface)
 * will supply live status from the database; ATL-210 ships the components
 * ready for that integration.
 */

import type { DiscoveryRunStatus } from "./discovery-view";

// ---- Status metadata --------------------------------------------------------

interface StatusConfig {
  label: string;
  description: string;
  /** Tailwind classes for the badge background and text. */
  className: string;
  /** Unicode symbol rendered alongside the label (aria-hidden). */
  symbol: string;
}

const STATUS_CONFIG: Record<DiscoveryRunStatus, StatusConfig> = {
  running: {
    label: "Running",
    description: "Discovery is in progress.",
    className: "bg-accent-subtle text-accent border border-accent/30",
    symbol: "◐",
  },
  completed_candidates: {
    label: "Completed",
    description: "Discovery completed. Candidates were found for review.",
    className: "bg-success-subtle text-success border border-success/30",
    symbol: "●",
  },
  completed_zero: {
    label: "No matches",
    description: "Discovery completed. No candidates were found.",
    className: "bg-surface-subtle text-text-secondary border border-border-default",
    symbol: "○",
  },
  partial: {
    label: "Partial",
    description: "Some checks completed; others failed or were blocked.",
    className: "bg-warning-subtle text-warning border border-warning/30",
    symbol: "◑",
  },
  blocked: {
    label: "Blocked",
    description: "One or more checks were blocked before they could run.",
    className: "bg-warning-subtle text-warning border border-warning/30",
    symbol: "⊘",
  },
  failed: {
    label: "Failed",
    description: "Discovery could not complete.",
    className: "bg-danger-subtle text-danger border border-danger/30",
    symbol: "✕",
  },
};

// ---- Components -------------------------------------------------------------

export interface DiscoveryRunStatusBadgeProps {
  status: DiscoveryRunStatus;
  showDescription?: boolean;
}

export function DiscoveryRunStatusBadge({
  status,
  showDescription = false,
}: DiscoveryRunStatusBadgeProps) {
  const config = STATUS_CONFIG[status];

  return (
    <span
      data-slot="discovery-run-status-badge"
      data-status={status}
      className="inline-flex flex-col gap-0.5"
    >
      <span
        role="status"
        data-status={status}
        className={`text-label-sm inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium ${config.className}`}
      >
        <span aria-hidden="true">{config.symbol}</span>
        {config.label}
      </span>

      {showDescription && (
        <span className="text-body-sm text-text-secondary">{config.description}</span>
      )}
    </span>
  );
}

export interface DiscoveryRunStatusRowProps {
  status: DiscoveryRunStatus;
  createdAt: string;
  completedAt?: string | null;
  invocationCount?: number;
}

export function DiscoveryRunStatusRow({
  status,
  createdAt,
  completedAt,
  invocationCount,
}: DiscoveryRunStatusRowProps) {
  const created = new Date(createdAt);
  const completed = completedAt ? new Date(completedAt) : null;

  return (
    <div
      data-slot="discovery-run-status-row"
      className="flex items-center justify-between gap-3 py-2"
    >
      <DiscoveryRunStatusBadge status={status} />

      <div className="flex items-center gap-4 text-body-sm text-text-secondary">
        {invocationCount !== undefined && (
          <span>
            {invocationCount} {invocationCount === 1 ? "provider" : "providers"}
          </span>
        )}
        <span>
          Started{" "}
          <time dateTime={createdAt}>
            {created.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </time>
        </span>
        {completed && (
          <span>
            Finished{" "}
            <time dateTime={completed.toISOString()}>
              {completed.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </time>
          </span>
        )}
      </div>
    </div>
  );
}

export function DiscoveryRunStatusPanel({ status }: { status: DiscoveryRunStatus }) {
  const config = STATUS_CONFIG[status];

  return (
    <div
      data-slot="discovery-run-status-panel"
      data-status={status}
      className="rounded-card border border-border-default bg-surface p-4"
    >
      <div className="flex items-center gap-3">
        <DiscoveryRunStatusBadge status={status} />
      </div>
      <p className="mt-2 text-body-sm text-text-secondary">{config.description}</p>
    </div>
  );
}
