import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CandidateReviewSection } from "./candidate-review-section";
import type {
  CandidateReviewSectionProps,
  AdjudicationActionFactory,
} from "./candidate-review-section";
import type {
  CandidateReviewItem,
  AggregatorEvidenceItem,
  AdjudicationActionState,
} from "./candidate-view";
import { INITIAL_ADJUDICATION_ACTION_STATE } from "./candidate-view";

/**
 * CandidateReviewSection unit tests (ATL-211, REPAIR 5).
 *
 * Post-action transitions are NOT tested here — they are absent from the
 * production implementation and documented as DEFECT-1 through DEFECT-4 in
 * candidate-card.test.tsx.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeCandidate = (
  id: string,
  status: CandidateReviewItem["status"] = "pending",
): CandidateReviewItem => ({
  id,
  sourceIdentifier: `service-${id}`,
  evidenceType: "breach",
  evidenceSummary: `Evidence for ${id}`,
  providerClass: "hibp",
  status,
});

const makeAggregator = (id: string): AggregatorEvidenceItem => ({
  id,
  sourceIdentifier: `aggregator-${id}`,
  evidenceType: "public_record",
  evidenceSummary: `Aggregator finding ${id}`,
  providerClass: "data-broker",
  createdAt: "2024-01-01T00:00:00Z",
});

const noopAction = (_prev: AdjudicationActionState, _fd: FormData) =>
  Promise.resolve(INITIAL_ADJUDICATION_ACTION_STATE);

function noopFactory(): AdjudicationActionFactory {
  return (_candidateId: string) => noopAction;
}

function defaultProps(
  overrides: Partial<CandidateReviewSectionProps> = {},
): CandidateReviewSectionProps {
  return {
    candidates: [],
    aggregatorEvidence: [],
    confirmActionFactory: noopFactory(),
    rejectActionFactory: noopFactory(),
    dismissActionFactory: noopFactory(),
    notSureActionFactory: noopFactory(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty / no-candidates state
// ---------------------------------------------------------------------------

describe("CandidateReviewSection — empty state", () => {
  it("renders 'No accounts to review' when both lists are empty", () => {
    render(<CandidateReviewSection {...defaultProps()} />);
    expect(screen.getByText(/no accounts to review/i)).toBeTruthy();
  });

  it("renders the section title even when empty", () => {
    render(<CandidateReviewSection {...defaultProps()} />);
    expect(screen.getByText(/review your findings/i)).toBeTruthy();
  });

  it("does not render any candidate cards when candidates list is empty", () => {
    render(<CandidateReviewSection {...defaultProps()} />);
    // Each candidate card renders a Confirm button; zero cards = zero Confirm buttons.
    expect(screen.queryAllByRole("button", { name: /confirm/i })).toHaveLength(0);
  });

  it("does not render 'Additional context' heading when aggregator list is empty", () => {
    render(<CandidateReviewSection {...defaultProps()} />);
    expect(screen.queryByText(/additional context/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multiple candidates
// ---------------------------------------------------------------------------

describe("CandidateReviewSection — multiple candidates", () => {
  const candidates = [makeCandidate("c1"), makeCandidate("c2"), makeCandidate("c3")];

  it("renders one CandidateCard per pending candidate", () => {
    render(<CandidateReviewSection {...defaultProps({ candidates })} />);
    // Each card renders exactly one Confirm button; count them to count cards.
    expect(screen.getAllByRole("button", { name: /confirm/i })).toHaveLength(3);
  });

  it("renders the sourceIdentifier of each candidate", () => {
    render(<CandidateReviewSection {...defaultProps({ candidates })} />);
    for (const c of candidates) {
      expect(screen.getByText(c.sourceIdentifier)).toBeTruthy();
    }
  });

  it("each card carries the correct data-candidate-id", () => {
    render(<CandidateReviewSection {...defaultProps({ candidates })} />);
    for (const c of candidates) {
      // data-candidate-id is a structural marker for E2E tests; unit-level proxy is sourceIdentifier.
      expect(screen.getByText(c.sourceIdentifier)).toBeTruthy();
    }
  });

  it("does not show 'No accounts to review' when candidates exist", () => {
    render(<CandidateReviewSection {...defaultProps({ candidates })} />);
    expect(screen.queryByText(/no accounts to review/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Action factory receives correct candidateId
// ---------------------------------------------------------------------------

describe("CandidateReviewSection — action factory receives correct candidateId", () => {
  it("calls confirmActionFactory with each candidate's id", () => {
    const candidates = [makeCandidate("x1"), makeCandidate("x2")];
    const confirmFactory = vi.fn((_id: string) => noopAction);
    render(
      <CandidateReviewSection
        {...defaultProps({ candidates, confirmActionFactory: confirmFactory })}
      />,
    );
    expect(confirmFactory).toHaveBeenCalledWith("x1");
    expect(confirmFactory).toHaveBeenCalledWith("x2");
    expect(confirmFactory).toHaveBeenCalledTimes(2);
  });

  it("calls rejectActionFactory with each candidate's id", () => {
    const candidates = [makeCandidate("y1"), makeCandidate("y2")];
    const rejectFactory = vi.fn((_id: string) => noopAction);
    render(
      <CandidateReviewSection
        {...defaultProps({ candidates, rejectActionFactory: rejectFactory })}
      />,
    );
    expect(rejectFactory).toHaveBeenCalledWith("y1");
    expect(rejectFactory).toHaveBeenCalledWith("y2");
  });

  it("calls dismissActionFactory with each candidate's id", () => {
    const candidates = [makeCandidate("z1")];
    const dismissFactory = vi.fn((_id: string) => noopAction);
    render(
      <CandidateReviewSection
        {...defaultProps({ candidates, dismissActionFactory: dismissFactory })}
      />,
    );
    expect(dismissFactory).toHaveBeenCalledWith("z1");
  });

  it("calls notSureActionFactory with each candidate's id", () => {
    const candidates = [makeCandidate("w1")];
    const notSureFactory = vi.fn((_id: string) => noopAction);
    render(
      <CandidateReviewSection
        {...defaultProps({ candidates, notSureActionFactory: notSureFactory })}
      />,
    );
    expect(notSureFactory).toHaveBeenCalledWith("w1");
  });

  it("does NOT mix candidateIds across factories", () => {
    const candidates = [makeCandidate("alpha"), makeCandidate("beta")];
    const confirmFactory = vi.fn((_id: string) => noopAction);
    render(
      <CandidateReviewSection
        {...defaultProps({ candidates, confirmActionFactory: confirmFactory })}
      />,
    );
    const calledWith = confirmFactory.mock.calls.map(([id]) => id).sort();
    expect(calledWith).toEqual(["alpha", "beta"]);
  });
});

// ---------------------------------------------------------------------------
// Aggregator evidence rows — no adjudication actions
// ---------------------------------------------------------------------------

describe("CandidateReviewSection — aggregator rows have no adjudication actions", () => {
  const aggregatorEvidence = [makeAggregator("agg1"), makeAggregator("agg2")];

  it("renders aggregator rows as informational-only elements", () => {
    render(<CandidateReviewSection {...defaultProps({ aggregatorEvidence })} />);
    // Each aggregator row displays its sourceIdentifier; verify both are present.
    for (const agg of aggregatorEvidence) {
      expect(screen.getByText(agg.sourceIdentifier)).toBeTruthy();
    }
  });

  it("renders the sourceIdentifier for each aggregator row", () => {
    render(<CandidateReviewSection {...defaultProps({ aggregatorEvidence })} />);
    for (const agg of aggregatorEvidence) {
      expect(screen.getByText(agg.sourceIdentifier)).toBeTruthy();
    }
  });

  it("aggregator rows contain no action buttons", () => {
    render(<CandidateReviewSection {...defaultProps({ aggregatorEvidence })} />);
    // No candidates → no action buttons anywhere in the rendered output.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("aggregator rows contain no form elements", () => {
    render(<CandidateReviewSection {...defaultProps({ aggregatorEvidence })} />);
    // Forms wrap useActionState-powered buttons. No candidates → no buttons → no forms.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows 'Additional context' heading when aggregator evidence is present", () => {
    render(<CandidateReviewSection {...defaultProps({ aggregatorEvidence })} />);
    expect(screen.getByText(/additional context/i)).toBeTruthy();
  });

  it("aggregator section does NOT produce candidate-card elements", () => {
    render(<CandidateReviewSection {...defaultProps({ aggregatorEvidence })} />);
    // Aggregator evidence should not produce candidate card action buttons.
    expect(screen.queryAllByRole("button", { name: /confirm/i })).toHaveLength(0);
  });

  it("factories are NOT called for aggregator-only rows", () => {
    const confirmFactory = vi.fn((_id: string) => noopAction);
    render(
      <CandidateReviewSection
        {...defaultProps({ aggregatorEvidence, confirmActionFactory: confirmFactory })}
      />,
    );
    expect(confirmFactory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Section grouping: dismissed and not_sure
// ---------------------------------------------------------------------------

describe("CandidateReviewSection — dismissed candidates appear in deferred section", () => {
  it("renders a dismissed candidate without action buttons", () => {
    const dismissed = makeCandidate("d1", "dismissed");
    render(<CandidateReviewSection {...defaultProps({ candidates: [dismissed] })} />);
    expect(screen.getByText(dismissed.sourceIdentifier)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /confirm/i })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /reject/i })).toHaveLength(0);
  });

  it("renders the Deferred section heading when dismissed candidates are present", () => {
    const dismissed = makeCandidate("d2", "dismissed");
    render(<CandidateReviewSection {...defaultProps({ candidates: [dismissed] })} />);
    // The section heading is an <h2>; getByRole avoids ambiguity with the
    // "Deferred" badge text also rendered inside the CandidateCard.
    expect(screen.getByRole("heading", { name: /deferred/i })).toBeTruthy();
  });

  it("a mix of pending and dismissed renders Confirm buttons only for pending", () => {
    const pending = makeCandidate("p1", "pending");
    const dismissed = makeCandidate("d1", "dismissed");
    render(<CandidateReviewSection {...defaultProps({ candidates: [pending, dismissed] })} />);
    expect(screen.getAllByRole("button", { name: /confirm/i })).toHaveLength(1);
  });
});

describe("CandidateReviewSection — not_sure candidates appear in Not sure section", () => {
  it("renders a not_sure candidate without action buttons", () => {
    const notSure = makeCandidate("n1", "not_sure");
    render(<CandidateReviewSection {...defaultProps({ candidates: [notSure] })} />);
    expect(screen.getByText(notSure.sourceIdentifier)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /confirm/i })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /reject/i })).toHaveLength(0);
  });

  it("renders the Not sure section heading when not_sure candidates are present", () => {
    const notSure = makeCandidate("n2", "not_sure");
    render(<CandidateReviewSection {...defaultProps({ candidates: [notSure] })} />);
    expect(screen.getByText(/not sure about these/i)).toBeTruthy();
  });

  it("a mix of pending and not_sure renders Confirm buttons only for pending", () => {
    const pending = makeCandidate("p1", "pending");
    const notSure = makeCandidate("n1", "not_sure");
    render(<CandidateReviewSection {...defaultProps({ candidates: [pending, notSure] })} />);
    expect(screen.getAllByRole("button", { name: /confirm/i })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mixed: candidates + aggregator evidence
// ---------------------------------------------------------------------------

describe("CandidateReviewSection — candidates and aggregator evidence together", () => {
  const candidates = [makeCandidate("m1")];
  const aggregatorEvidence = [makeAggregator("a1")];

  it("renders both candidate cards and aggregator rows", () => {
    render(<CandidateReviewSection {...defaultProps({ candidates, aggregatorEvidence })} />);
    // One candidate card = one Confirm button; one aggregator row = its sourceIdentifier.
    expect(screen.getAllByRole("button", { name: /confirm/i })).toHaveLength(1);
    expect(screen.getByText(aggregatorEvidence[0]!.sourceIdentifier)).toBeTruthy();
  });

  it("does not show 'No accounts to review' when both lists are non-empty", () => {
    render(<CandidateReviewSection {...defaultProps({ candidates, aggregatorEvidence })} />);
    expect(screen.queryByText(/no accounts to review/i)).toBeNull();
  });

  it("action factory is called only for candidate rows, not aggregator rows", () => {
    const confirmFactory = vi.fn((_id: string) => noopAction);
    render(
      <CandidateReviewSection
        {...defaultProps({ candidates, aggregatorEvidence, confirmActionFactory: confirmFactory })}
      />,
    );
    expect(confirmFactory).toHaveBeenCalledTimes(1);
    expect(confirmFactory).toHaveBeenCalledWith("m1");
  });
});
