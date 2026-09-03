import { expect, test as setup } from "@playwright/test";
import { waitForConfirmationLink } from "./support/mailbox";
import { STORAGE_STATE } from "../auth-state";

/**
 * Establishes an authenticated session for the E2E suite (ATL-012 support).
 *
 * Every product route has required a verified server-side session since ATL-012.
 * The shell specs navigate to `/overview`, so without a session the middleware
 * redirects them to `/sign-in` and there is nothing to assert. This produces the
 * session once and saves it for the browser projects to reuse.
 *
 * ## It drives the real flow
 *
 * No cookie is forged and no session is injected. The setup fills in the actual
 * sign-in form, waits for the actual email, follows the actual link, and lets
 * the actual callback exchange the code — so it exercises ATL-011's magic-link
 * issuance, ATL-014's form, and ATL-012's protection end to end. A fixture that
 * hand-built a session cookie would pass while the sign-in flow was broken,
 * which is the failure mode worth avoiding.
 *
 * The address is fresh per run: sign-in and sign-up are one operation
 * (ATL-011), so a first-time address exercises account creation too, and no run
 * depends on state left by a previous one.
 */

setup("authenticate through the sign-in flow", async ({ page }) => {
  const email = `e2e-${Date.now()}-${process.pid}@example.test`;

  await page.goto("/sign-in");

  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: /email me a sign-in link/i }).click();

  /**
   * The neutral confirmation from ATL-014. Asserted before reading the mailbox
   * so a failure here points at the form rather than at delivery.
   *
   * Matched on its text rather than `getByRole("status")`: the sign-in page
   * renders a second status region when it carries a `reason` parameter, and a
   * role query would then trip Playwright's strict mode for reasons unrelated
   * to what this is checking.
   */
  await expect(page.getByText("Check your email")).toBeVisible();

  const confirmationLink = await waitForConfirmationLink(email);

  // Navigating in the same context matters: the PKCE code verifier lives in a
  // cookie this browser received when the form was submitted, and the callback
  // needs it to exchange the code.
  await page.goto(confirmationLink);

  /**
   * Onboarding runs first for a new account (ATL-016).
   *
   * The callback targets `/overview`, but the product layout redirects a user
   * with no `onboarding_completed_at` into the flow. Completing it here means
   * the saved session represents a **set-up** user, which is what every other
   * spec is actually about — the shell, the tokens, the product surfaces. A
   * spec that had to click through onboarding before asserting on the sidebar
   * would be testing this flow by accident, in every file.
   *
   * The flow itself is covered deliberately in `onboarding.spec.ts`, which
   * signs in its own fresh user rather than reusing this state.
   */
  await page.waitForURL(/\/(overview|onboarding)(\?.*)?$/);

  if (new URL(page.url()).pathname === "/onboarding") {
    // Straight through: every skippable question is skipped, which is the
    // shortest path and leaves the profile in its default state.
    // Introduction → Continue
    await page.getByRole("button", { name: "Continue" }).click();
    // privacy_goal → categories → starting_point: all skippable
    for (let step = 0; step < 3; step++) {
      await page.getByRole("button", { name: "Skip" }).click();
    }
    // identity_profile (ATL-209): mandatory step, stamps identity_profile_step_completed_at
    await page.getByRole("button", { name: "Continue" }).click();
    // ready → dashboard
    await page.getByRole("button", { name: "Go to my dashboard" }).click();
  }

  // Reaching /overview proves the session is real (ATL-012) and that onboarding
  // no longer intercepts.
  await page.waitForURL(/\/overview(\?.*)?$/);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
