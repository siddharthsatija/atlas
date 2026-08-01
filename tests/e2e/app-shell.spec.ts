import { expect, test } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";

/**
 * ATL-005 — application shell.
 *
 * Covers the acceptance criteria that need a real browser: responsive layout at
 * the frontend §21 breakpoints, keyboard traversal, and route-level axe checks.
 * Component-level structure is asserted in `src/components/layout/app-shell.test.tsx`.
 */

const PRIMARY_DESTINATIONS = [
  "Overview",
  "Digital Assets",
  "Privacy Insights",
  "Requests",
  "Activity",
  "Archive",
  "Settings",
] as const;

test.describe("application shell", () => {
  test("renders the shell landmarks on a product route", async ({ page }) => {
    await page.goto("/overview");

    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    // Exactly one main and one h1 per page (frontend §20).
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("top bar contains the controls required by §4", async ({ page }) => {
    await page.goto("/overview");
    for (const label of ["Search", "Notifications", "Ask Atlas"]) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }
  });

  test("navigates between every primary destination", async ({ page }) => {
    await page.goto("/overview");

    for (const name of PRIMARY_DESTINATIONS) {
      await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name }).click();
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name }),
      ).toHaveAttribute("aria-current", "page");
    }
  });

  test("skip link is the first focusable control and reaches main @a11y", async ({ page }) => {
    await page.goto("/overview");

    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });

  test("every navigation destination is reachable by keyboard alone @a11y", async ({ page }) => {
    await page.goto("/overview");

    const reached = new Set<string>();
    // Bounded traversal: the shell exposes far fewer than 40 focusable controls.
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      const name = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
      if (PRIMARY_DESTINATIONS.includes(name as (typeof PRIMARY_DESTINATIONS)[number])) {
        reached.add(name);
      }
      if (reached.size === PRIMARY_DESTINATIONS.length) break;
    }

    expect([...reached].sort()).toEqual([...PRIMARY_DESTINATIONS].sort());
  });

  test("disabled top-bar triggers are not keyboard traps @a11y", async ({ page }) => {
    await page.goto("/overview");
    // They are present but unavailable until ATL-072/073, ATL-108 and ATL-053.
    for (const label of ["Search", "Notifications", "Ask Atlas"]) {
      await expect(page.getByRole("button", { name: label })).toBeDisabled();
    }
  });

  test.describe("responsive layout at the §21 breakpoints", () => {
    test("large (1024–1439): full sidebar with visible labels", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/overview");

      const nav = page.getByRole("navigation", { name: "Primary" });
      await expect(nav).toBeVisible();
      await expect(nav.getByText("Digital Assets", { exact: true })).toBeVisible();
    });

    test("extra large (≥1440): content stays within the max width", async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1000 });
      await page.goto("/overview");

      const width = await page
        .getByRole("heading", { level: 1 })
        .locator("xpath=ancestor::div[1]")
        .evaluate((el) => el.getBoundingClientRect().width);
      // ~1440px max content width plus gutters (frontend §2).
      expect(width).toBeLessThanOrEqual(1440);
    });

    test("medium (640–1023): sidebar renders as an icon rail", async ({ page }) => {
      await page.setViewportSize({ width: 800, height: 900 });
      await page.goto("/overview");

      const nav = page.getByRole("navigation", { name: "Primary" });
      await expect(nav).toBeVisible();
      // Rail width per §3 (72–80px).
      const width = await nav.evaluate((el) => el.getBoundingClientRect().width);
      expect(width).toBeGreaterThanOrEqual(72);
      expect(width).toBeLessThanOrEqual(80);
      // Labels remain in the accessibility tree even when visually hidden.
      await expect(nav.getByRole("link", { name: "Digital Assets" })).toBeAttached();
    });

    test("small (<640): sidebar is hidden and content is single column", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto("/overview");

      // The mobile drawer is ATL-007; §3 forbids a compressed rail on mobile, so
      // the sidebar is hidden rather than shrunk.
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    });

    test("no horizontal overflow at 320px @a11y", async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto("/overview");

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflows).toBe(false);
    });
  });

  test.describe("accessibility @a11y", () => {
    for (const path of ["/overview", "/assets", "/settings"]) {
      test(`no axe violations on ${path}`, async ({ page }) => {
        await page.goto(path);
        await expectNoAxeViolations(page);
      });
    }
  });
});
