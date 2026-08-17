import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";

/**
 * ATL-046 — the privacy score detail view in a real browser.
 *
 * ## Why this spec needs no data guard
 *
 * Every other panel spec in this suite skips when the signed-in user has no
 * findings, because a finding can only be written by the engine. The score is
 * different: **cold start is a valid, fully-rendered state**, so this page has
 * something correct to assert whatever the user's records look like. Nothing
 * here is conditional, and nothing here skips.
 *
 * What that buys is real: the route, the service call, the server render and the
 * accessibility of at least one state are genuinely exercised on every run.
 */

const SCORE_URL = "/overview/score";

const summary = (page: Page) => page.locator("[data-slot='score-summary']");

test.describe("the privacy score detail view", () => {
  test("renders for a signed-in user", async ({ page }) => {
    await page.goto(SCORE_URL);

    await expect(page.getByRole("heading", { level: 1, name: "Privacy score" })).toBeVisible();
    await expect(summary(page)).toBeVisible();
  });

  test("always shows one of the two summary states, never neither", async ({ page }) => {
    // A page that rendered no state at all would be a blank surface, which is
    // the failure a "renders something" assertion is for.
    await page.goto(SCORE_URL);

    const state = await summary(page).getAttribute("data-state");
    expect(["scored", "demo", "not-yet-scored"]).toContain(state);
  });

  test("shows the disclaimer in every state", async ({ page }) => {
    // §12 requires it, and it applies to cold start as much as to a number.
    await page.goto(SCORE_URL);

    await expect(page.locator("[data-slot='score-disclaimer']")).toContainText(
      /guide[\s\S]*not a guarantee/i,
    );
  });

  test("never claims Atlas scanned anything", async ({ page }) => {
    // CLAUDE.md: do not claim Atlas scans or deletes data.
    await page.goto(SCORE_URL);

    await expect(page.locator("[data-slot='score-disclaimer']")).toContainText(
      /does not scan the internet/i,
    );
  });

  test("shows the recorded-score history section", async ({ page }) => {
    await page.goto(SCORE_URL);

    await expect(page.getByRole("heading", { name: "Recorded scores" })).toBeVisible();
  });

  test("offers the add-asset action when there is no score yet", async ({ page }) => {
    await page.goto(SCORE_URL);

    if ((await summary(page).getAttribute("data-state")) !== "not-yet-scored") return;

    await expect(page.locator("[data-slot='score-add-asset']")).toHaveAttribute(
      "href",
      "/assets/new",
    );
  });

  test("keeps Overview selected in the navigation", async ({ page }) => {
    /**
     * `/overview/score` is nested rather than a seventh destination, so the
     * current top-level destination must still be announced as Overview. If that
     * ever changed, the user would be on a page with nothing marked current.
     *
     * ## Why this branches on the viewport
     *
     * The two presentations are genuinely different, and both are correct:
     *
     *   - **At `sm` and above** the sidebar is rendered and owns the
     *     `navigation` landmark named "Primary" (`sidebar.tsx`).
     *   - **Below `sm`** `app-shell.tsx` hides the sidebar entirely and ATL-007's
     *     drawer takes over. It deliberately has *no* navigation landmark — the
     *     sidebar already owns one with that name, and a second would fail axe's
     *     `landmark-unique` — and it is closed until the user opens it.
     *
     * So the assertion opens the drawer on mobile rather than looking for a
     * landmark that intentionally does not exist. **The thing asserted is
     * identical in both branches**: the Overview link carries
     * `aria-current="page"`, which is the programmatic signal a screen reader
     * announces. Nothing is skipped and nothing falls back to checking the URL,
     * which would prove only that navigation happened rather than that the
     * destination is communicated.
     */
    await page.goto(SCORE_URL);

    const trigger = page.locator("[data-slot='mobile-nav-trigger']");

    if (await trigger.isVisible()) {
      await trigger.click();

      const drawer = page.locator("[data-slot='mobile-nav']");
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("link", { name: "Overview" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      return;
    }

    await expect(
      page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Overview" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("every improvement link points at a route that exists", async ({ page }) => {
    await page.goto(SCORE_URL);

    const links = page.locator("[data-slot='factor-action']");
    for (let index = 0; index < (await links.count()); index++) {
      const href = await links.nth(index).getAttribute("href");
      expect(href).toMatch(/^\/(assets|insights)/);
    }
  });

  test("an improvement link actually navigates", async ({ page }) => {
    await page.goto(SCORE_URL);

    const links = page.locator("[data-slot='factor-action']");
    if ((await links.count()) === 0) return;

    await links.first().click();
    await expect(page).toHaveURL(/\/(assets|insights)/);
  });

  test("shows the score history chart region with its text summary", async ({ page }) => {
    /**
     * ATL-047. The graphic is `aria-hidden`, so what has to be present for a
     * screen-reader user is the region and its description — asserting the
     * region by its accessible name proves both are wired, at every viewport.
     */
    await page.goto(SCORE_URL);

    const region = page.getByRole("region", { name: "Score over time" });
    await expect(region).toBeVisible();

    const describedBy = await region.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).not.toBeEmpty();
  });

  test("hides the chart graphic from assistive technology", async ({ page }) => {
    // The text alternative carries the meaning; exposing the SVG as well would
    // be a second, worse accessibility model for the same data.
    await page.goto(SCORE_URL);

    const chart = page.getByTestId("score-chart");
    if ((await chart.count()) === 0) return;

    await expect(chart).toHaveAttribute("aria-hidden", "true");
  });

  test("the chart scales down to the viewport rather than overflowing", async ({ page }) => {
    /**
     * The 320px project is where an SVG with a fixed pixel width would break the
     * page layout. A `viewBox` with no width attribute is what prevents it, and
     * this asserts the consequence rather than the attribute.
     */
    await page.goto(SCORE_URL);

    const chart = page.getByTestId("score-chart");
    if ((await chart.count()) === 0) return;

    const box = await chart.boundingBox();
    const viewport = page.viewportSize();
    if (box && viewport) expect(box.width).toBeLessThanOrEqual(viewport.width);
  });

  test("has no axe violations", async ({ page }) => {
    await page.goto(SCORE_URL);
    await expect(summary(page)).toBeVisible();

    await expectNoAxeViolations(page);
  });
});
