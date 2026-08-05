import { beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so they are erased before `vi.mock` hoisting runs. */
import type * as ProfileRepositoryModule from "@/server/repositories/profile-repository";
import type * as ConsentRepositoryModule from "@/server/repositories/consent-repository";
import type * as ActivityRepositoryModule from "@/server/repositories/activity-event-repository";
import type * as AuditRepositoryModule from "@/server/repositories/audit-event-repository";

/**
 * ATL-016 — onboarding completion.
 *
 * The acceptance criteria this covers: consent captured with a policy version,
 * completion setting `onboarding_completed_at`, and no sensitive field reaching
 * storage. The browser journey is covered end to end in
 * `tests/e2e/onboarding.spec.ts`.
 *
 * All four repositories are faked, so this exercises the service's own ordering
 * and validation rather than any of the storage layers underneath it.
 */

const POLICY_VERSION = "2026-08-01";

vi.mock("@/config/app", () => ({ CONSENT_POLICY_VERSION: POLICY_VERSION }));
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 4).toString("base64") },
}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

interface ProfileRow {
  id: string;
  privacy_goal: string | null;
  selected_categories: string[];
  demo_data_enabled: boolean;
  onboarding_completed_at: string | null;
}

const profiles = new Map<string, ProfileRow>();
const consents: { userId: string; consentType: string; policyVersion: string; granted: boolean }[] =
  [];
const activityRows: { eventType: string; summary: string }[] = [];
const auditRows: { eventType: string }[] = [];
const control = { activityFails: false };

vi.mock("@/server/repositories/profile-repository", async () => {
  const actual = await vi.importActual<typeof ProfileRepositoryModule>(
    "@/server/repositories/profile-repository",
  );

  const toRecord = (row: ProfileRow) => ({
    id: row.id,
    displayName: null,
    privacyGoal: row.privacy_goal,
    selectedCategories: row.selected_categories,
    demoDataEnabled: row.demo_data_enabled,
    onboardingCompletedAt: row.onboarding_completed_at,
  });

  return {
    ...actual,
    ProfileRepository: class {
      find(userId: string) {
        const row = profiles.get(userId);
        return Promise.resolve(row ? toRecord(row) : null);
      }
      ensure(userId: string) {
        if (!profiles.has(userId)) {
          profiles.set(userId, {
            id: userId,
            privacy_goal: null,
            selected_categories: [],
            demo_data_enabled: false,
            onboarding_completed_at: null,
          });
        }
        return Promise.resolve(toRecord(profiles.get(userId)!));
      }
      completeOnboarding(
        userId: string,
        c: {
          privacyGoal: string | null;
          selectedCategories: string[];
          demoDataEnabled: boolean;
          completedAt: string;
        },
      ) {
        const row = profiles.get(userId);
        // Mirrors the `onboarding_completed_at is null` guard.
        if (!row || row.onboarding_completed_at !== null) return Promise.resolve(false);
        row.privacy_goal = c.privacyGoal;
        row.selected_categories = c.selectedCategories;
        row.demo_data_enabled = c.demoDataEnabled;
        row.onboarding_completed_at = c.completedAt;
        return Promise.resolve(true);
      }
    },
  };
});

vi.mock("@/server/repositories/consent-repository", async () => {
  const actual = await vi.importActual<typeof ConsentRepositoryModule>(
    "@/server/repositories/consent-repository",
  );
  let next = 1;

  return {
    ...actual,
    ConsentRepository: class {
      append(userId: string, consentType: string, policyVersion: string, granted: boolean) {
        const record = {
          id: `consent-${next++}`,
          userId,
          consentType,
          policyVersion,
          granted,
          recordedAt: new Date().toISOString(),
        };
        consents.push({ userId, consentType, policyVersion, granted });
        return Promise.resolve(record);
      }
      latestFor(userId: string, consentType: string) {
        const found = [...consents]
          .reverse()
          .find((c) => c.userId === userId && c.consentType === consentType);
        return Promise.resolve(found ? { id: "c", recordedAt: "", ...found } : null);
      }
      history() {
        return Promise.resolve([]);
      }
    },
  };
});

vi.mock("@/server/repositories/activity-event-repository", async () => {
  const actual = await vi.importActual<typeof ActivityRepositoryModule>(
    "@/server/repositories/activity-event-repository",
  );

  return {
    ...actual,
    ActivityEventRepository: class {
      append(input: { eventType: string; summary: string }) {
        if (control.activityFails) return Promise.reject(new actual.ActivityStoreError());
        activityRows.push({ eventType: input.eventType, summary: input.summary });
        return Promise.resolve({ id: "act-1", ...input });
      }
    },
  };
});

vi.mock("@/server/repositories/audit-event-repository", async () => {
  const actual = await vi.importActual<typeof AuditRepositoryModule>(
    "@/server/repositories/audit-event-repository",
  );

  return {
    ...actual,
    AuditEventRepository: class {
      findLatestForSubject() {
        return Promise.resolve(null);
      }
      append(record: { eventType: string }) {
        auditRows.push({ eventType: record.eventType });
        return Promise.resolve({ ...record, id: "evt-1" });
      }
    },
  };
});

const { OnboardingService } = await import("./onboarding-service");
const { setLogSink } = await import("@/lib/telemetry/logger");

const ALICE = "aaaaaaaa-0000-4000-8000-00000000000a";

const service = () => new OnboardingService({} as never);

beforeEach(() => {
  profiles.clear();
  consents.length = 0;
  activityRows.length = 0;
  auditRows.length = 0;
  control.activityFails = false;
  setLogSink(() => {});
});

describe("starting onboarding", () => {
  it("creates the profile row on first arrival", async () => {
    // A user authenticated by ATL-011 has an auth.users row but not necessarily
    // a profile; onboarding is the first surface that needs one.
    const profile = await service().start(ALICE);

    expect(profile.id).toBe(ALICE);
    expect(profile.onboardingCompletedAt).toBeNull();
  });

  it("is idempotent", async () => {
    await service().start(ALICE);
    await service().start(ALICE);

    expect(profiles.size).toBe(1);
  });
});

describe("completion", () => {
  it("sets onboarding_completed_at and stores the choices", async () => {
    const { profile, newlyCompleted } = await service().complete({
      userId: ALICE,
      privacyGoal: "reduce_exposure",
      selectedCategories: ["social", "finance"],
      startingPoint: "demo",
      aiProcessingConsent: true,
    });

    expect(newlyCompleted).toBe(true);
    expect(profile.onboardingCompletedAt).not.toBeNull();
    expect(profile.privacyGoal).toBe("reduce_exposure");
    expect(profile.selectedCategories).toEqual(["social", "finance"]);
    expect(profile.demoDataEnabled).toBe(true);
  });

  it("completes with nothing answered, because every question is skippable", async () => {
    const { profile, newlyCompleted } = await service().complete({
      userId: ALICE,
      aiProcessingConsent: false,
    });

    expect(newlyCompleted).toBe(true);
    expect(profile.onboardingCompletedAt).not.toBeNull();
    expect(profile.privacyGoal).toBeNull();
    expect(profile.selectedCategories).toEqual([]);
    expect(profile.demoDataEnabled).toBe(false);
  });

  it("does not overwrite an earlier completion", async () => {
    // Onboarding happens once; the first time is the true one.
    const first = await service().complete({
      userId: ALICE,
      privacyGoal: "reduce_exposure",
      aiProcessingConsent: true,
    });

    const second = await service().complete({
      userId: ALICE,
      privacyGoal: "control_data",
      aiProcessingConsent: true,
    });

    expect(second.newlyCompleted).toBe(false);
    expect(second.profile.privacyGoal).toBe("reduce_exposure");
    expect(second.profile.onboardingCompletedAt).toBe(first.profile.onboardingCompletedAt);
  });

  it("records demo_data_enabled only when demo was chosen", async () => {
    await service().complete({
      userId: ALICE,
      startingPoint: "own",
      aiProcessingConsent: false,
    });

    // ATL-018 keys its separation on this flag, so a wrong value here would seed
    // demo records for a user who asked for none.
    expect(profiles.get(ALICE)?.demo_data_enabled).toBe(false);
  });
});

describe("nothing outside the vocabulary is stored", () => {
  it("discards an unknown privacy goal", async () => {
    // The strongest reading of "no sensitive fields requested": even if a value
    // reaches the service, there is nowhere for a free value to land.
    const { profile } = await service().complete({
      userId: ALICE,
      privacyGoal: "my name is Dana and I live at 1 Example Street",
      aiProcessingConsent: false,
    });

    expect(profile.privacyGoal).toBeNull();
  });

  it("discards unknown categories and keeps the known ones", async () => {
    const { profile } = await service().complete({
      userId: ALICE,
      selectedCategories: ["social", "dana@example.com", "identity"],
      aiProcessingConsent: false,
    });

    // `identity` is a §7.3 *data* category, not an asset category — a plausible
    // confusion, and one the vocabulary check catches.
    expect(profile.selectedCategories).toEqual(["social"]);
  });

  it("de-duplicates repeated categories", async () => {
    const { profile } = await service().complete({
      userId: ALICE,
      selectedCategories: ["social", "social", "finance"],
      aiProcessingConsent: false,
    });

    expect(profile.selectedCategories).toEqual(["social", "finance"]);
  });

  it("discards an unknown starting point", async () => {
    const { profile } = await service().complete({
      userId: ALICE,
      startingPoint: "seed-everything",
      aiProcessingConsent: false,
    });

    expect(profile.demoDataEnabled).toBe(false);
  });
});

describe("AI-processing consent", () => {
  it("records a consent row with the current policy version", async () => {
    // The acceptance criterion, asserted directly.
    await service().complete({ userId: ALICE, aiProcessingConsent: true });

    expect(consents).toEqual([
      { userId: ALICE, consentType: "ai_processing", policyVersion: POLICY_VERSION, granted: true },
    ]);
  });

  it("audits the consent grant", async () => {
    // Security §12 lists consent changes; ATL-078 emits them.
    await service().complete({ userId: ALICE, aiProcessingConsent: true });

    expect(auditRows.map((r) => r.eventType)).toContain("consent.granted");
  });

  it("records nothing when the user declines", async () => {
    /**
     * Declining is a real answer. No row is written, and the ATL-078 gate treats
     * absence as denial — so the outcome is identical to a revocation without a
     * record implying the user was asked twice.
     */
    await service().complete({ userId: ALICE, aiProcessingConsent: false });

    expect(consents).toHaveLength(0);
  });

  it("records consent before marking the profile complete", async () => {
    /**
     * Ordering matters in one direction. A completed profile with no consent row
     * would leave AI features gated by a record that does not exist; a consent
     * row for an unfinished onboarding is harmless — they simply agreed.
     */
    const failing = {
      grant: () => Promise.reject(new Error("consent store down")),
    };
    const svc = new OnboardingService({} as never);
    Object.assign(svc, { consent: failing });

    await expect(svc.complete({ userId: ALICE, aiProcessingConsent: true })).rejects.toThrow(
      "consent store down",
    );

    expect(profiles.get(ALICE)?.onboarding_completed_at ?? null).toBeNull();
  });
});

describe("activity", () => {
  it("writes one timeline event on completion", async () => {
    await service().complete({ userId: ALICE, aiProcessingConsent: false });

    expect(activityRows).toEqual([
      { eventType: "onboarding.completed", summary: "Finished setting up Atlas" },
    ]);
  });

  it("writes no second event on a repeat submission", async () => {
    await service().complete({ userId: ALICE, aiProcessingConsent: false });
    await service().complete({ userId: ALICE, aiProcessingConsent: false });

    expect(activityRows).toHaveLength(1);
  });

  it("still completes when the activity write fails", async () => {
    // A missing timeline row must not undo a completed onboarding.
    const records: { level: string; event: string }[] = [];
    setLogSink((record) => records.push(record));
    control.activityFails = true;

    const { newlyCompleted } = await service().complete({
      userId: ALICE,
      aiProcessingConsent: false,
    });

    expect(newlyCompleted).toBe(true);
    expect(records).toContainEqual(
      expect.objectContaining({ level: "error", event: "activity.write_failed" }),
    );
  });
});
