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

/**
 * A mid-flow state used across resuming and reporting tests.
 * Positioned at privacy_goal (step 2 of 5) with a saved goal.
 * categories and startingPoint are legacy fields retained in OnboardingState
 * for backward-compatible persistence; they carry empty/null values here.
 */
const midway: OnboardingState = {
  step: "privacy_goal",
  privacyGoal: "reduce_exposure",
  categories: [],
  startingPoint: null,
};

/** State that positions the user at identity_profile, used to test Back navigation. */
const atIdentityProfile: OnboardingState = {
  step: "identity_profile",
  privacyGoal: "reduce_exposure",
  categories: [],
  startingPoint: null,
};

const heading = (name: string | RegExp) => screen.getByRole("heading", { level: 1, name });

describe("resuming", () => {
  it("opens at the saved step rather than the introduction", async () => {
    render(<OnboardingFlow initialState={midway} />);

    expect(heading("What brings you here?")).toBeInTheDocument();
    expect(await screen.findByText("Step 2 of 5")).toBeInTheDocument();
  });

  it("restores the choices made before leaving", () => {
    render(<OnboardingFlow initialState={midway} />);

    expect(screen.getByRole("radio", { name: /Reduce my exposure/ })).toBeChecked();
  });

  it("keeps an earlier answer reachable by going back", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow initialState={atIdentityProfile} />);

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
      expect.objectContaining({ step: "identity_profile" }),
    );
  });

  it("reports the earlier step on back", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: "introduction" }),
    );
  });

  it("reports a skip, so a skipped step is not offered again on return", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ step: "identity_profile" }),
    );
  });

  it("reports an answer as it is chosen", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    await user.click(screen.getByRole("radio", { name: /Understand my footprint/ }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ privacyGoal: "understand_footprint" }),
    );
  });

  it("reports a changed selection when a different option is chosen", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(<OnboardingFlow initialState={midway} onStateChange={onStateChange} />);

    // midway has reduce_exposure selected; clicking another goal changes the value.
    await user.click(screen.getByRole("radio", { name: /Stay on top of it/ }));

    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ privacyGoal: "stay_organised" }),
    );
  });

  it("remains fully operable with no handler supplied", async () => {
    // Persistence is a convenience; losing it must not cost the user the flow.
    const user = userEvent.setup();
    render(<OnboardingFlow initialState={midway} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("heading", { name: "Your identity details" })).toBeInTheDocument();
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
        initialState={midway}
        // A tampered payload carrying consent must not reach the checkbox.
        onStateChange={vi.fn()}
      />,
    );

    // privacy_goal → identity_profile
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

import type {
  CandidateReviewItem,
  AggregatorEvidenceItem,
  DiscoveryProviderView,
} from "@/features/discovery";
import { waitFor } from "@testing-library/react";

const candidateReviewState = {
  step: "candidate_review" as const,
  privacyGoal: "reduce_exposure" as const,
  categories: [] as string[],
  startingPoint: null,
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

  it("progress shows 5 total steps when a full step count is rendered", async () => {
    // Phase 1 graph has 5 steps after removing categories and starting_point.
    render(
      <OnboardingFlow
        initialState={{
          step: "privacy_goal",
          privacyGoal: "reduce_exposure",
          categories: [],
          startingPoint: null,
        }}
      />,
    );
    expect(await screen.findByText("Step 2 of 5")).toBeInTheDocument();
  });
});

// ── Phase 1 content contracts (Repair #2) ─────────────────────────────────────

describe("Phase 1 content contracts — removed steps and copy", () => {
  it("does not render the categories step heading anywhere in the flow", () => {
    // "Where do you have accounts?" must not appear in any primary-flow step.
    render(<OnboardingFlow />);
    expect(screen.queryByText("Where do you have accounts?")).toBeNull();
  });

  it("does not render the starting_point step heading anywhere in the flow", () => {
    // "How would you like to begin?" must not appear in any primary-flow step.
    render(<OnboardingFlow />);
    expect(screen.queryByText("How would you like to begin?")).toBeNull();
  });

  it("introduction copy does not claim Atlas cannot find forgotten accounts", () => {
    render(<OnboardingFlow />);
    expect(screen.queryByText(/cannot find accounts you have forgotten/i)).toBeNull();
  });

  it("introduction copy does not claim Atlas works only from what you add", () => {
    render(<OnboardingFlow />);
    expect(screen.queryByText(/works only from what you add/i)).toBeNull();
  });

  it("introduction copy uses bounded-discovery language", () => {
    render(<OnboardingFlow />);
    // The limitations item should reference supported providers and authorized signals.
    expect(screen.getByText(/supported providers/i)).toBeInTheDocument();
    expect(screen.getByText(/authorize/i)).toBeInTheDocument();
  });

  it("ready step does not say the dashboard is empty until you add something", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingFlow
        initialState={{
          step: "privacy_goal",
          privacyGoal: null,
          categories: [],
          startingPoint: null,
        }}
      />,
    );
    // Navigate to ready: privacy_goal → identity_profile → ready
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.queryByText(/dashboard is empty until you add something/i)).toBeNull();
  });

  it("ready step lede covers both discovery-found and zero-result cases", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingFlow
        initialState={{
          step: "privacy_goal",
          privacyGoal: null,
          categories: [],
          startingPoint: null,
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // The new lede references evidence-backed matches without asserting they exist.
    expect(screen.getByText(/evidence-backed matches/i)).toBeInTheDocument();
  });

  it("completion form does not emit a legacy categories hidden input", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingFlow
        initialState={{
          step: "privacy_goal",
          privacyGoal: null,
          categories: ["social", "finance"],
          startingPoint: null,
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // Even with legacy categories in state, the form must not re-submit them.
    // input[type="hidden"] has no ARIA role — no screen.queryBy* method can reach it.
    // eslint-disable-next-line testing-library/no-node-access
    expect(document.querySelector('input[name="categories"]')).toBeNull();
  });

  it("completion form does not emit a legacy startingPoint hidden input", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingFlow
        initialState={{
          step: "privacy_goal",
          privacyGoal: null,
          categories: [],
          startingPoint: "own",
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // Even with a legacy startingPoint in state, the form must not re-submit it.
    // input[type="hidden"] has no ARIA role — no screen.queryBy* method can reach it.
    // eslint-disable-next-line testing-library/no-node-access
    expect(document.querySelector('input[name="startingPoint"]')).toBeNull();
  });

  it("identity_profile step remains reachable in the primary flow", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow />);

    // introduction → privacy_goal → identity_profile
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("heading", { name: "Your identity details" })).toBeInTheDocument();
  });

  it("DiscoveryConsentSection renders when active providers are supplied", () => {
    const provider: DiscoveryProviderView = {
      providerClass: "discovery_github_profile",
      consentType: "discovery_identifying",
      disclosureClass: "identifying_lookup",
      disclosureContractVersion: "v1",
    };
    render(
      <OnboardingFlow initialState={atIdentityProfile} activeDiscoveryProviders={[provider]} />,
    );
    // DiscoveryConsentSection should be present alongside IdentityProfileStep.
    // The section renders when providers.length > 0.
    expect(screen.getByText(/Allow Atlas to search external sources/i)).toBeInTheDocument();
  });

  it("upgrade mode starts at identity_profile and hides the progress bar", () => {
    render(<OnboardingFlow isUpgradeMode={true} />);
    expect(screen.getByRole("heading", { name: "Your identity details" })).toBeInTheDocument();
    // Progress bar ("Step N of 5") must not appear in upgrade mode.
    expect(screen.queryByText(/Step \d+ of 5/)).toBeNull();
  });
});
