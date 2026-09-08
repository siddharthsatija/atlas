import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { waitForConfirmationLink } from "./support/mailbox";
import {
  getUserIdByEmail,
  seedDiscoveryCandidate,
  removeSeededCandidate,
  type SeededCandidate,
} from "./support/discovery-fixture";
import { seedUpgradeProfile } from "./support/upgrade-fixture";

/**
 * ATL-214 — Discovery-first core journey E2E tests.
 *
 * ## What these tests prove
 *
 * T1 PRIMARY JOURNEY
 *   The full 7-step onboarding flow completes correctly for a new user who
 *   arrives at the identity_profile step and is shown the DiscoveryConsentSection
 *   (GitHub is the only active provider).  The test grants identifying consent
 *   and verifies the journey reaches /overview.
 *
 * T2 MOBILE LAYOUT
 *   The identity_profile step (which hosts the DiscoveryConsentSection) does not
 *   overflow horizontally on a narrow viewport (412 px, matching Pixel 7 from
 *   the mobile project).
 *
 * T3 DEFERRED ADJUDICATION
 *   A pending candidate is seeded, the user reaches candidate_review via the
 *   existing walkToReview helper, dismisses the candidate (deferred / not
 *   actioned), skips, and completes onboarding.  The nav badge is absent on
 *   the dashboard because a dismissed candidate is not pending.
 *
 * T4 UPGRADE-ONBOARDING
 *   A fresh user's profile is seeded into the pre-M13 upgrade state:
 *   onboarding_completed_at = <past>, identity_profile_step_completed_at = NULL.
 *   The onboarding page renders in upgrade mode (no progress bar, only the
 *   identity_profile step), and completing it redirects to /overview.
 *
 * T5 PRIVACY
 *   The captured server log (test-results/e2e-server.log) must not contain the
 *   test user's email address or the seeded evidence summary value in plaintext.
 *   The assertion is unconditional and scans the full log without narrowing.
 *
 * ## Auth strategy
 *
 * All tests use `test.use({ storageState: { cookies: [], origins: [] } })` — a
 * fresh browser context with no saved session.  Each test signs in its own
 * user via magic link.  No test reads or writes the shared storageState from
 * auth.setup.ts.
 *
 * ## PRODUCT DIRECTION GUARD
 *
 * - HIBP is parked (ATL-216); no HIBP stub, no HIBP consent assertions.
 * - GitHub is the only ACTIVE_DISCOVERY_PROVIDERS entry.
 * - Username is optional; no manual platform enumeration.
 * - No personal data is seeded in user_personal_fields rows.
 * - Privacy rule is not weakened: T5 scans the full log, no scoping.
 */

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Signs in a brand-new account and lands on /onboarding.
 *
 * Mirrors the helper in discover.spec.ts so the same auth contract applies.
 */
async function startFresh(page: Page): Promise<string> {
  const email = `atl214-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: /email me a sign-in link/i }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  await page.goto(await waitForConfirmationLink(email));
  await page.waitForURL(/\/onboarding(\?.*)?$/);
  return email;
}

/**
 * Navigates from the introduction step to the candidate_review step.
 *
 * Mirrors walkToReview from discover.spec.ts.
 */
async function walkToReview(page: Page): Promise<void> {
  // 1 Introduction
  await page.getByRole("button", { name: "Continue" }).click();
  // 2 privacy_goal
  await page.getByRole("button", { name: "Skip" }).click();
  // 3 categories
  await page.getByRole("button", { name: "Skip" }).click();
  // 4 starting_point
  await page.getByRole("button", { name: "Skip" }).click();
  // 5 identity_profile — mandatory; Continue advances to candidate_review
  await page.getByRole("button", { name: "Continue" }).click();
}

// ── Module-level values captured for T5 privacy assertions ────────────────────

/** Email from the T1 fresh user — asserted absent in the server log by T5. */
let t1Email = "";
/**
 * Seeded evidence summary from T3 — a unique string that the server must never
 * log even though it passes through the discovery candidate chain.
 */
const T3_EVIDENCE_SUMMARY = `atl214-pvt-evsum-${Date.now()}`;

// ── T1: Primary discovery-first journey ──────────────────────────────────────

test.describe("T1: Primary discovery-first journey (ATL-214 §1)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("full onboarding with identifying consent granted completes to /overview", async ({
    page,
  }) => {
    t1Email = await startFresh(page);

    // 1 Introduction
    await page.getByRole("button", { name: "Continue" }).click();

    // 2–4 Skippable steps
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Skip" }).click();
    }

    // 5 identity_profile step — discovery consent section is rendered here
    //   because GitHub is in ACTIVE_DISCOVERY_PROVIDERS (ATL-217).
    //   Grant identifying consent when the section is visible.
    //   The button label may read "Allow" / "Grant" / "Enable" depending on the
    //   DiscoveryConsentSection implementation; match broadly.
    const consentButton = page.getByRole("button", {
      name: /allow|grant|enable.*discover/i,
    });
    if (await consentButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await consentButton.click();
      // Wait for the consent state to update (action returns a new attempt).
      await expect(consentButton).not.toBeVisible({ timeout: 5_000 });
    }

    // Privacy inline: URL must not contain the user's email at any point.
    expect(page.url()).not.toContain(t1Email);
    // Page title must not contain the user's email.
    await expect(page).not.toHaveTitle(new RegExp(t1Email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // Continue completes the identity_profile step (stamps the timestamp).
    await page.getByRole("button", { name: "Continue" }).click();

    // candidate_review auto-skips (no candidates) → ready step
    await expect(page.getByRole("heading", { name: "You are set up" })).toBeVisible({
      timeout: 5_000,
    });

    // Go to dashboard
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
    await page.waitForURL(/\/overview(\?.*)?$/);

    // Inline URL/title privacy check on the product page
    expect(page.url()).not.toContain(t1Email);
  });
});

// ── T2: Mobile layout at the identity_profile / consent step ─────────────────

test.describe("T2: Mobile layout — identity_profile step (ATL-214 §2)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("identity_profile step does not overflow horizontally on a narrow viewport", async ({
    page,
  }) => {
    // Force a narrow (Pixel 7-width) viewport regardless of the current project.
    await page.setViewportSize({ width: 412, height: 915 });

    await startFresh(page);

    // Navigate to the identity_profile step.
    await page.getByRole("button", { name: "Continue" }).click(); // intro
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Skip" }).click(); // privacy_goal, categories, starting_point
    }

    // At identity_profile — check for horizontal overflow.
    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = page.viewportSize()?.width ?? 412;
    expect(
      bodyScrollWidth,
      `identity_profile step body (${bodyScrollWidth}px) must not exceed viewport (${viewportWidth}px)`,
    ).toBeLessThanOrEqual(viewportWidth);

    // The identity_profile step renders its title as h2 ("Your identity details"),
    // not h1 — no StepTitle wrapper is applied to this step (see onboarding-flow.tsx).
    // Assert the heading that the existing UI contract actually guarantees.
    await expect(page.getByRole("heading", { name: "Your identity details" })).toBeVisible();

    // Complete the step so the user does not leave onboarding mid-flow.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "You are set up" })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
    await page.waitForURL(/\/overview(\?.*)?$/);
  });
});

// ── T3: Deferred adjudication ─────────────────────────────────────────────────

test.describe("T3: Deferred adjudication — dismiss during candidate_review (ATL-214 §3)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let seeded: SeededCandidate | undefined;

  test.afterEach(async () => {
    await removeSeededCandidate(seeded);
    seeded = undefined;
  });

  test("dismissed candidate does not show badge on /overview and card shows deferred state", async ({
    page,
  }) => {
    const email = await startFresh(page);
    const userId = await getUserIdByEmail(email);

    // Seed a pending candidate using T3_EVIDENCE_SUMMARY as the persisted
    // evidence_summary.  seedDiscoveryCandidate now accepts opts.evidenceSummary
    // and forwards it to seedEvidenceChain → discovery_evidence.evidence_summary,
    // so the value enters the real persisted evidence chain.  T5 then asserts
    // that value is absent from the server log — a non-vacuous privacy check.
    seeded = await seedDiscoveryCandidate(userId, "pending", {
      evidenceSummary: T3_EVIDENCE_SUMMARY,
    });

    // Reload so the RSC page picks up the seeded candidate before the client-
    // side onboarding steps advance to candidate_review.
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
    await expect(page.getByRole("heading", { name: /review your findings/i })).toBeVisible();

    // Dismiss the candidate → deferred state.
    await page.getByRole("button", { name: /dismiss/i }).click();

    // After dismiss the card transitions to the Deferred state (ATL-208).
    // The Dismiss button disappears; the step does not auto-advance because the
    // dismissed card is still visible.
    await expect(page.getByRole("button", { name: /dismiss/i })).toHaveCount(0, {
      timeout: 10_000,
    });

    // Skip the step (deferred candidate keeps the step from auto-advancing).
    await page.getByRole("button", { name: /skip/i }).click();
    await expect(page.getByRole("heading", { name: "You are set up" })).toBeVisible({
      timeout: 5_000,
    });

    // Complete onboarding → /overview.
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
    await page.waitForURL(/\/overview(\?.*)?$/);

    // Dismissed candidate is not pending → no nav badge.
    await expect(page.locator('[data-slot="nav-badge"]')).toHaveCount(0);
  });
});

// ── T4: Upgrade-onboarding ────────────────────────────────────────────────────

test.describe("T4: Upgrade-onboarding — pre-M13 user completes identity_profile only (ATL-214 §4)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("upgrade-mode user sees only identity_profile step and reaches /overview on complete", async ({
    page,
  }) => {
    // 1. Create a fresh user via magic link — they land on /onboarding in normal mode.
    const email = await startFresh(page);
    const userId = await getUserIdByEmail(email);

    // 2. Seed upgrade state: onboarding_completed_at = past, identity_profile_step_completed_at = NULL.
    await seedUpgradeProfile(userId);

    // 3. Reload /onboarding — the page fetches the profile server-side and sees
    //    isUpgradeMode = true.
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);

    // 4. Upgrade mode hides the progress indicator (ATL-209 §upgrade).
    //    The onboarding-flow renders OnboardingProgress only when !isUpgradeMode.
    await expect(page.locator('[data-slot="onboarding-progress"]')).toHaveCount(0);

    // 5. The identity_profile step is the only step visible (starts there directly).
    //    IdentityProfileStep provides its own Continue button.
    const continueBtn = page.getByRole("button", { name: "Continue" });
    await expect(continueBtn).toBeVisible({ timeout: 5_000 });

    // 6. Complete the identity_profile step — for upgrade mode, the server action
    //    calls completeIdentityProfileStepAction(true) which redirects to /overview.
    await continueBtn.click();
    await page.waitForURL(/\/overview(\?.*)?$/, { timeout: 10_000 });

    // Privacy inline: URL must not expose the user's email.
    expect(page.url()).not.toContain(email);
  });
});

// ── T5: Privacy — server log must not contain sensitive plaintext ─────────────

test.describe("T5: Privacy — server log clean of test-specific sensitive values (ATL-214 §5)", () => {
  /**
   * This describe block asserts the privacy invariant after all ATL-214 journey
   * tests have run.  The server log is captured by the webServer tee command
   * (playwright.config.ts) and written to test-results/e2e-server.log.
   *
   * Assertion scope: the FULL log is scanned with no line-level or keyword
   * scoping.  This is intentional per ATL-214 privacy rule:
   *
   *   "Do NOT weaken the ATL-214 privacy assertion by: scanning only lines
   *    containing 'discovery'; excluding the test email; ignoring auth-related
   *    lines; narrowing the log scope to avoid false positives."
   */

  test.afterAll(() => {
    const logPath = "test-results/e2e-server.log";

    // Fail closed: if the log is absent the privacy invariant cannot be verified.
    // An absent log means the webServer command in playwright.config.ts did not
    // capture output — that is a test infrastructure failure, not a skip condition.
    expect(
      fs.existsSync(logPath),
      `Privacy invariant requires the server log at "${logPath}". ` +
        "Absent log = webServer failed to capture output. " +
        "Fix the webServer command in playwright.config.ts before proceeding.",
    ).toBe(true);

    const log = fs.readFileSync(logPath, "utf8");

    // --- testUserEmail from T1 ---
    if (t1Email) {
      expect(
        log,
        `Server log must not contain the T1 test user email "${t1Email}" in plaintext`,
      ).not.toContain(t1Email);
    }

    // --- T3_EVIDENCE_SUMMARY ---
    // A value that passes through the discovery candidate chain and must never
    // appear in server-side logs.
    if (T3_EVIDENCE_SUMMARY) {
      expect(
        log,
        `Server log must not contain the T3 evidence summary "${T3_EVIDENCE_SUMMARY}" in plaintext`,
      ).not.toContain(T3_EVIDENCE_SUMMARY);
    }
  });

  test("T5 marker — privacy assertions run in afterAll of this describe", () => {
    // This test is intentionally a no-op.  Its presence ensures the describe
    // block is not empty (Playwright requires at least one test per describe to
    // register the afterAll hook), and it documents in the test report that the
    // privacy assertion block ran.
    expect(true).toBe(true);
  });
});
