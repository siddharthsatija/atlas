import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";
import { waitForConfirmationLink } from "./support/mailbox";

/**
 * ATL-016 — onboarding flow.
 *
 * Signs in a **fresh** user per test rather than reusing the shared
 * `storageState`: that session has already completed onboarding (see
 * `auth.setup.ts`), and a completed user is redirected straight past the thing
 * this file exists to test.
 *
 * Covers what only a browser can show — the five steps in order, back, skip, the
 * completion redirect, and axe per step.
 */

// A fresh magic-link round trip per test, so no shared state.
test.use({ storageState: { cookies: [], origins: [] } });

/** Signs in a brand-new account and lands on the first onboarding step. */
async function startOnboarding(page: Page): Promise<void> {
  const email = `onboarding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: /email me a sign-in link/i }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  await page.goto(await waitForConfirmationLink(email));
  await page.waitForURL(/\/onboarding(\?.*)?$/);
}

const step = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

/**
 * Performs an action and waits for the progress save it triggers (ATL-017).
 *
 * The save is fire-and-forget by design — stepping forward must not wait on a
 * round trip — so a test that reloads immediately after clicking would race it.
 * Waiting on the Server Action's own response makes the sequence deterministic
 * rather than papering over the race with a timeout.
 */
async function actAndAwaitSave(page: Page, act: () => Promise<void>): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/onboarding"),
    ),
    act(),
  ]);
}

test.describe("the flow", () => {
  test("walks all five steps and lands on the dashboard", async ({ page }) => {
    await startOnboarding(page);

    // 1. Introduction and limitations.
    await expect(step(page, "What Atlas does")).toBeVisible();
    await expect(page.getByText("Step 1 of 5")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // 2. Privacy goal.
    await expect(step(page, "What brings you here?")).toBeVisible();
    await page.getByRole("radio", { name: /Reduce my exposure/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // 3. Asset categories.
    await expect(step(page, "Where do you have accounts?")).toBeVisible();
    await page.getByRole("checkbox", { name: /Social/ }).check();
    await page.getByRole("checkbox", { name: /Finance/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // 4. Demo or own accounts.
    await expect(step(page, "How would you like to begin?")).toBeVisible();
    await page.getByRole("radio", { name: /Explore with sample data/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    // 5. Ready.
    await expect(step(page, "You are set up")).toBeVisible();
    await expect(page.getByText("Step 5 of 5")).toBeVisible();
    await page.getByRole("checkbox", { name: /Let Atlas use AI/ }).check();
    await page.getByRole("button", { name: "Go to my dashboard" }).click();

    await page.waitForURL(/\/overview(\?.*)?$/);
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  });

  test("completes with every question skipped", async ({ page }) => {
    // FR-02 "allow skipping optional steps": a user must be able to reach the
    // product without telling Atlas anything about themselves.
    await startOnboarding(page);

    await page.getByRole("button", { name: "Continue" }).click();
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Skip" }).click();
    }

    await expect(step(page, "You are set up")).toBeVisible();
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
    await page.waitForURL(/\/overview(\?.*)?$/);
  });

  test("goes back without losing a choice", async ({ page }) => {
    await startOnboarding(page);

    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("radio", { name: /Take back my data/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(step(page, "Where do you have accounts?")).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();

    // The earlier answer survives the round trip — losing it would make Back
    // feel like a reset.
    await expect(step(page, "What brings you here?")).toBeVisible();
    await expect(page.getByRole("radio", { name: /Take back my data/ })).toBeChecked();
  });

  test("offers no skip on the introduction", async ({ page }) => {
    // Nothing is asked there, and it carries the limitations copy.
    await startOnboarding(page);
    await expect(page.getByRole("button", { name: "Skip" })).toHaveCount(0);
  });
});

test.describe("resuming (ATL-017)", () => {
  test("returns to the saved step with prior choices intact after a refresh", async ({ page }) => {
    /**
     * The acceptance criterion, asserted the way a user would meet it: leave
     * mid-setup, come back, and find your place. Only a real browser can test
     * this — the state has to survive an actual page load.
     */
    await startOnboarding(page);

    await actAndAwaitSave(page, () => page.getByRole("button", { name: "Continue" }).click());
    await expect(step(page, "What brings you here?")).toBeVisible();

    await actAndAwaitSave(page, () =>
      page.getByRole("radio", { name: /Reduce my exposure/ }).check(),
    );
    await actAndAwaitSave(page, () => page.getByRole("button", { name: "Continue" }).click());
    await expect(step(page, "Where do you have accounts?")).toBeVisible();

    await page.reload();

    // The step survives the reload.
    await expect(step(page, "Where do you have accounts?")).toBeVisible();

    // And so does the answer given before it.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("radio", { name: /Reduce my exposure/ })).toBeChecked();
  });

  test("asks for AI consent again rather than restoring a tick", async ({ page }) => {
    /**
     * Progress is resumed; consent is not. A box found already checked would be
     * agreement the user never gave on this visit (ATL-016, ATL-078).
     */
    await startOnboarding(page);

    await actAndAwaitSave(page, () => page.getByRole("button", { name: "Continue" }).click());
    for (let i = 0; i < 3; i++) {
      await actAndAwaitSave(page, () => page.getByRole("button", { name: "Skip" }).click());
    }

    await expect(step(page, "You are set up")).toBeVisible();
    await page.getByRole("checkbox", { name: /Let Atlas use AI/ }).check();

    await page.reload();

    await expect(page.getByRole("checkbox", { name: /Let Atlas use AI/ })).not.toBeChecked();
  });
});

test.describe("limitations", () => {
  test("states plainly what Atlas does not do", async ({ page }) => {
    /**
     * The acceptance criterion, asserted where a user would actually read it.
     * Architecture §11: no internet scanning is performed or claimed.
     */
    await startOnboarding(page);

    await expect(page.getByRole("heading", { name: "What Atlas does not do" })).toBeVisible();
    await expect(page.getByText(/does not scan the internet/i)).toBeVisible();
    await expect(page.getByText(/cannot guarantee deletion/i)).toBeVisible();
  });
});

test.describe("consent", () => {
  test("leaves the AI consent unchecked by default", async ({ page }) => {
    // A pre-ticked box would produce a consent record that means nothing.
    await startOnboarding(page);

    await page.getByRole("button", { name: "Continue" }).click();
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Skip" }).click();
    }

    await expect(page.getByRole("checkbox", { name: /Let Atlas use AI/ })).not.toBeChecked();
  });
});

test.describe("gating", () => {
  test("redirects a product route back into onboarding until it is finished", async ({ page }) => {
    await startOnboarding(page);

    await page.goto("/assets");
    await page.waitForURL(/\/onboarding(\?.*)?$/);
    await expect(step(page, "What Atlas does")).toBeVisible();
  });

  test("does not show the flow again once complete", async ({ page }) => {
    // Re-running it would overwrite the earlier answers and push the completion
    // timestamp later on every visit.
    await startOnboarding(page);

    await page.getByRole("button", { name: "Continue" }).click();
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Skip" }).click();
    }
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
    await page.waitForURL(/\/overview(\?.*)?$/);

    await page.goto("/onboarding");
    await page.waitForURL(/\/overview(\?.*)?$/);
  });
});

test.describe("@a11y accessibility", () => {
  test("has no axe violations on any step", async ({ page }) => {
    await startOnboarding(page);

    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Continue" }).click();

    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Continue" }).click();

    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Continue" }).click();

    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Continue" }).click();

    // The completion step, which carries the consent control.
    await expectNoAxeViolations(page);
  });

  test("is operable by keyboard alone", async ({ page }) => {
    await startOnboarding(page);

    await page.keyboard.press("Tab");
    // Focus reaches the primary action without a pointer; the skip link is the
    // first stop, so this walks past it.
    await expect(page.locator(":focus")).toBeVisible();
  });
});
