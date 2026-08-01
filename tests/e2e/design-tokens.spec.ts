import { expect, test } from "@playwright/test";
import { COLOR_ROLES } from "../../src/config/design-tokens";
import { expectNoAxeViolations } from "../a11y-helpers";

/**
 * ATL-008 — token sheet visual snapshot in both modes.
 *
 * Complements `src/styles/token-sheet.test.ts`, which asserts the token *values*
 * and contrast ratios without a browser. This asserts what they actually render
 * to, catching regressions a value diff cannot: a broken `@theme` block, a
 * dark-mode override that never applies, a missing custom variant.
 *
 * Snapshots are written on first run (`--update-snapshots`) and reviewed in the PR.
 */

test.describe("design token sheet", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/design-tokens");
    await expect(page.getByRole("heading", { level: 1, name: "Design tokens" })).toBeVisible();
  });

  test("renders every semantic role", async ({ page }) => {
    // Count follows the shared COLOR_ROLES list so the sheet cannot silently drop one.
    await expect(page.getByTestId("color-roles").locator("li")).toHaveCount(COLOR_ROLES.length);
  });

  test("light mode snapshot", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page).toHaveScreenshot("token-sheet-light.png", { fullPage: true });
  });

  test("dark mode snapshot", async ({ page }) => {
    // next-themes toggles the `dark` class on <html>; drive it directly so the
    // snapshot does not depend on a settings control that does not exist yet.
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page).toHaveScreenshot("token-sheet-dark.png", { fullPage: true });
  });

  test("dark mode switches at the token layer @a11y", async ({ page }) => {
    const readBackground = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim(),
      );

    const light = await readBackground();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    const dark = await readBackground();

    // The variable itself changes — no component-level override involved.
    expect(light).not.toBe("");
    expect(dark).not.toBe("");
    expect(dark).not.toBe(light);
  });

  test("respects reduced motion @a11y", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const duration = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.transition = "opacity 200ms";
      document.body.append(probe);
      const value = getComputedStyle(probe).transitionDuration;
      probe.remove();
      return value;
    });
    // globals.css collapses transitions to ~0.01ms under reduced motion.
    expect(duration).not.toBe("0.2s");
  });

  test("has no accessibility violations @a11y", async ({ page }) => {
    await expectNoAxeViolations(page);
  });
});
