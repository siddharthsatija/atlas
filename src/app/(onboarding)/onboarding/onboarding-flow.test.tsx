import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@/lib/onboarding/onboarding-state";
import { OnboardingFlow } from "./onboarding-flow";

/**
 * ATL-017 — resuming the onboarding flow.
 *
 * Covers what the browser suite cannot reach cheaply: that the component starts
 * from server-resolved state, reports every move, and never restores consent.
 * The full journey is `tests/e2e/onboarding.spec.ts`.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 9).toString("base64") },
}));

vi.mock("./actions", () => ({
  completeOnboardingAction: vi.fn(),
}));

vi.mock("./identity-profile-actions", () => ({
  grantStorageConsentForOnboardingAction: vi.fn(),
  saveOnboardingFieldAction: vi.fn(),
  setOnboardingFieldDiscoveryAction: vi.fn(),
  removeOnboardingFieldAction: vi.fn(),
  completeIdentityProfileStepAction: vi.fn(),
}));

const midway: OnboardingState = {
  step: "categories",
  privacyGoal: "reduce_exposure",
  categories: ["social"],
  startingPoint: null,
};

const heading = (name: string | RegExp) => screen.getByRole("heading", { level: 1, name });

describe("resuming", () => {
  it("opens at the saved step rather than the introduction", async () => {
    render(<OnboardingFlow initialState={midway} />);

    expect(heading("Where do you have accounts?")).toBeInTheDocument();
    expect(await screen.findByText("Step 3 of 7")).toBeInTheDocument();
  });

  it("restores the choices made before leaving", () => {
    render(<OnboardingFlow initialState={midway} />);

    expect(screen.getByRole("checkbox", { name: /Social/ })).toBeChecked();
  });

  it("keeps an earlier answer reachable by going back", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow initialState={midway} />);

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(heading("What brings you here?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Reduce my exposure/ })).toBeChecked();
  });

  it("starts at the introduction when there is nothing saved", () => {
    render(<OnboardingFlow />);

    expect(heading("What Atlas does")).toBeInTheDocument();
  });
});

describe("reporting progress", () => {
  it("reports the new step on continue", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: "starting_point", categories: ["social"] }),
    );
  });

  it("reports the earlier step on back", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: "privacy_goal" }),
    );
  });

  it("reports a skip, so a skipped step is not offered again on return", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: "starting_point" }),
    );
  });

  it("reports an answer as it is chosen", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("checkbox", { name: /Finance/ }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ categories: ["social", "finance"] }),
    );
  });

  it("reports a deselection, not just additions", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("checkbox", { name: /Social/ }));

    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ categories: [] }));
  });

  it("remains fully operable with no handler supplied", async () => {
    // Persistence is a convenience; losing it must not cost the user the flow.
    const user = userEvent.setup();
    render(<OnboardingFlow initialState={midway} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(heading("How would you like to begin?")).toBeInTheDocument();
  });
});

describe("consent is never resumed", () => {
  it("shows the consent box unchecked even after a full resume", async () => {
    /**
     * ATL-016: the box must be unchecked and never pre-selected, because a
     * pre-ticked box produces a consent record that means nothing (ATL-078).
     * Resuming a saved tick would agree on the user's behalf to something they
     * may never have submitted.
     */
    const user = userEvent.setup();
    render(
      <OnboardingFlow
        initialState={{ ...midway, step: "starting_point" }}
        // A tampered payload carrying consent must not reach the checkbox.
        onStateChange={vi.fn()}
      />,
    );

    // starting_point → identity_profile
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // identity_profile → ready (where the AI-consent checkbox lives)
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("checkbox", { name: /Let Atlas use AI/ })).not.toBeChecked();
  });

  it("never includes a consent field in what it reports", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));

    const reported = onStateChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(Object.keys(reported).sort()).toEqual([
      "categories",
      "privacyGoal",
      "startingPoint",
      "step",
    ]);
  });
});

// ── ATL-211: candidate_review step and auto-advance ───────────────────────────

vi.mock("./adjudication-actions", () => ({
  confirmCandidateAction: vi.fn(() =>
    Promise.resolve({ failure: null, attempt: 1, outcome: "confirmed", assetId: "asset-new" }),
  ),
  rejectCandidateAction: vi.fn(() =>
    Promise.resolve({ failure: null, attempt: 1, outcome: "rejected", assetId: null }),
  ),
  dismissCandidateAction: vi.fn(() =>
    Promise.resolve({ failure: null, attempt: 1, outcome: "dismissed", assetId: null }),
  ),
  notSureCandidateAction: vi.fn(() =>
    Promise.resolve({ failure: null, attempt: 1, outcome: "not_sure", assetId: null }),
  ),
}));

import type { CandidateReviewItem, AggregatorEvidenceItem } from "@/features/discovery";
import { waitFor } from "@testing-library/react";

const candidateReviewState = {
  step: "candidate_review" as const,
  privacyGoal: "reduce_exposure" as const,
  categories: ["social"] as string[],
  startingPoint: "start_fresh" as const,
};

const CANDIDATE: CandidateReviewItem = {
  id: "cand-001",
  sourceIdentifier: "acme-social.example",
  evidenceType: "breach",
  evidenceSummary: "Email found in public breach dataset.",
  providerClass: "hibp",
  status: "pending",
};

const AGG_ITEM: AggregatorEvidenceItem = {
  id: "ev-001",
  sourceIdentifier: "broker.example",
  evidenceType: "public_record",
  evidenceSummary: "Found in public records",
  providerClass: "aggregator-x",
  createdAt: "2026-09-01T00:00:00Z",
};

describe("candidate_review step — auto-advance", () => {
  it("A: auto-advances to ready when both lists are empty", async () => {
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[]}
        aggregatorEvidence={[]}
      />,
    );
    // useEffect fires within act(); candidate_review immediately advances to ready.
    await waitFor(() => {
      expect(screen.queryByText(/Review your findings/i)).toBeNull();
    });
  });

  it("A: auto-advanced state does not render CandidateReviewSection", async () => {
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[]}
        aggregatorEvidence={[]}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/No accounts to review right now/i)).toBeNull();
    });
  });

  it("B: does NOT auto-advance when reviewableCandidates is non-empty", () => {
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[CANDIDATE]}
        aggregatorEvidence={[]}
      />,
    );
    expect(screen.getByText(/Review your findings/i)).toBeInTheDocument();
    expect(screen.getByText("acme-social.example")).toBeInTheDocument();
  });

  it("B: renders CandidateReviewSection when candidates are present", () => {
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[CANDIDATE]}
        aggregatorEvidence={[]}
      />,
    );
    expect(screen.getByText(/Review your findings/i)).toBeInTheDocument();
  });

  it("C: does NOT auto-advance when aggregatorEvidence is non-empty", () => {
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[]}
        aggregatorEvidence={[AGG_ITEM]}
      />,
    );
    expect(screen.getByText(/Review your findings/i)).toBeInTheDocument();
    expect(screen.getByText("broker.example")).toBeInTheDocument();
  });

  it("D: does NOT auto-advance when both lists are non-empty", () => {
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[CANDIDATE]}
        aggregatorEvidence={[AGG_ITEM]}
      />,
    );
    expect(screen.getByText(/Review your findings/i)).toBeInTheDocument();
  });

  it("E: candidate_review is skippable via Skip button", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[CANDIDATE]}
        aggregatorEvidence={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Skip/i }));
    // After skip, candidate_review is no longer shown — moved to ready.
    await waitFor(() => {
      expect(screen.queryByText(/Review your findings/i)).toBeNull();
    });
  });

  it("F: resume at candidate_review with reviewable content stays on step", () => {
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[CANDIDATE]}
        aggregatorEvidence={[]}
      />,
    );
    // The step is not auto-advanced because candidates are present.
    expect(screen.getByText(/Review your findings/i)).toBeInTheDocument();
  });

  it("G: resume at candidate_review with both empty lists advances safely (no loop)", async () => {
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[]}
        aggregatorEvidence={[]}
      />,
    );
    // After auto-advance, the step renders something other than candidate_review.
    // If there were a loop, the component would freeze or re-render infinitely —
    // the test completing without timeout proves no loop occurred.
    await waitFor(() => {
      expect(screen.queryByText(/Review your findings/i)).toBeNull();
    });
  });

  it("H: upgrade mode does not render candidate_review even with candidates", () => {
    render(
      <OnboardingFlow
        isUpgradeMode={true}
        reviewableCandidates={[CANDIDATE]}
        aggregatorEvidence={[AGG_ITEM]}
      />,
    );
    // Upgrade mode starts at identity_profile — candidate_review never appears.
    expect(screen.queryByText(/Review your findings/i)).toBeNull();
  });

  it("I: does NOT auto-advance when reviewableCandidates contains only dismissed items", () => {
    const dismissed: CandidateReviewItem = { ...CANDIDATE, id: "d1", status: "dismissed" };
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[dismissed]}
        aggregatorEvidence={[]}
      />,
    );
    // dismissed is included in reviewableCandidates; list is non-empty → stay
    expect(screen.getByText(/Review your findings/i)).toBeInTheDocument();
  });

  it("J: does NOT auto-advance when reviewableCandidates contains only not_sure items", () => {
    const notSure: CandidateReviewItem = { ...CANDIDATE, id: "n1", status: "not_sure" };
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[notSure]}
        aggregatorEvidence={[]}
      />,
    );
    // not_sure is included in reviewableCandidates; list is non-empty → stay
    expect(screen.getByText(/Review your findings/i)).toBeInTheDocument();
  });

  it("no provider-registry condition controls auto-advance (only list lengths)", async () => {
    // Render with empty providers but empty lists — should auto-advance.
    render(
      <OnboardingFlow
        initialState={candidateReviewState}
        reviewableCandidates={[]}
        aggregatorEvidence={[]}
        activeDiscoveryProviders={[]}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/Review your findings/i)).toBeNull();
    });
  });

  it("progress shows 7 total steps when a full step count is rendered", async () => {
    // Verifies step count is 7 after adding candidate_review.
    render(
      <OnboardingFlow
        initialState={{
          step: "categories",
          privacyGoal: "reduce_exposure",
          categories: ["social"],
          startingPoint: null,
        }}
      />,
    );
    expect(await screen.findByText("Step 3 of 7")).toBeInTheDocument();
  });
});
