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
  it("matches frontend §17", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "introduction",
      "privacy_goal",
      "categories",
      "starting_point",
      "ready",
    ]);
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
  });

  it("rejects an unknown step id", () => {
    // ATL-017 will persist these ids, so an unrecognised one must not resolve.
    expect(isOnboardingStep("privacy_goal")).toBe(true);
    expect(isOnboardingStep("step-2")).toBe(false);
  });
});

describe("skipping", () => {
  it("allows skipping every step that collects a preference", () => {
    // FR-02 "allow skipping optional steps"; §17 "skip where safe".
    expect(SKIPPABLE_STEPS).toEqual(["privacy_goal", "categories", "starting_point"]);
  });

  it("does not offer skip on the introduction or the completion step", () => {
    // The introduction asks nothing — there is nothing to skip, and it carries
    // the limitations copy. `ready` *is* the completion action.
    expect(isSkippable("introduction")).toBe(false);
    expect(isSkippable("ready")).toBe(false);
  });

  it("lets a user reach completion without answering anything", () => {
    const answerable = ONBOARDING_STEPS.filter(
      (step) => step !== "introduction" && step !== "ready",
    );
    expect(answerable.every(isSkippable)).toBe(true);
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

describe("starting point", () => {
  it("offers demo or own accounts", () => {
    expect(STARTING_POINTS.map((s) => s.id)).toEqual(["demo", "own"]);
    expect(isStartingPoint("demo")).toBe(true);
    expect(isStartingPoint("seed")).toBe(false);
  });

  it("describes demo data as removable and labelled", () => {
    // PRD honesty rules and ATL-018's isolation requirement — a user must know
    // sample data is sample data before choosing it.
    const demo = STARTING_POINTS.find((s) => s.id === "demo");
    expect(demo?.hint.toLowerCase()).toContain("example");
    expect(demo?.hint.toLowerCase()).toContain("remove");
  });
});
