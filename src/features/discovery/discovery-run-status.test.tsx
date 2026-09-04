import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DiscoveryRunStatusBadge,
  DiscoveryRunStatusRow,
  DiscoveryRunStatusPanel,
} from "./discovery-run-status";
import type { DiscoveryRunStatus } from "./discovery-view";

/**
 * discovery-run-status.tsx (ATL-210).
 *
 * Pure display components for the six discovery run states.
 */

const ALL_STATUSES: DiscoveryRunStatus[] = [
  "running",
  "completed_candidates",
  "completed_zero",
  "partial",
  "blocked",
  "failed",
];

describe("DiscoveryRunStatusBadge", () => {
  it.each(ALL_STATUSES)("renders a status badge for '%s'", (status) => {
    render(<DiscoveryRunStatusBadge status={status} />);

    const badge = screen.getByRole("status");
    expect(badge).toBeTruthy();
    expect(badge).toHaveAttribute("data-status", status);
  });

  it.each(ALL_STATUSES)("badge for '%s' has role=status", (status) => {
    render(<DiscoveryRunStatusBadge status={status} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("does not show description by default", () => {
    render(<DiscoveryRunStatusBadge status="completed_candidates" />);
    expect(screen.queryByText(/Candidates were found/i)).toBeNull();
  });

  it("shows description when showDescription=true (completed_candidates)", () => {
    render(<DiscoveryRunStatusBadge status="completed_candidates" showDescription />);
    expect(screen.getByText(/Candidates were found/i)).toBeTruthy();
  });

  it("shows description when showDescription=true (completed_zero)", () => {
    render(<DiscoveryRunStatusBadge status="completed_zero" showDescription />);
    expect(screen.getByText(/No candidates were found/i)).toBeTruthy();
  });

  it("completed_candidates and completed_zero render different labels", () => {
    const { unmount } = render(<DiscoveryRunStatusBadge status="completed_candidates" />);
    const withCandidates = screen.getByRole("status").textContent;
    unmount();

    render(<DiscoveryRunStatusBadge status="completed_zero" />);
    const withZero = screen.getByRole("status").textContent;

    expect(withCandidates).not.toBe(withZero);
  });

  it("renders the Running label for running state", () => {
    render(<DiscoveryRunStatusBadge status="running" />);
    expect(screen.getByRole("status").textContent).toContain("Running");
  });

  it("renders the Failed label for failed state", () => {
    render(<DiscoveryRunStatusBadge status="failed" />);
    expect(screen.getByRole("status").textContent).toContain("Failed");
  });
});

describe("DiscoveryRunStatusRow", () => {
  const CREATED = "2024-03-15T10:00:00Z";
  const COMPLETED = "2024-03-15T10:05:00Z";

  it("renders without crashing for all statuses", () => {
    for (const status of ALL_STATUSES) {
      expect(() =>
        render(<DiscoveryRunStatusRow status={status} createdAt={CREATED} />),
      ).not.toThrow();
    }
  });

  it("renders the created timestamp", () => {
    render(<DiscoveryRunStatusRow status="completed_candidates" createdAt={CREATED} />);
    expect(screen.getByText(/started/i)).toBeInTheDocument();
  });

  it("renders completed timestamp when provided", () => {
    render(
      <DiscoveryRunStatusRow
        status="completed_candidates"
        createdAt={CREATED}
        completedAt={COMPLETED}
      />,
    );
    expect(screen.getByText(/finished/i)).toBeInTheDocument();
  });

  it("does not render completed timestamp when absent", () => {
    render(<DiscoveryRunStatusRow status="running" createdAt={CREATED} />);
    expect(screen.queryByText(/finished/i)).not.toBeInTheDocument();
  });

  it("renders invocation count when provided", () => {
    render(
      <DiscoveryRunStatusRow
        status="completed_candidates"
        createdAt={CREATED}
        invocationCount={3}
      />,
    );
    expect(screen.getByText(/3 providers/i)).toBeTruthy();
  });

  it("uses singular 'provider' for invocationCount=1", () => {
    render(
      <DiscoveryRunStatusRow status="completed_zero" createdAt={CREATED} invocationCount={1} />,
    );
    expect(screen.getByText(/1 provider$/i)).toBeTruthy();
  });
});

describe("DiscoveryRunStatusPanel", () => {
  it("renders a panel with the correct data-status", () => {
    render(<DiscoveryRunStatusPanel status="blocked" />);
    expect(screen.getByRole("status")).toHaveAttribute("data-status", "blocked");
  });

  it("renders description text for the given status (partial)", () => {
    render(<DiscoveryRunStatusPanel status="partial" />);
    expect(screen.getByText(/Some checks completed/i)).toBeTruthy();
  });

  it("renders description text for completed_candidates", () => {
    render(<DiscoveryRunStatusPanel status="completed_candidates" />);
    expect(screen.getByText(/Candidates were found/i)).toBeTruthy();
  });

  it("renders description text for completed_zero", () => {
    render(<DiscoveryRunStatusPanel status="completed_zero" />);
    expect(screen.getByText(/No candidates were found/i)).toBeTruthy();
  });

  it.each(ALL_STATUSES)("renders without error for status '%s'", (status) => {
    expect(() => render(<DiscoveryRunStatusPanel status={status} />)).not.toThrow();
  });
});
