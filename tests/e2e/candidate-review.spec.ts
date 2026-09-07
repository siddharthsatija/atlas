import { expect, test, type Page } from "@playwright/test";
import { waitForConfirmationLink } from "./support/mailbox";
import {
  getUserIdByEmail,
  seedDiscoveryCandidate,
  seedAggregatorEvidence,
  removeSeededCandidate,
  getCandidateStatus,
  type SeededCandidate,
} from "./support/discovery-fixture";

/**
 * ATL-211 — candidate_review onboarding step, E2E coverage.
 *
 * ## What only a browser can prove here
 *
 * The unit suite (candidate-card.test.tsx) covers component rendering and
 * post-action state transitions in jsdom. These specs prove the things jsdom
 * cannot:
 *
 *   A. auto-skip fires when there is nothing to review (useEffect + router.push)
 *   B. pending candidates render all four adjudication buttons
 *   C. aggregator evidence renders info-only — no adjudication buttons
 *   D. dismissed candidates appear with the Deferred badge, no buttons
 *   E. not_sure candidates appear with the Not sure badge, no buttons
 *   F. "Skip for now" navigates to the ready step without mutating candidates
 *   G. refresh / resume: a seeded candidate survives a page reload and the
 *      step re-renders it correctly (RSC re-fetches on every load)
 *
 * ## Isolation
 *
 * Each test signs in as a brand-new user so no shared state bleeds between
 * cases. The `startFresh` helper returns the email so the fixture helpers can
 * look up the user's UUID via the service-role client.
 *
 * ## Seed → reload → walk
 *
 * The RSC page fetches candidates at load time (not at step-change time). The
 * correct sequence is:
 *   1. sign in → land on /onboarding
 *   2. seed candidates via service-role client
 *   3. page.reload() → RSC picks up the seeded rows
 *   4. walkToReview() — client-side navigation through steps 1–5
 *   5. assert on step 6 (candidate_review)
 */

// Fresh magic-link per test — storageState from auth.setup.ts has already
// completed onboarding and would skip straight past what we need to assert.
test.use({ storageState: { cookies: [], origins: [] } });

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Signs in a fresh account and returns { page, email } at the /onboarding URL. */
async function startFresh(page: Page): Promise<string> {
  const email = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: /email me a sign-in link/i }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  await page.goto(await waitForConfirmationLink(email));
  await page.waitForURL(/\/onboarding(\?.*)?$/);

  return email;
}

/**
 * Navigates from the first onboarding step to the candidate_review step via
 * client-side button clicks (steps 1 Introduction → 5 identity_profile).
 *
 * candidate_review (step 6) renders after identity_profile's Continue. For a
 * fresh user with no candidates, the step auto-skips — callers that want to
 * assert on the step must seed candidates before calling this function.
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

// ── Case A: auto-skip ─────────────────────────────────────────────────────────

test.describe("Case A — auto-skip when nothing to review", () => {
  test("advances straight to ready when there are no candidates or aggregator evidence", async ({
    page,
  }) => {
    await startFresh(page);
    // No seed — fresh user has nothing in discovery_candidates or discovery_evidence.
    await walkToReview(page);

    // candidate_review useEffect auto-advances to ready (step 7).
    await expect(page.getByRole("heading", { name: "You are set up" })).toBeVisible({
      timeout: 5_000,
    });

    // Step counter must show 7 of 7 (candidate_review is skipped, not counted as visited).
    await expect(page.getByText("Step 7 of 7")).toBeVisible();
  });
});

// ── Case B: pending candidate ─────────────────────────────────────────────────

test.describe("Case B — pending candidate renders all four buttons", () => {
  let seeded: SeededCandidate;
  let email: string;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "pending");
    // Reload so the RSC page picks up the seeded row.
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
  });

  test.afterEach(async () => {
    await removeSeededCandidate(seeded);
  });

  test("candidate_review step heading is visible", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /review your findings/i })).toBeVisible();
  });

  test("Confirm button is present and enabled", async ({ page }) => {
    await expect(page.getByRole("button", { name: /confirm/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /confirm/i })).toBeEnabled();
  });

  test("Reject button is present and enabled", async ({ page }) => {
    await expect(page.getByRole("button", { name: /reject/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /reject/i })).toBeEnabled();
  });

  test("Dismiss button is present and enabled", async ({ page }) => {
    await expect(page.getByRole("button", { name: /dismiss/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /dismiss/i })).toBeEnabled();
  });

  test("Not sure button is present and enabled", async ({ page }) => {
    await expect(page.getByRole("button", { name: /not sure/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /not sure/i })).toBeEnabled();
  });

  test("source identifier is shown as the card label", async ({ page }) => {
    // The seeded source_identifier starts with "fixture-source-".
    await expect(page.getByText(/fixture-source-/i)).toBeVisible();
  });

  test("no email address is rendered in plaintext (trust boundary)", async ({ page }) => {
    const content = await page.content();
    expect(content).not.toMatch(/@example\.test/);
  });
});

// ── Case C: aggregator-only ───────────────────────────────────────────────────

test.describe("Case C — aggregator evidence renders info-only", () => {
  let seeded: SeededCandidate;
  let email: string;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedAggregatorEvidence(userId);
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
  });

  test.afterEach(async () => {
    await removeSeededCandidate(seeded);
  });

  test("additional context section is visible", async ({ page }) => {
    await expect(page.getByText(/additional context/i)).toBeVisible();
  });

  test("no Confirm/Reject/Dismiss/Not sure buttons are shown", async ({ page }) => {
    await expect(page.getByRole("button", { name: /confirm/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /reject/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /dismiss/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /not sure/i })).toHaveCount(0);
  });

  test("step does NOT auto-skip — heading remains visible", async ({ page }) => {
    // Aggregator evidence is surfaced in the review step even though there
    // are no candidates, so the step must not auto-advance.
    await expect(page.getByRole("heading", { name: /review your findings/i })).toBeVisible();
  });
});

// ── Case D: dismissed candidate ───────────────────────────────────────────────

test.describe("Case D — dismissed candidate renders Deferred badge", () => {
  let seeded: SeededCandidate;
  let email: string;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "dismissed");
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
  });

  test.afterEach(async () => {
    await removeSeededCandidate(seeded);
  });

  test("Deferred badge is visible", async ({ page }) => {
    // Scope to the card to avoid matching the "Deferred" section heading.
    await expect(page.locator('[data-slot="candidate-card"]').getByText(/deferred/i)).toBeVisible();
  });

  test("no action buttons are shown (ATL-208)", async ({ page }) => {
    await expect(page.getByRole("button", { name: /confirm/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /reject/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /dismiss/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /not sure/i })).toHaveCount(0);
  });

  test("source identifier still renders", async ({ page }) => {
    await expect(page.getByText(/fixture-source-/i)).toBeVisible();
  });
});

// ── Case E: not_sure candidate ────────────────────────────────────────────────

test.describe("Case E — not_sure candidate renders Not sure badge", () => {
  let seeded: SeededCandidate;
  let email: string;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "not_sure");
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
  });

  test.afterEach(async () => {
    await removeSeededCandidate(seeded);
  });

  test("'Not sure' badge is visible", async ({ page }) => {
    // Scope to the card to avoid matching the "Not sure about these" section heading.
    await expect(page.locator('[data-slot="candidate-card"]').getByText(/not sure/i)).toBeVisible();
  });

  test("no action buttons are shown (ATL-208)", async ({ page }) => {
    await expect(page.getByRole("button", { name: /confirm/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /reject/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /dismiss/i })).toHaveCount(0);
    // "not sure" appears as badge text — filter to button role specifically
    await expect(page.getByRole("button", { name: /^not sure$/i })).toHaveCount(0);
  });
});

// ── Case F: skip-for-now ──────────────────────────────────────────────────────

test.describe("Case F — skip-for-now navigates to ready without mutation", () => {
  let seeded: SeededCandidate;
  let email: string;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "pending");
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
  });

  test.afterEach(async () => {
    await removeSeededCandidate(seeded);
  });

  test("Skip button is present on candidate_review", async ({ page }) => {
    await expect(page.getByRole("button", { name: /skip/i })).toBeVisible();
  });

  test("clicking Skip navigates to the ready step", async ({ page }) => {
    await page.getByRole("button", { name: /skip/i }).click();
    await expect(page.getByRole("heading", { name: "You are set up" })).toBeVisible();
    await expect(page.getByText("Step 7 of 7")).toBeVisible();
  });

  test("candidate status is still pending after skipping (no mutation)", async ({ page }) => {
    await page.getByRole("button", { name: /skip/i }).click();
    await expect(page.getByRole("heading", { name: "You are set up" })).toBeVisible();

    // Skip must not have mutated the candidate — verify the persisted DB state
    // via the service-role client rather than relying on UI navigation.
    const status = await getCandidateStatus(seeded.candidateId);
    expect(status).toBe("pending");
  });
});

// ── Case G: refresh / resume ──────────────────────────────────────────────────

test.describe("Case G — refresh resumes at candidate_review with candidates intact", () => {
  let seeded: SeededCandidate;
  let email: string;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "pending");
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
    // Confirm we are on candidate_review before the reload.
    await expect(page.getByRole("heading", { name: /review your findings/i })).toBeVisible();
  });

  test.afterEach(async () => {
    await removeSeededCandidate(seeded);
  });

  test("page.reload() keeps the user on candidate_review", async ({ page }) => {
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    // RSC re-fetches candidates on reload — the step reappears.
    await expect(page.getByRole("heading", { name: /review your findings/i })).toBeVisible();
  });

  test("seeded candidate is still visible after reload", async ({ page }) => {
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    // Anchor on the step heading first so the assertion does not race against
    // the RSC re-render that delivers candidate_review. On narrow viewports the
    // heading renders quickly and waitForURL resolves before the step is fully
    // hydrated; without this anchor the fixture-source text can be checked
    // while the page is still on identity_profile. This does not weaken the
    // candidate assertion — it ensures the page is actually on candidate_review
    // before looking for the candidate text.
    await expect(page.getByRole("heading", { name: /review your findings/i })).toBeVisible();
    await expect(page.getByText(/fixture-source-/i)).toBeVisible();
  });

  test("all four action buttons are present after reload", async ({ page }) => {
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await expect(page.getByRole("button", { name: /confirm/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /reject/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /dismiss/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /not sure/i })).toBeVisible();
  });
});

// ── Action transitions (browser-level) ───────────────────────────────────────
//
// The unit suite (candidate-card.test.tsx) already proves the useActionState
// state machine in jsdom (confirm → Confirmed badge, reject → unmount, etc.).
// The browser-level transition tests below cover just the critical-path confirm
// to verify that the Server Action round trip produces the correct outcome.
// Reject / dismiss / not_sure transitions are left to the unit suite to keep
// E2E teardown simple (confirmed candidates create asset rows that need cleanup).

test.describe("Action transition — confirm (server round trip)", () => {
  let seeded: SeededCandidate;
  let email: string;

  test.beforeEach(async ({ page }) => {
    email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedDiscoveryCandidate(userId, "pending");
    await page.reload();
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await walkToReview(page);
    await expect(page.getByRole("button", { name: /confirm/i })).toBeVisible();
  });

  test.afterEach(async () => {
    // The candidate is now confirmed — removeSeededCandidate cleans up the
    // evidence row; the linked asset must be deleted separately if created.
    // For now we delete the candidate and evidence; asset cleanup relies on
    // CASCADE or a separate admin delete.
    await removeSeededCandidate(seeded);
  });

  test("clicking Confirm shows Confirmed badge and View asset link", async ({ page }) => {
    await page.getByRole("button", { name: /confirm/i }).click();

    // Wait for the Server Action round trip.
    await expect(page.getByText(/confirmed/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("link", { name: /view asset/i })).toBeVisible();
  });

  test("after confirm, action buttons are gone (ATL-208)", async ({ page }) => {
    await page.getByRole("button", { name: /confirm/i }).click();
    await expect(page.getByText(/confirmed/i)).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole("button", { name: /confirm/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /reject/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /dismiss/i })).toHaveCount(0);
  });
});

// ── RSC / runtime regression ──────────────────────────────────────────────────

test.describe("RSC / runtime — no serialization or hydration errors", () => {
  test("no console errors appear on the candidate_review step (fresh user)", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    await startFresh(page);
    await walkToReview(page);

    // After auto-skip (no candidates), we land on ready — that is fine.
    // No console errors should have fired during the navigation.
    const serialisationErrors = errors.filter(
      (e) => /hydrat/i.test(e) || /serializ/i.test(e) || /react.*error/i.test(e),
    );
    expect(
      serialisationErrors,
      `Unexpected runtime errors: ${serialisationErrors.join("; ")}`,
    ).toHaveLength(0);
  });

  test("no console errors appear when candidate_review renders with a pending candidate", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    const email = await startFresh(page);
    const userId = await getUserIdByEmail(email);
    const seeded = await seedDiscoveryCandidate(userId, "pending");

    try {
      await page.reload();
      await page.waitForURL(/\/onboarding(\?.*)?$/);
      await walkToReview(page);
      await expect(page.getByRole("button", { name: /confirm/i })).toBeVisible();

      const serialisationErrors = errors.filter(
        (e) => /hydrat/i.test(e) || /serializ/i.test(e) || /react.*error/i.test(e),
      );
      expect(
        serialisationErrors,
        `Unexpected runtime errors: ${serialisationErrors.join("; ")}`,
      ).toHaveLength(0);
    } finally {
      await removeSeededCandidate(seeded);
    }
  });
});
