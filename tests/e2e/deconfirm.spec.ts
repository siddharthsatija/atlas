import { expect, test } from "@playwright/test";
import {
  getUserIdByEmail,
  seedConfirmedDiscoveryAsset,
  removeSeededDiscoveryAsset,
  type SeededDiscoveryAsset,
} from "./support/discovery-fixture";

/**
 * ATL-211 — DeconfirmPanel on the asset detail page, E2E coverage.
 *
 * ## What only a browser can prove here
 *
 * The unit suite for DeconfirmPanel covers the component's render contract and
 * the COPY constants. These specs prove the things that only a real browser
 * round-trip can settle:
 *
 *   1. Render condition: the panel appears when the asset is a confirmed
 *      discovery candidate (sourceType === "discovery", candidateId non-null,
 *      deletedAt === null).
 *   2. The trigger button opens the inline confirmation dialog.
 *   3. "Keep it" (Cancel) closes the dialog without a mutation — the panel
 *      is still there after cancelling.
 *   4. "Remove" (Confirm) submits the form, the Server Action deconfirms the
 *      asset, and the panel is no longer present on the now-soft-deleted asset.
 *   5. Hidden identity inputs (candidateId, assetId) are NOT present as
 *      accessible form fields — the server derives them from session + URL.
 *
 * ## Fixture
 *
 * `seedConfirmedDiscoveryAsset` inserts evidence + candidate, then calls the
 * `confirm_discovery_candidate` Postgres RPC to atomically create the linked
 * asset. Cleanup in afterEach deletes all three rows.
 *
 * ## Session
 *
 * Uses the shared storageState (a set-up user) so the test can navigate
 * directly to /assets/:id without replaying onboarding.
 */

let seeded: SeededDiscoveryAsset;

// The shared session is a set-up user whose email we need for the service-role
// lookup. The auth.setup.ts saves an e2e-…@example.test address to storage; we
// derive the user id from the stored cookies instead via the Supabase
// auth.getUser() approach — but that requires a browser context. A simpler
// approach: sign in a fresh user per test and use their id for seeding.
//
// To keep things tidy, each test signs in fresh so that the seeded asset
// belongs to the authenticated user (required for the asset-detail page to
// render it, and for the deconfirm action to pass the user-scoped guard).

test.use({ storageState: { cookies: [], origins: [] } });

import { waitForConfirmationLink } from "./support/mailbox";
import type { Page } from "@playwright/test";

async function signInFresh(page: Page): Promise<string> {
  const email = `dc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: /email me a sign-in link/i }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  await page.goto(await waitForConfirmationLink(email));
  await page.waitForURL(/\/(overview|onboarding)(\?.*)?$/);

  // Complete onboarding (fastest path — no candidates for fresh user).
  if (new URL(page.url()).pathname === "/onboarding") {
    await page.getByRole("button", { name: "Continue" }).click(); // intro
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Skip" }).click(); // privacy_goal, categories, starting_point
    }
    await page.getByRole("button", { name: "Continue" }).click(); // identity_profile
    // candidate_review auto-skips (no seeded candidates at this point).
    await page.getByRole("button", { name: "Go to my dashboard" }).click(); // ready
    await page.waitForURL(/\/overview(\?.*)?$/);
  }

  return email;
}

// ── 1. Render condition ───────────────────────────────────────────────────────

test.describe("DeconfirmPanel — render condition", () => {
  test("panel appears on a confirmed discovery asset", async ({ page }) => {
    const email = await signInFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedConfirmedDiscoveryAsset(userId);

    try {
      await page.goto(`/assets/${seeded.assetId}`);
      await expect(page.locator("[data-slot='deconfirm-panel']")).toBeVisible();
      await expect(page.getByRole("button", { name: /remove from my services/i })).toBeVisible();
    } finally {
      await removeSeededDiscoveryAsset(seeded);
    }
  });
});

// ── 2. Dialog opens ───────────────────────────────────────────────────────────

test.describe("DeconfirmPanel — trigger opens confirmation dialog", () => {
  test("clicking 'Remove from my services' reveals the dialog heading", async ({ page }) => {
    const email = await signInFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedConfirmedDiscoveryAsset(userId);

    try {
      await page.goto(`/assets/${seeded.assetId}`);
      await page.getByRole("button", { name: /remove from my services/i }).click();

      await expect(page.getByRole("heading", { name: /remove this service\?/i })).toBeVisible();
      await expect(page.getByRole("button", { name: /^remove$/i })).toBeVisible();
      await expect(page.getByRole("button", { name: /keep it/i })).toBeVisible();
    } finally {
      await removeSeededDiscoveryAsset(seeded);
    }
  });
});

// ── 3. Cancel — no mutation ───────────────────────────────────────────────────

test.describe("DeconfirmPanel — cancel does not mutate", () => {
  test("'Keep it' closes the dialog and panel is still present", async ({ page }) => {
    const email = await signInFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedConfirmedDiscoveryAsset(userId);

    try {
      await page.goto(`/assets/${seeded.assetId}`);
      await page.getByRole("button", { name: /remove from my services/i }).click();
      await expect(page.getByRole("heading", { name: /remove this service\?/i })).toBeVisible();

      await page.getByRole("button", { name: /keep it/i }).click();

      // Dialog heading is gone.
      await expect(page.getByRole("heading", { name: /remove this service\?/i })).toHaveCount(0);
      // Panel itself is still present — no mutation occurred.
      await expect(page.locator("[data-slot='deconfirm-panel']")).toBeVisible();
      await expect(page.getByRole("button", { name: /remove from my services/i })).toBeVisible();
    } finally {
      await removeSeededDiscoveryAsset(seeded);
    }
  });
});

// ── 4. Confirm — deconfirm succeeds ──────────────────────────────────────────

test.describe("DeconfirmPanel — confirm deconfirms the asset", () => {
  test("clicking Remove soft-deletes the asset and panel disappears", async ({ page }) => {
    const email = await signInFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedConfirmedDiscoveryAsset(userId);

    try {
      await page.goto(`/assets/${seeded.assetId}`);
      await page.getByRole("button", { name: /remove from my services/i }).click();
      await expect(page.getByRole("heading", { name: /remove this service\?/i })).toBeVisible();

      await page.getByRole("button", { name: /^remove$/i }).click();

      // The Server Action completes; revalidateAssetViews triggers RSC re-fetch.
      // Panel should disappear because deletedAt is now set.
      await expect(page.locator("[data-slot='deconfirm-panel']")).toHaveCount(0, {
        timeout: 10_000,
      });
      // Trigger button gone too.
      await expect(page.getByRole("button", { name: /remove from my services/i })).toHaveCount(0);
    } finally {
      // Cleanup: the fixture helper hard-deletes the asset even if soft-deleted.
      await removeSeededDiscoveryAsset(seeded);
    }
  });
});

// ── 5. Hidden identity inputs absent ─────────────────────────────────────────

test.describe("DeconfirmPanel — no accessible identity inputs", () => {
  test("candidateId and assetId are not exposed as labelled form fields", async ({ page }) => {
    const email = await signInFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedConfirmedDiscoveryAsset(userId);

    try {
      await page.goto(`/assets/${seeded.assetId}`);

      // Open the panel's dialog to expose all its DOM.
      await page.getByRole("button", { name: /remove from my services/i }).click();
      await expect(page.getByRole("heading", { name: /remove this service\?/i })).toBeVisible();

      // The candidateId and assetId must not be accessible form fields —
      // they are bound server-side via .bind(null, candidateId, assetId).
      await expect(page.getByLabel(/candidateId/i)).toHaveCount(0);
      await expect(page.getByLabel(/assetId/i)).toHaveCount(0);
    } finally {
      await removeSeededDiscoveryAsset(seeded);
    }
  });
});

// ── RSC / runtime regression ──────────────────────────────────────────────────

test.describe("DeconfirmPanel — no RSC serialization or hydration errors", () => {
  test("no console errors appear on a confirmed discovery asset detail page", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    const email = await signInFresh(page);
    const userId = await getUserIdByEmail(email);
    seeded = await seedConfirmedDiscoveryAsset(userId);

    try {
      await page.goto(`/assets/${seeded.assetId}`);
      await expect(page.locator("[data-slot='deconfirm-panel']")).toBeVisible();

      const serialisationErrors = errors.filter(
        (e) => /hydrat/i.test(e) || /serializ/i.test(e) || /react.*error/i.test(e),
      );
      expect(
        serialisationErrors,
        `Unexpected runtime errors: ${serialisationErrors.join("; ")}`,
      ).toHaveLength(0);
    } finally {
      await removeSeededDiscoveryAsset(seeded);
    }
  });
});
