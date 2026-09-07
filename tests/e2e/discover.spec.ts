import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForConfirmationLink } from "./support/mailbox";
import {
  getUserIdByEmail,
  seedDiscoveryCandidate,
  seedRunWithStatus,
  seedCompletedRunWithCandidate,
  removeSeededCandidate,
  removeSeededRun,
  type SeededCandidate,
} from "./support/discovery-fixture";

/**
 * ATL-212 — Discover surface, targeted E2E coverage.
 *
 * ## What only a browser can prove here
 *
 *   1. PRIMARY NAV — Discover link present, href correct, navigates.
 *   2. PENDING-CANDIDATE BADGE — badge appears/disappears based on countPending.
 *   3. RUN STATUS DISPLAY — every DB run_status maps to the correct UI label.
 *   4. RUN SCOPING — latest run governs status; older runs do not bleed through.
 *   5. OVERVIEW INDICATOR — run-in-progress banner present/absent correctly.
 *   6. SETTINGS ENTRY POINTS — both Manage links reach /settings (not a 404).
 *   7. RESPONSIVE / A11Y — no horizontal overflow, h1 present, nav landmark.
 *
 * ## Auth strategy
 *
 * Nav structure (1, 6, 7) uses the stored session from auth.setup.ts — those
 * tests depend on structure, not on user-specific data, so a shared user keeps
 * them fast. All data-sensitive groups (2–5) sign in fresh users so no state
 * bleeds between cases.
 *
 * ## Seed → navigate → assert
 *
 * RSC pages fetch from the DB at render time. The correct sequence is:
 *   1. sign in fresh → complete onboarding → land on /overview
 *   2. seed rows via service-role client
 *   3. page.goto(target) — RSC picks up the seeded rows
 *   4. assert
 *   5. afterEach removes seeded rows
 *
 * For tests that exercise adjudication actions (§2b), the ATL-211 pattern is
 * used: startFresh → seed → page.reload() → walkToReview() → action → assert.
 */

// ── Mobile layout helpers ─────────────────────────────────────────────────────
// Mirrors the pattern from app-shell.spec.ts (ATL-005). Below the Tailwind `sm`
// breakpoint the sidebar is CSS-hidden and navigation is accessible through a
// modal drawer instead.

/** Tailwind `sm` breakpoint; below this the sidebar is hidden and the drawer takes over. */
const SM_BREAKPOINT = 640;

/** True when the current viewport is below the sm breakpoint. */
const isMobileLayout = (page: Page) => (page.viewportSize()?.width ?? 0) < SM_BREAKPOINT;

/** The navigation drawer (mobile only). */
const drawerOf = (page: Page) => page.getByRole("dialog", { name: "Navigation" });

/**
 * Returns the interactive navigation surface for the current viewport.
 *
 * On desktop (≥sm): the Primary navigation landmark in the sidebar.
 * On mobile (<sm): opens the drawer and returns it so callers can query links
 * inside it without caring about the viewport.
 */
async function openNavigation(page: Page): Promise<Locator> {
  if (!isMobileLayout(page)) return page.getByRole("navigation", { name: "Primary" });

  const drawer = drawerOf(page);
  if (!(await drawer.isVisible())) {
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(drawer).toBeVisible();
  }
  return drawer;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Signs in a brand-new account and lands on /onboarding. Returns the email. */
async function startFresh(page: Page): Promise<string> {
  const email = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: /email me a sign-in link/i }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  await page.goto(await waitForConfirmationLink(email));
  await page.waitForURL(/\/onboarding(\?.*)?$/);
  return email;
}

/**
 * Completes onboarding with no candidates seeded (candidate_review auto-skips).
 * The caller must already be on /onboarding. Leaves the page on /overview.
 */
async function finishOnboarding(page: Page): Promise<void> {
  // 1 Introduction
  await page.getByRole("button", { name: "Continue" }).click();
  // 2–4 skippable steps (privacy_goal, categories, starting_point)
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Skip" }).click();
  }
  // 5 identity_profile — mandatory, stamps identity_profile_step_completed_at
  await page.getByRole("button", { name: "Continue" }).click();
  // candidate_review auto-skips when there are no candidates → ready step
  await expect(page.getByRole("heading", { name: "You are set up" })).toBeVisible({
    timeout: 5_000,
  });
  // ready → dashboard
  await page.getByRole("button", { name: "Go to my dashboard" }).click();
  await page.waitForURL(/\/overview(\?.*)?$/);
}

/**
 * Navigates from the first onboarding step to the candidate_review step via
 * client-side button clicks (steps 1 Introduction → 5 identity_profile).
 *
 * Reuses the ATL-211 pattern from candidate-review.spec.ts. The caller must
 * seed candidates BEFORE calling this function (then page.reload() so the RSC
 * page picks up the rows at load time).
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
  // 5 identity_profile — mandatory, Continue advances to candidate_review (step 6)
  await page.getByRole("button", { name: "Continue" }).click();
}

// ── 1. Primary nav ────────────────────────────────────────────────────────────

test.describe("Primary nav — Discover link (ATL-212 §1)", () => {
  // Stored auth from project config. Omitting test.use here inherits it.
  // Tests run in all three projects (chromium 1280px, mobile 412px,
  // small-viewport 320px). openNavigation handles the drawer on mobile.

  test("Discover link is present in the Primary navigation landmark", async ({ page }) => {
    await page.goto("/overview");
    const nav = await openNavigation(page);
    await expect(nav.getByRole("link", { name: /discover/i })).toBeAttached();
  });

  test("Discover link has href /discover", async ({ page }) => {
    await page.goto("/overview");
    const nav = await openNavigation(page);
    await expect(nav.getByRole("link", { name: /discover/i })).toHaveAttribute("href", "/discover");
  });

  test("clicking the Discover link navigates to /discover with h1 Discover", async ({ page }) => {
    await page.goto("/overview");
    const nav = await openNavigation(page);
    await nav.getByRole("link", { name: /discover/i }).click();
    // On mobile the drawer dismisses on route change (ATL-007).
    await page.waitForURL(/\/discover(\?.*)?$/);
    await expect(page.getByRole("heading", { level: 1, name: "Discover" })).toBeVisible();
  });
});

// ── 2. Pending-candidate nav badge (DB seed) ──────────────────────────────────

test.describe("Pending-candidate nav badge — DB seed (ATL-212 §2)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let email: string;
  let seeded: SeededCandidate | undefined;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    await finishOnboarding(page);
    // At /overview — fully onboarded, no candidates seeded yet.
  });

  test.afterEach(async () => {
    await removeSeededCandidate(seeded);
    seeded = undefined;
  });

  test("badge is absent when there are no pending candidates", async ({ page }) => {
    // No seed — newly onboarded user, countPending = 0.
    await expect(page.locator('[data-slot="nav-badge"]')).toHaveCount(0);
  });

  test("badge is attached to the DOM when a pending candidate exists", async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "pending");
    // Reload so the dynamically-rendered layout picks up the new countPending.
    await page.reload();
    await page.waitForURL(/\/overview(\?.*)?$/);
    // Badge is in the DOM (possibly CSS-hidden on mobile rail, but present).
    await expect(page.locator('[data-slot="nav-badge"]')).toBeAttached();
    await expect(page.locator('[aria-label="1 pending"]')).toBeAttached();
  });

  test("badge is absent when only dismissed candidates exist", async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "dismissed");
    await page.reload();
    await page.waitForURL(/\/overview(\?.*)?$/);
    await expect(page.locator('[data-slot="nav-badge"]')).toHaveCount(0);
  });

  test("badge is absent when only not_sure candidates exist", async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "not_sure");
    await page.reload();
    await page.waitForURL(/\/overview(\?.*)?$/);
    await expect(page.locator('[data-slot="nav-badge"]')).toHaveCount(0);
  });
});

// ── 2b. Badge — adjudication action transitions via onboarding UI ─────────────

test.describe("Badge — adjudication action transitions via onboarding UI (ATL-212 §2b)", () => {
  /**
   * These tests use the ATL-211 seed → reload → walkToReview pattern instead of
   * the shared finishOnboarding beforeEach, because:
   *
   *   1. finishOnboarding completes onboarding; a completed-onboarding user
   *      navigating to /onboarding is immediately redirected to /overview.
   *   2. The badge assertion requires a UI-driven confirm/reject so the Server
   *      Action fires revalidatePath("/discover") and updates countPending.
   *
   * Each test is fully self-contained with its own fresh user.
   */
  test.use({ storageState: { cookies: [], origins: [] } });

  let seeded: SeededCandidate | undefined;

  test.afterEach(async () => {
    // removeSeededCandidate safely handles already-deleted rows (e.g. if the
    // reject action cascade-deleted the candidate). The evidence/invocation/run
    // chain still needs explicit cleanup regardless.
    await removeSeededCandidate(seeded);
    seeded = undefined;
  });

  test("badge disappears after onboarding confirm action (confirm → product page)", async ({
    page,
  }) => {
    // ATL-211 pattern: fresh user → seed before walking → reload → walkToReview.
    const email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "pending");

    // Reload so the RSC page picks up the seeded candidate before client-side
    // onboarding steps advance to candidate_review.
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
    await expect(page.getByRole("heading", { name: /review your findings/i })).toBeVisible();

    // Confirm the candidate.
    await page.getByRole("button", { name: /confirm/i }).click();
    await expect(page.getByText(/confirmed/i)).toBeVisible({ timeout: 10_000 });

    // Skip remaining candidates → ready step.
    await page.getByRole("button", { name: /skip/i }).click();
    await expect(page.getByRole("heading", { name: "You are set up" })).toBeVisible();

    // Go to dashboard — RSC re-renders the layout; confirmed candidate is not
    // pending so countPending = 0 → badge absent.
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
    await page.waitForURL(/\/overview(\?.*)?$/);

    await expect(page.locator('[data-slot="nav-badge"]')).toHaveCount(0);
  });

  test("badge disappears after onboarding reject action (reject → product page)", async ({
    page,
  }) => {
    // ATL-211 pattern: fresh user → seed before walking → reload → walkToReview.
    const email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "pending");

    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
    await expect(page.getByRole("heading", { name: /review your findings/i })).toBeVisible();

    // Reject the candidate.
    await page.getByRole("button", { name: /reject/i }).click();

    // After rejecting the only pending candidate the step either auto-advances
    // (auto-skip useEffect sees 0 pending cards) or surfaces a Skip button.
    // Wait for whichever comes first, then ensure we reach the ready heading.
    const readyHeading = page.getByRole("heading", { name: "You are set up" });
    const skipBtn = page.getByRole("button", { name: /skip/i });
    await readyHeading.or(skipBtn).waitFor({ timeout: 10_000 });
    if (!(await readyHeading.isVisible())) {
      await skipBtn.click();
      await expect(readyHeading).toBeVisible({ timeout: 5_000 });
    }

    // Go to dashboard — rejected candidate is no longer pending → badge absent.
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
    await page.waitForURL(/\/overview(\?.*)?$/);

    await expect(page.locator('[data-slot="nav-badge"]')).toHaveCount(0);
  });

  test("badge disappears after onboarding dismiss action (dismiss → product page)", async ({
    page,
  }) => {
    // ATL-211 pattern: fresh user → seed before walking → reload → walkToReview.
    const email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "pending");

    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
    await expect(page.getByRole("heading", { name: /review your findings/i })).toBeVisible();

    // Dismiss the candidate — Server Action sets status to "dismissed".
    await page.getByRole("button", { name: /dismiss/i }).click();

    // After dismiss the card transitions to the Deferred state (ATL-208); the
    // step does not auto-advance because the card remains visible. Click Skip
    // to proceed to the ready step.
    await expect(page.getByRole("button", { name: /dismiss/i })).toHaveCount(0, {
      timeout: 10_000,
    });
    await page.getByRole("button", { name: /skip/i }).click();
    await expect(page.getByRole("heading", { name: "You are set up" })).toBeVisible();

    // Go to dashboard — dismissed candidate is not pending so countPending = 0
    // → badge absent without a manual reload.
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
    await page.waitForURL(/\/overview(\?.*)?$/);

    await expect(page.locator('[data-slot="nav-badge"]')).toHaveCount(0);
  });

  test("badge disappears after onboarding not-sure action (not sure → product page)", async ({
    page,
  }) => {
    // ATL-211 pattern: fresh user → seed before walking → reload → walkToReview.
    const email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "pending");

    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
    await expect(page.getByRole("heading", { name: /review your findings/i })).toBeVisible();

    // Click Not sure — Server Action sets status to "not_sure".
    await page.getByRole("button", { name: /not sure/i }).click();

    // After not-sure the card transitions to the Not sure state (ATL-208); the
    // step does not auto-advance because the card remains visible. Click Skip
    // to proceed to the ready step.
    await expect(page.getByRole("button", { name: /^not sure$/i })).toHaveCount(0, {
      timeout: 10_000,
    });
    await page.getByRole("button", { name: /skip/i }).click();
    await expect(page.getByRole("heading", { name: "You are set up" })).toBeVisible();

    // Go to dashboard — not_sure candidate is not pending so countPending = 0
    // → badge absent without a manual reload.
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
    await page.waitForURL(/\/overview(\?.*)?$/);

    await expect(page.locator('[data-slot="nav-badge"]')).toHaveCount(0);
  });
});

// ── 3. /discover run-status display ──────────────────────────────────────────

test.describe("/discover — run-status display (ATL-212 §3)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let email: string;
  let runId: string | undefined;
  let seeded: SeededCandidate | undefined;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    await finishOnboarding(page);
  });

  test.afterEach(async () => {
    await removeSeededRun(runId);
    runId = undefined;
    await removeSeededCandidate(seeded);
    seeded = undefined;
  });

  test("no-run panel is shown when the user has no discovery runs", async ({ page }) => {
    await page.goto("/discover");
    await expect(page.locator('[data-slot="no-run-panel"]')).toBeVisible();
  });

  test('DB pending → UI status badge "Running"', async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "pending"));
    await page.goto("/discover");
    await expect(
      page.locator('[data-slot="discovery-run-status-panel"][data-status="running"]'),
    ).toBeVisible();
  });

  test('DB running → UI status badge "Running"', async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "running"));
    await page.goto("/discover");
    await expect(
      page.locator('[data-slot="discovery-run-status-panel"][data-status="running"]'),
    ).toBeVisible();
  });

  test('DB completed + no candidates → UI status "No matches" (completed_zero)', async ({
    page,
  }) => {
    const userId = await getUserIdByEmail(email);
    // seedRunWithStatus("completed") creates a run with no chain → deriveCompletedStatus
    // short-circuits at hop 1 and returns completed_zero.
    ({ runId } = await seedRunWithStatus(userId, "completed"));
    await page.goto("/discover");
    await expect(
      page.locator('[data-slot="discovery-run-status-panel"][data-status="completed_zero"]'),
    ).toBeVisible();
  });

  test('DB completed + candidates → UI status "Completed" (completed_candidates)', async ({
    page,
  }) => {
    const userId = await getUserIdByEmail(email);
    // seedCompletedRunWithCandidate creates the full chain and promotes run to "completed".
    seeded = await seedCompletedRunWithCandidate(userId);
    // runId stays undefined — removeSeededCandidate(seeded) handles the run row too.
    await page.goto("/discover");
    await expect(
      page.locator('[data-slot="discovery-run-status-panel"][data-status="completed_candidates"]'),
    ).toBeVisible();
  });

  test('DB partial → UI status "Partial"', async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "partial"));
    await page.goto("/discover");
    await expect(
      page.locator('[data-slot="discovery-run-status-panel"][data-status="partial"]'),
    ).toBeVisible();
  });

  test('DB blocked → UI status "Blocked"', async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "blocked"));
    await page.goto("/discover");
    await expect(
      page.locator('[data-slot="discovery-run-status-panel"][data-status="blocked"]'),
    ).toBeVisible();
  });

  test('DB failed → UI status "Failed"', async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "failed"));
    await page.goto("/discover");
    await expect(
      page.locator('[data-slot="discovery-run-status-panel"][data-status="failed"]'),
    ).toBeVisible();
  });
});

// ── 4. Run scoping ────────────────────────────────────────────────────────────

test.describe("Run scoping — latest run governs status display (ATL-212 §4)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let email: string;
  let runBId: string | undefined;
  let seededA: SeededCandidate | undefined;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    await finishOnboarding(page);
  });

  test.afterEach(async () => {
    // Clean up in creation order (child → parent) to satisfy FK constraints.
    // Run B has no child rows; Run A's full chain is removed via removeSeededCandidate.
    await removeSeededRun(runBId);
    runBId = undefined;
    await removeSeededCandidate(seededA);
    seededA = undefined;
  });

  test("status reflects the latest run, not an older run that has candidates", async ({ page }) => {
    const userId = await getUserIdByEmail(email);

    // Run A (older): completed with a candidate chain → would show completed_candidates.
    seededA = await seedCompletedRunWithCandidate(userId);

    // Ensure created_at for Run B is strictly later.
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Run B (newer, latest): completed with no chain → resolves to completed_zero.
    ({ runId: runBId } = await seedRunWithStatus(userId, "completed"));

    await page.goto("/discover");

    // Latest run (Run B) governs — "No matches", not "Completed".
    await expect(
      page.locator('[data-slot="discovery-run-status-panel"][data-status="completed_zero"]'),
    ).toBeVisible();

    // Run A's status must NOT bleed through.
    await expect(
      page.locator('[data-slot="discovery-run-status-panel"][data-status="completed_candidates"]'),
    ).toHaveCount(0);
  });
});

// ── 5. Overview — run-in-progress indicator ───────────────────────────────────

test.describe("Overview — run-in-progress indicator (ATL-212 §5)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  let email: string;
  let runId: string | undefined;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    await finishOnboarding(page);
  });

  test.afterEach(async () => {
    await removeSeededRun(runId);
    runId = undefined;
  });

  test("indicator absent when no run exists", async ({ page }) => {
    await page.goto("/overview");
    await expect(page.locator('[data-slot="run-in-progress-indicator"]')).toHaveCount(0);
  });

  test("indicator visible when latest run is DB pending (maps to UI running)", async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "pending"));
    await page.goto("/overview");
    await expect(page.locator('[data-slot="run-in-progress-indicator"]')).toBeVisible();
  });

  test("indicator visible when latest run is DB running", async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "running"));
    await page.goto("/overview");
    await expect(page.locator('[data-slot="run-in-progress-indicator"]')).toBeVisible();
  });

  test("indicator absent for completed run with no candidates (completed_zero)", async ({
    page,
  }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "completed"));
    await page.goto("/overview");
    await expect(page.locator('[data-slot="run-in-progress-indicator"]')).toHaveCount(0);
  });

  test("indicator absent for partial run", async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "partial"));
    await page.goto("/overview");
    await expect(page.locator('[data-slot="run-in-progress-indicator"]')).toHaveCount(0);
  });

  test("indicator absent for failed run", async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "failed"));
    await page.goto("/overview");
    await expect(page.locator('[data-slot="run-in-progress-indicator"]')).toHaveCount(0);
  });

  test("indicator links to /discover", async ({ page }) => {
    const userId = await getUserIdByEmail(email);
    ({ runId } = await seedRunWithStatus(userId, "running"));
    await page.goto("/overview");
    const indicator = page.locator('[data-slot="run-in-progress-indicator"]');
    await expect(indicator.getByRole("link", { name: /view in discover/i })).toHaveAttribute(
      "href",
      "/discover",
    );
  });
});

// ── 6. Settings entry points ──────────────────────────────────────────────────

test.describe("Settings entry points on /discover (ATL-212 §6)", () => {
  // Stored auth — nav structure, no user data required.

  test("Identity Profile link navigates to /settings (not a 404 sub-route)", async ({ page }) => {
    await page.goto("/discover");
    await page.getByRole("link", { name: /identity profile/i }).click();
    await page.waitForURL(/\/settings(\?.*)?$/);
    // 200 — not a 404.
    await expect(page).not.toHaveURL(/404/);
  });

  test("Discovery consent & settings link navigates to /settings", async ({ page }) => {
    await page.goto("/discover");
    await page.getByRole("link", { name: /discovery consent/i }).click();
    await page.waitForURL(/\/settings(\?.*)?$/);
    await expect(page).not.toHaveURL(/404/);
  });
});

// ── 7. Responsive / a11y ──────────────────────────────────────────────────────

test.describe("Responsive and accessibility — /discover (ATL-212 §7)", () => {
  // Stored auth. This group runs in all three projects (chromium 1280px, mobile
  // 412px, small-viewport 320px) via the project config.

  test("page does not overflow horizontally", async ({ page }) => {
    await page.goto("/discover");
    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = page.viewportSize()?.width ?? 1280;
    expect(bodyScrollWidth).toBeLessThanOrEqual(viewportWidth);
  });

  test("page has an h1 heading Discover", async ({ page }) => {
    await page.goto("/discover");
    await expect(page.getByRole("heading", { level: 1, name: "Discover" })).toBeVisible();
  });

  test("Primary navigation is accessible on all viewports", async ({ page }) => {
    await page.goto("/discover");
    if (!isMobileLayout(page)) {
      // Desktop (≥sm): the Primary nav landmark is visible in the sidebar.
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    } else {
      // Mobile/small-viewport (<sm): sidebar is CSS-hidden. Navigation is accessible
      // through the mobile drawer, reachable via the trigger in the top bar.
      await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeVisible();
    }
  });

  test("Discover link carries aria-current=page when on /discover", async ({ page }) => {
    await page.goto("/discover");
    // openNavigation handles both desktop sidebar and mobile drawer.
    const nav = await openNavigation(page);
    // aria-current="page" is the programmatic selected state for the active link.
    await expect(nav.locator('[aria-current="page"][href="/discover"]')).toBeAttached();
  });
});
