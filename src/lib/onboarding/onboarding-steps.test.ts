import { describe, expect, it } from "vitest";
import { ASSET_CATEGORIES, ASSET_CATEGORY_IDS, isAssetCategory } from "@/lib/assets/categories";
import {
  ONBOARDING_STEPS,
  PRIVACY_GOALS,
  SKIPPABLE_STEPS,
  STARTING_POINTS,
  isOnboardingStep,
  isPrivacyGoal,
  isSkippable,
  isStartingPoint,
  nextStep,
  previousStep,
  stepPosition,
} from "./onboarding-steps";

/**
 * ATL-016 — the step model and its vocabularies.
 *
 * These are what the UI renders and the server validates against, so most of
 * these tests are really asking the same thing: can the two disagree?
 */

describe("step order", () => {
  it("matches Phase 1 primary graph (Repair #2: categories and starting_point removed)", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "introduction",
      "privacy_goal",
      "identity_profile",
      "candidate_review",
      "ready",
    ]);
  });

  it("does not include the removed legacy steps", () => {
    expect(ONBOARDING_STEPS).not.toContain("categories");
    expect(ONBOARDING_STEPS).not.toContain("starting_point");
  });

  it("walks forward and back symmetrically", () => {
    for (const step of ONBOARDING_STEPS) {
      const forward = nextStep(step);
      if (forward) expect(previousStep(forward)).toBe(step);
    }
  });

  it("ends and begins cleanly", () => {
    expect(previousStep("introduction")).toBeNull();
    expect(nextStep("ready")).toBeNull();
  });

  it("numbers steps from one for the progress indicator", () => {
    expect(stepPosition("introduction")).toBe(1);
    expect(stepPosition("ready")).toBe(ONBOARDING_STEPS.length);
    // Phase 1 graph has 5 steps.
    expect(ONBOARDING_STEPS.length).toBe(5);
    expect(stepPosition("ready")).toBe(5);
  });

  it("rejects an unknown step id", () => {
    // ATL-017 will persist these ids, so an unrecognised one must not resolve.
    expect(isOnboardingStep("privacy_goal")).toBe(true);
    expect(isOnboardingStep("step-2")).toBe(false);
  });

  it("rejects removed legacy step ids", () => {
    // categories and starting_point are no longer valid primary steps.
    expect(isOnboardingStep("categories")).toBe(false);
    expect(isOnboardingStep("starting_point")).toBe(false);
  });
});

describe("skipping", () => {
  it("allows skipping only the two optional preference steps", () => {
    // Phase 1: categories and starting_point removed; identity_profile is
    // mandatory. Only privacy_goal and candidate_review remain skippable.
    expect(SKIPPABLE_STEPS).toEqual(["privacy_goal", "candidate_review"]);
  });

  it("does not offer skip on the introduction or the completion step", () => {
    // The introduction asks nothing — there is nothing to skip, and it carries
    // the limitations copy. `ready` *is* the completion action.
    expect(isSkippable("introduction")).toBe(false);
    expect(isSkippable("ready")).toBe(false);
  });

  it("identity_profile is mandatory and not skippable", () => {
    // ATL-209: identity_profile must NOT appear in SKIPPABLE_STEPS.
    expect(isSkippable("identity_profile")).toBe(false);
  });

  it("every remaining non-mandatory, non-boundary step is skippable", () => {
    // All steps except introduction, identity_profile, and ready are skippable.
    const preferenceSteps = ONBOARDING_STEPS.filter(
      (step) => step !== "introduction" && step !== "identity_profile" && step !== "ready",
    );
    expect(preferenceSteps.every(isSkippable)).toBe(true);
  });
});

describe("privacy goals", () => {
  it("is a fixed set, not free text", () => {
    /**
     * ATL-015's migration is explicit: "Stored as text rather than an enum so
     * ATL-016 can adjust the options without a schema migration; the allowed
     * values are enforced in the service." A text box here would also breach
     * "no sensitive fields requested" — it is an invitation to type something
     * personal into a column nothing masks.
     */
    expect(PRIVACY_GOALS.length).toBeGreaterThan(1);
    expect(isPrivacyGoal("reduce_exposure")).toBe(true);
    expect(isPrivacyGoal("anything else")).toBe(false);
  });

  it("describes why someone is here, never anything about them", () => {
    for (const goal of PRIVACY_GOALS) {
      expect(goal.id).toMatch(/^[a-z][a-z_]*$/);
      expect(goal.label.length).toBeGreaterThan(0);
      expect(goal.hint.length).toBeGreaterThan(0);
    }
  });

  it("fits the column constraint", () => {
    // profiles.privacy_goal is checked at 1..120 characters.
    for (const goal of PRIVACY_GOALS) {
      expect(goal.id.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("asset categories", () => {
  it("offers a service-type vocabulary", () => {
    // Distinct from architecture §7.3's *data* categories: `social` is what a
    // service is, `contact` is what it stores.
    expect(ASSET_CATEGORY_IDS).toContain("social");
    expect(ASSET_CATEGORY_IDS).toContain("finance");
    expect(isAssetCategory("social")).toBe(true);
    expect(isAssetCategory("identity")).toBe(false);
  });

  it("always offers an escape hatch", () => {
    // Nobody should be forced into a wrong bucket.
    expect(ASSET_CATEGORY_IDS).toContain("other");
  });

  it("has unique ids and complete labels", () => {
    expect(new Set(ASSET_CATEGORY_IDS).size).toBe(ASSET_CATEGORY_IDS.length);
    for (const category of ASSET_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
      expect(category.hint.length).toBeGreaterThan(0);
    }
  });

  it("fits the column constraint", () => {
    // profiles.selected_categories allows at most 32 entries.
    expect(ASSET_CATEGORIES.length).toBeLessThanOrEqual(32);
  });
});

describe("starting point — legacy backward-compatibility vocabulary", () => {
  /**
   * The `starting_point` UI step has been removed from the primary onboarding
   * journey (OQ-03: demo mode is post-signup only). STARTING_POINTS,
   * StartingPointId, and isStartingPoint are retained so that
   * parseOnboardingState can safely parse stored rows written before Repair #2
   * without discarding other valid fields.
   *
   * These tests confirm the vocabulary is still valid for parsing purposes.
   * They do NOT imply the UI step should be restored.
   */
  it("vocabulary is retained for safe parsing of legacy stored state", () => {
    expect(STARTING_POINTS.map((s) => s.id)).toEqual(["demo", "own"]);
    expect(isStartingPoint("demo")).toBe(true);
    expect(isStartingPoint("own")).toBe(true);
    expect(isStartingPoint("seed")).toBe(false);
    expect(isStartingPoint("start_fresh")).toBe(false);
  });

  it("describes demo data as removable and labelled", () => {
    // PRD honesty rules and ATL-018's isolation requirement — a user must know
    // sample data is sample data before choosing it.
    const demo = STARTING_POINTS.find((s) => s.id === "demo");
    expect(demo?.hint.toLowerCase()).toContain("example");
    expect(demo?.hint.toLowerCase()).toContain("remove");
  });

  it("starting_point is not a primary onboarding step", () => {
    // The vocabulary remains, but the step does not.
    expect(isOnboardingStep("starting_point")).toBe(false);
    expect(ONBOARDING_STEPS).not.toContain("starting_point");
  });
});
