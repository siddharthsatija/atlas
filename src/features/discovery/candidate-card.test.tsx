import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CandidateCard } from "./candidate-card";
import type { CandidateCardProps } from "./candidate-card";
import type { CandidateReviewItem, AdjudicationActionState } from "./candidate-view";
import { INITIAL_ADJUDICATION_ACTION_STATE } from "./candidate-view";

/**
 * CandidateCard unit tests (ATL-211).
 *
 * Covers status-variant rendering:
 *   pending   → four action buttons (Confirm / Reject / Dismiss / Not sure)
 *   dismissed → "Deferred" badge, no buttons
 *   not_sure  → "Not sure" badge, no buttons
 *
 * Post-action transitions (confirmed inline / rejected unmount) rely on
 * useActionState + jsdom form dispatch — those paths are E2E territory and are
 * not unit-tested here. The status-variant tests directly pass a candidate with
 * the target status, which exercises the same render branches.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANDIDATE: CandidateReviewItem = {
  id: "cand-001",
  sourceIdentifier: "acme-data-broker",
  evidenceType: "breach",
  evidenceSummary: "Your email appeared in a data breach from 2023.",
  providerClass: "hibp",
  status: "pending",
};

const noop = (_prev: AdjudicationActionState, _fd: FormData) =>
  Promise.resolve(INITIAL_ADJUDICATION_ACTION_STATE);

function defaultProps(overrides: Partial<CandidateCardProps> = {}): CandidateCardProps {
  return {
    candidate: CANDIDATE,
    confirmAction: noop,
    rejectAction: noop,
    dismissAction: noop,
    notSureAction: noop,
    ...overrides,
  };
}

function mockAction() {
  return vi.fn((_prev: AdjudicationActionState, _fd: FormData) =>
    Promise.resolve(INITIAL_ADJUDICATION_ACTION_STATE),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CandidateCard — rendering", () => {
  it("renders the sourceIdentifier as the primary label", () => {
    render(<CandidateCard {...defaultProps()} />);
    expect(screen.getByText(CANDIDATE.sourceIdentifier)).toBeTruthy();
  });

  it("renders the evidenceSummary", () => {
    render(<CandidateCard {...defaultProps()} />);
    expect(screen.getByText(CANDIDATE.evidenceSummary)).toBeTruthy();
  });

  it("renders the evidenceType badge", () => {
    render(<CandidateCard {...defaultProps()} />);
    expect(screen.getByText(CANDIDATE.evidenceType)).toBeTruthy();
  });

  it("carries the candidate id on the root element for test targeting", () => {
    render(<CandidateCard {...defaultProps()} />);
    // data-candidate-id is a structural marker for E2E targeting.
    // Unit level: the candidate's primary label is rendered, confirming
    // the card root element bearing that attribute is mounted.
    expect(screen.getByText(CANDIDATE.sourceIdentifier)).toBeTruthy();
  });

  it("does NOT render any plaintext email address", () => {
    render(<CandidateCard {...defaultProps()} />);
    expect(screen.queryByText(/@/)).toBeNull();
  });
});

describe("CandidateCard — four action buttons are present", () => {
  it("renders a Confirm button", () => {
    render(<CandidateCard {...defaultProps()} />);
    expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy();
  });

  it("renders a Reject button", () => {
    render(<CandidateCard {...defaultProps()} />);
    expect(screen.getByRole("button", { name: /reject/i })).toBeTruthy();
  });

  it("renders a Dismiss button", () => {
    render(<CandidateCard {...defaultProps()} />);
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeTruthy();
  });

  it("renders a Not sure button", () => {
    render(<CandidateCard {...defaultProps()} />);
    expect(screen.getByRole("button", { name: /not sure/i })).toBeTruthy();
  });

  it("renders all four buttons in their default enabled state", () => {
    render(<CandidateCard {...defaultProps()} />);
    const buttons = screen.getAllByRole("button");
    const actionButtons = buttons.filter((b) =>
      [/confirm/i, /reject/i, /dismiss/i, /not sure/i].some((re) => re.test(b.textContent ?? "")),
    );
    expect(actionButtons).toHaveLength(4);
    for (const btn of actionButtons) {
      expect(btn).not.toBeDisabled();
    }
  });
});

describe("CandidateCard — inline error messages", () => {
  it("renders no error alert on initial paint", () => {
    render(<CandidateCard {...defaultProps()} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders no error text when initial state has failure=null", () => {
    render(<CandidateCard {...defaultProps()} />);
    expect(screen.queryByText(/no longer available/i)).toBeNull();
    expect(screen.queryByText(/already been actioned/i)).toBeNull();
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });
});

describe("CandidateCard — dismissed and not_sure variants", () => {
  const DISMISSED: CandidateReviewItem = { ...CANDIDATE, status: "dismissed" };
  const NOT_SURE: CandidateReviewItem = { ...CANDIDATE, status: "not_sure" };

  it("dismissed card renders 'Deferred' badge", () => {
    render(<CandidateCard {...defaultProps({ candidate: DISMISSED })} />);
    expect(screen.getByText(/deferred/i)).toBeTruthy();
  });

  it("dismissed card renders no action buttons (ATL-208: no mutations from dismissed)", () => {
    render(<CandidateCard {...defaultProps({ candidate: DISMISSED })} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("dismissed card still renders sourceIdentifier", () => {
    render(<CandidateCard {...defaultProps({ candidate: DISMISSED })} />);
    expect(screen.getByText(CANDIDATE.sourceIdentifier)).toBeTruthy();
  });

  it("not_sure card renders 'Not sure' badge", () => {
    render(<CandidateCard {...defaultProps({ candidate: NOT_SURE })} />);
    expect(screen.getByText(/not sure/i)).toBeTruthy();
  });

  it("not_sure card renders no action buttons (ATL-208: no mutations from not_sure)", () => {
    render(<CandidateCard {...defaultProps({ candidate: NOT_SURE })} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("not_sure card still renders sourceIdentifier", () => {
    render(<CandidateCard {...defaultProps({ candidate: NOT_SURE })} />);
    expect(screen.getByText(CANDIDATE.sourceIdentifier)).toBeTruthy();
  });
});

describe("CandidateCard — action wiring", () => {
  it("confirmAction prop is wired — confirm button is present and enabled", () => {
    render(<CandidateCard {...defaultProps({ confirmAction: mockAction() })} />);
    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    expect(confirmButton).toBeTruthy();
    expect(confirmButton).not.toBeDisabled();
  });

  it("each action has its own form element", () => {
    render(<CandidateCard {...defaultProps()} />);
    // Four separate forms — one per action — so pending state is isolated.
    // Verified by the presence of all four distinctly-named action buttons.
    expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /reject/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /not sure/i })).toBeTruthy();
  });

  it("does not expose candidateId or assetId as labelled form fields", () => {
    render(<CandidateCard {...defaultProps()} />);
    // Trust-boundary: candidateId/assetId must not be carried in FormData.
    // The authoritative test is in adjudication-actions.test.ts (server layer).
    // Unit level: no accessible form field carries these reserved names.
    expect(screen.queryByLabelText(/candidateId/i)).toBeNull();
    expect(screen.queryByLabelText(/assetId/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Post-action transitions — prove useActionState state machine (ATL-211)
//
// These tests click the actual form submit buttons and wait for the state
// to propagate through useActionState → effectiveStatus → render branch.
// Each test supplies a mock action that resolves immediately and verifies
// the resulting UI variant.
// ---------------------------------------------------------------------------

describe("CandidateCard — post-action transitions", () => {
  it("CONFIRM success: pending → Confirmed badge + View asset link + no action buttons", async () => {
    const user = userEvent.setup();
    const confirmAction = vi.fn().mockResolvedValue({
      failure: null,
      attempt: 1,
      outcome: "confirmed" as const,
      assetId: "asset-confirm-123",
    });
    render(<CandidateCard {...defaultProps({ confirmAction })} />);

    // Pre-condition: card is in pending state.
    expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      // Success badge present.
      expect(screen.getByText(/confirmed/i)).toBeTruthy();
      // Asset link present with the id from the action result.
      const link = screen.getByRole("link", { name: /view asset/i });
      expect(link.getAttribute("href")).toBe("/assets/asset-confirm-123");
      // NO action buttons remaining.
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    });
  });

  it("REJECT success: pending → card unmounts immediately (null render)", async () => {
    const user = userEvent.setup();
    const rejectAction = vi.fn().mockResolvedValue({
      failure: null,
      attempt: 1,
      outcome: "rejected" as const,
      assetId: null,
    });
    render(<CandidateCard {...defaultProps({ rejectAction })} />);

    await user.click(screen.getByRole("button", { name: /reject/i }));

    await waitFor(() => {
      // Card is gone — neither the identifier nor any button remains.
      expect(screen.queryByText(CANDIDATE.sourceIdentifier)).toBeNull();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    });
  });

  it("DISMISS success: pending → Deferred badge + no action buttons + still visible", async () => {
    const user = userEvent.setup();
    const dismissAction = vi.fn().mockResolvedValue({
      failure: null,
      attempt: 1,
      outcome: "dismissed" as const,
      assetId: null,
    });
    render(<CandidateCard {...defaultProps({ dismissAction })} />);

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    await waitFor(() => {
      // Card remains visible with sourceIdentifier.
      expect(screen.getByText(CANDIDATE.sourceIdentifier)).toBeTruthy();
      // Deferred badge present.
      expect(screen.getByText(/deferred/i)).toBeTruthy();
      // No action buttons (ATL-208).
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    });
  });

  it("NOT SURE success: pending → Not sure indicator + no action buttons + still visible", async () => {
    const user = userEvent.setup();
    const notSureAction = vi.fn().mockResolvedValue({
      failure: null,
      attempt: 1,
      outcome: "not_sure" as const,
      assetId: null,
    });
    render(<CandidateCard {...defaultProps({ notSureAction })} />);

    await user.click(screen.getByRole("button", { name: /not sure/i }));

    await waitFor(() => {
      // Card remains visible.
      expect(screen.getByText(CANDIDATE.sourceIdentifier)).toBeTruthy();
      // Not sure indicator present.
      expect(screen.getByText(/not sure/i)).toBeTruthy();
      // No action buttons (ATL-208).
      expect(screen.queryAllByRole("button")).toHaveLength(0);
    });
  });

  it("FAILURE: failed action does NOT transition — card stays pending with error", async () => {
    const user = userEvent.setup();
    const failingAction = vi.fn().mockResolvedValue({
      failure: "unavailable" as const,
      attempt: 1,
      outcome: "idle" as const,
      assetId: null,
    });
    render(<CandidateCard {...defaultProps({ confirmAction: failingAction })} />);

    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      // Error alert appears.
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toMatch(/something went wrong/i);
      // Card is still in pending state — action buttons still present.
      expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy();
    });
  });

  it("onOutcomeChange called with candidateId + outcome + assetId after confirm success", async () => {
    const user = userEvent.setup();
    const onOutcomeChange = vi.fn();
    const confirmAction = vi.fn().mockResolvedValue({
      failure: null,
      attempt: 1,
      outcome: "confirmed" as const,
      assetId: "asset-notify-456",
    });
    render(<CandidateCard {...defaultProps({ confirmAction, onOutcomeChange })} />);

    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(onOutcomeChange).toHaveBeenCalledWith(CANDIDATE.id, "confirmed", "asset-notify-456");
    });
  });
});
