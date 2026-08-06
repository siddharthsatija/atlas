import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { ProfileRepository } from "@/server/repositories/profile-repository";
import { OnboardingService } from "@/server/onboarding/onboarding-service";
import { INITIAL_ONBOARDING_STATE, type OnboardingState } from "@/lib/onboarding/onboarding-state";

/**
 * ATL-017 — onboarding persistence.
 *
 * Exercises the **real** `ProfileRepository` against a fake PostgREST client, so
 * the assertions cover what this ticket actually added: the completion guard on
 * the save, the serialisation into `onboarding_state_json`, and the parse back
 * out. Faking the repository instead would test the fake.
 *
 * Row-level security for `profiles` belongs to ATL-015 and is covered against a
 * real database in `tests/integration/`.
 */

vi.mock("@/config/app", () => ({ CONSENT_POLICY_VERSION: "2026-08-01" }));
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 4).toString("base64") },
}));

interface Row {
  id: string;
  display_name: string | null;
  privacy_goal: string | null;
  selected_categories: string[];
  demo_data_enabled: boolean;
  onboarding_completed_at: string | null;
  onboarding_state_json: unknown;
}

const rows = new Map<string, Row>();

const USER = "11111111-1111-4111-8111-111111111111";

function seed(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: USER,
    display_name: null,
    privacy_goal: null,
    selected_categories: [],
    demo_data_enabled: false,
    onboarding_completed_at: null,
    onboarding_state_json: {},
    ...overrides,
  };
  rows.set(row.id, row);
  return row;
}

/**
 * A fake PostgREST builder.
 *
 * Deliberately honours `.is("onboarding_completed_at", null)` rather than
 * ignoring it — that filter *is* the guard this ticket relies on, so a fake that
 * dropped it would let the guard tests pass while the real query did nothing.
 */
function createDb(): SupabaseClient<Database> {
  const builder = () => {
    let operation: "select" | "update" | "upsert" = "select";
    let patch: Partial<Row> = {};
    const filters: { column: keyof Row; value: unknown }[] = [];

    const matching = () =>
      [...rows.values()].filter((row) =>
        filters.every((filter) => row[filter.column] === filter.value),
      );

    const run = () => {
      const matched = matching();
      if (operation === "update") {
        for (const row of matched) Object.assign(row, patch);
      }
      return { data: matched.map((row) => ({ ...row })), error: null };
    };

    const self = {
      select: () => self,
      eq: (column: keyof Row, value: unknown) => {
        filters.push({ column, value });
        return self;
      },
      is: (column: keyof Row, value: unknown) => {
        filters.push({ column, value });
        return self;
      },
      update: (values: Partial<Row>) => {
        operation = "update";
        patch = values;
        return self;
      },
      upsert: (values: { id: string }) => {
        operation = "upsert";
        if (!rows.has(values.id)) seed({ id: values.id });
        return self;
      },
      maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
      then: (resolve: (result: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };

    return self;
  };

  return { from: () => builder() } as unknown as SupabaseClient<Database>;
}

const saved = (): unknown => rows.get(USER)?.onboarding_state_json;

const midway: OnboardingState = {
  step: "starting_point",
  privacyGoal: "reduce_exposure",
  categories: ["social", "finance"],
  startingPoint: "demo",
};

let db: SupabaseClient<Database>;
let profiles: ProfileRepository;

beforeEach(() => {
  rows.clear();
  db = createDb();
  profiles = new ProfileRepository(db);
});

describe("save and resume", () => {
  it("resumes at the saved step with the prior choices intact", async () => {
    seed();

    await profiles.saveOnboardingState(USER, midway);
    const profile = await profiles.find(USER);

    expect(profile?.onboardingState).toEqual(midway);
  });

  it("starts a new user at the beginning", async () => {
    // The column defaults to `{}`, which must read as "not started" rather than
    // as a broken value.
    seed();

    expect((await profiles.find(USER))?.onboardingState).toEqual(INITIAL_ONBOARDING_STATE);
  });

  it("overwrites rather than merges, so going back really goes back", async () => {
    /**
     * Back and skip both move the user to an earlier or later step with a
     * possibly smaller answer set. A merging write would leave a category the
     * user had just deselected, and the resumed flow would disagree with what
     * they last saw.
     */
    seed();
    await profiles.saveOnboardingState(USER, midway);

    await profiles.saveOnboardingState(USER, {
      step: "privacy_goal",
      privacyGoal: null,
      categories: [],
      startingPoint: null,
    });

    expect((await profiles.find(USER))?.onboardingState).toEqual({
      step: "privacy_goal",
      privacyGoal: null,
      categories: [],
      startingPoint: null,
    });
  });

  it("records progress for the right user only", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    seed();
    seed({ id: other });

    await profiles.saveOnboardingState(USER, midway);

    expect(rows.get(other)?.onboarding_state_json).toEqual({});
  });
});

describe("malformed stored state", () => {
  it.each([
    ["a string", "privacy_goal"],
    ["an array", ["categories"]],
    ["a number", 3],
    ["null", null],
    ["an object of nonsense", { step: "elsewhere", categories: "social" }],
  ])("recovers from %s without throwing", async (_label, stored) => {
    seed({ onboarding_state_json: stored });

    await expect(profiles.find(USER)).resolves.toBeDefined();
    expect((await profiles.find(USER))?.onboardingState).toEqual(INITIAL_ONBOARDING_STATE);
  });

  it("keeps the salvageable parts of a partly-broken row", async () => {
    seed({
      onboarding_state_json: {
        step: "categories",
        privacyGoal: "not_a_goal",
        categories: ["social", "bogus"],
        startingPoint: "demo",
      },
    });

    expect((await profiles.find(USER))?.onboardingState).toEqual({
      step: "categories",
      privacyGoal: null,
      categories: ["social"],
      startingPoint: "demo",
    });
  });
});

describe("the completion guard", () => {
  it("refuses to save progress onto a finished profile", async () => {
    /**
     * A tab left open on step three would otherwise write progress back after
     * completion, and the product would ask a finished user to onboard again.
     */
    seed({ onboarding_completed_at: "2026-08-01T00:00:00.000Z" });

    const written = await profiles.saveOnboardingState(USER, midway);

    expect(written).toBe(false);
    expect(saved()).toEqual({});
  });

  it("clears the resume state when onboarding completes", async () => {
    // Completion promotes every answer into its own column, so what is left here
    // is a stale duplicate with no purpose.
    seed();
    await profiles.saveOnboardingState(USER, midway);

    await profiles.completeOnboarding(USER, {
      privacyGoal: "reduce_exposure",
      selectedCategories: ["social"],
      demoDataEnabled: true,
      completedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(saved()).toEqual({});
  });
});

describe("service validation", () => {
  const service = () => new OnboardingService(db);

  it("stores only recognised values", async () => {
    seed();

    await service().saveProgress(USER, {
      step: "categories",
      privacyGoal: "world_domination",
      categories: ["social", "not_a_category"],
      startingPoint: "teleport",
    });

    expect(saved()).toEqual({
      step: "categories",
      privacyGoal: null,
      categories: ["social"],
      startingPoint: null,
    });
  });

  it("stores nothing that could carry a personal value", async () => {
    seed();

    await service().saveProgress(USER, {
      ...midway,
      displayName: "Dana Scully",
      email: "dana@example.com",
    } as OnboardingState);

    const serialised = JSON.stringify(saved());
    expect(serialised).not.toContain("Dana");
    expect(serialised).not.toContain("example.com");
  });

  it("creates the profile row before saving, for a user arriving mid-flow", async () => {
    // No `seed()`: the service must not depend on the page having created it.
    await service().saveProgress(USER, midway);

    expect(rows.get(USER)?.onboarding_state_json).toEqual(midway);
  });

  it("reports that nothing was saved once onboarding is complete", async () => {
    seed({ onboarding_completed_at: "2026-08-01T00:00:00.000Z" });

    await expect(service().saveProgress(USER, midway)).resolves.toBe(false);
  });
});
