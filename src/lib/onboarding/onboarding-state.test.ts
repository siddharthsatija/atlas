import { describe, expect, it } from "vitest";
import { ASSET_CATEGORIES } from "@/lib/assets/categories";
import { ONBOARDING_STEPS } from "./onboarding-steps";
import {
  INITIAL_ONBOARDING_STATE,
  MAX_SELECTED_CATEGORIES,
  isInitialOnboardingState,
  parseOnboardingState,
  serializeOnboardingState,
  type OnboardingState,
} from "./onboarding-state";

/**
 * ATL-017 — resumable onboarding state.
 *
 * The column is `jsonb` with only an "is an object" check, so everything here is
 * about reading untrusted storage: the value decides which step a user lands on,
 * and it must never be able to break the flow.
 */

const complete: OnboardingState = {
  step: "starting_point",
  privacyGoal: "reduce_exposure",
  categories: ["social", "finance"],
  startingPoint: "demo",
};

describe("round trip", () => {
  it("restores exactly what was saved", () => {
    expect(parseOnboardingState(serializeOnboardingState(complete))).toEqual(complete);
  });

  it("survives a JSON round trip, which is what storage actually does", () => {
    // The value goes through PostgREST as JSON, so structural equality after a
    // stringify/parse cycle is the property that matters, not object identity.
    const stored = JSON.parse(JSON.stringify(serializeOnboardingState(complete))) as unknown;

    expect(parseOnboardingState(stored)).toEqual(complete);
  });

  it("stores no key beyond the four it declares", () => {
    // Guards the "no sensitive values" criterion structurally: a field added to
    // the flow cannot reach storage without also being added here.
    expect(Object.keys(serializeOnboardingState(complete)).sort()).toEqual([
      "categories",
      "privacyGoal",
      "startingPoint",
      "step",
    ]);
  });

  it("drops anything the caller smuggles in", () => {
    const smuggled = { ...complete, displayName: "Dana Scully", email: "dana@example.com" };

    const serialised = serializeOnboardingState(smuggled);

    expect(JSON.stringify(serialised)).not.toContain("Dana");
    expect(JSON.stringify(serialised)).not.toContain("example.com");
  });
});

describe("malformed state recovers to the nearest safe step", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", ["introduction"]],
    ["a string", "privacy_goal"],
    ["a number", 3],
    ["a boolean", true],
    ["an empty object", {}],
  ])("recovers from %s", (_label, value) => {
    expect(parseOnboardingState(value)).toEqual(INITIAL_ONBOARDING_STATE);
  });

  it("falls back to the first step when the step is unrecognised", () => {
    /**
     * The first step is the safe target: it asks nothing, so no answer is lost by
     * landing there, and it carries the limitations copy the product must show.
     * Guessing forward could skip that copy for precisely the users whose state
     * was already unreliable.
     */
    const state = parseOnboardingState({ ...complete, step: "payment_details" });

    expect(state.step).toBe(ONBOARDING_STEPS[0]);
  });

  it("keeps valid answers when only the step is broken", () => {
    // Recovery is field-by-field: returning to step one with your choices intact
    // is a far smaller loss than returning to an empty flow.
    const state = parseOnboardingState({ ...complete, step: 42 });

    expect(state.privacyGoal).toBe("reduce_exposure");
    expect(state.categories).toEqual(["social", "finance"]);
    expect(state.startingPoint).toBe("demo");
  });

  it("keeps the step when only an answer is broken", () => {
    const state = parseOnboardingState({ ...complete, privacyGoal: "sell_my_data" });

    expect(state.step).toBe("starting_point");
    expect(state.privacyGoal).toBeNull();
    expect(state.categories).toEqual(["social", "finance"]);
  });

  it.each([
    ["an unknown goal", { privacyGoal: "world_domination" }],
    ["a non-string goal", { privacyGoal: 7 }],
    ["an unknown starting point", { startingPoint: "teleport" }],
    ["a non-string starting point", { startingPoint: {} }],
  ])("drops %s", (_label, patch) => {
    const state = parseOnboardingState({ ...complete, ...patch });

    if ("privacyGoal" in patch) expect(state.privacyGoal).toBeNull();
    if ("startingPoint" in patch) expect(state.startingPoint).toBeNull();
  });
});

describe("categories", () => {
  it("filters unknown ids without discarding the known ones", () => {
    const state = parseOnboardingState({
      ...complete,
      categories: ["social", "not_a_category", "finance"],
    });

    expect(state.categories).toEqual(["social", "finance"]);
  });

  it("filters non-string entries", () => {
    const state = parseOnboardingState({ ...complete, categories: ["social", 5, null, {}] });

    expect(state.categories).toEqual(["social"]);
  });

  it("deduplicates", () => {
    const state = parseOnboardingState({ ...complete, categories: ["social", "social"] });

    expect(state.categories).toEqual(["social"]);
  });

  it("recovers to empty when categories is not an array", () => {
    expect(parseOnboardingState({ ...complete, categories: "social" }).categories).toEqual([]);
  });

  it("cannot exceed the column bound", () => {
    /**
     * `selected_categories` accepts at most 32 entries (ATL-015). A tampered row
     * holding more must not be able to grow the state past what the column it
     * eventually feeds will take.
     */
    const flooded = Array.from({ length: 100 }, (_, i) => `cat-${i}`).concat(
      ASSET_CATEGORIES.map((category) => category.id),
    );

    const state = parseOnboardingState({ ...complete, categories: flooded });

    expect(state.categories.length).toBeLessThanOrEqual(MAX_SELECTED_CATEGORIES);
    expect(state.categories).toEqual(ASSET_CATEGORIES.map((category) => category.id));
  });
});

describe("consent is never part of the state", () => {
  it("does not restore a consent flag, however it was stored", () => {
    /**
     * ATL-016 requires the AI consent box to be unchecked and never
     * pre-selected, because a pre-ticked box produces a consent record that
     * means nothing (ATL-078). Restoring a saved tick would reintroduce exactly
     * that, so the field has no place in this state at all.
     */
    const state = parseOnboardingState({ ...complete, aiConsent: true, aiProcessingConsent: true });

    expect(Object.keys(state)).not.toContain("aiConsent");
    expect(Object.keys(state)).not.toContain("aiProcessingConsent");
    expect(JSON.stringify(serializeOnboardingState(state))).not.toContain("Consent");
  });
});

describe("isInitialOnboardingState", () => {
  it("is true for the initial state", () => {
    expect(isInitialOnboardingState(INITIAL_ONBOARDING_STATE)).toBe(true);
  });

  it("is true for anything that recovered to it", () => {
    expect(isInitialOnboardingState(parseOnboardingState("nonsense"))).toBe(true);
  });

  it.each([
    ["a later step", { step: "categories" as const }],
    ["a chosen goal", { privacyGoal: "reduce_exposure" }],
    ["a chosen category", { categories: ["social"] }],
    ["a chosen starting point", { startingPoint: "own" }],
  ])("is false once the user has %s", (_label, patch) => {
    expect(isInitialOnboardingState({ ...INITIAL_ONBOARDING_STATE, ...patch })).toBe(false);
  });
});
