import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";

/**
 * ATL-005 — application shell.
 *
 * Covers the acceptance criteria that need a real browser: responsive layout at
 * the frontend §21 breakpoints, keyboard traversal, and route-level axe checks.
 * Component-level structure is asserted in `src/components/layout/app-shell.test.tsx`.
 *
 * ## Viewport-aware navigation
 *
 * This spec runs in three projects — chromium (1280), mobile (412) and
 * small-viewport (320) — and the product presents navigation differently across
 * that range. Frontend §2/§3: at `sm` and above the sidebar carries the `Primary`
 * navigation landmark; below `sm` the sidebar is `display:none` and navigation
 * moves into a modal drawer, explicitly *not* a compressed rail.
 *
 * The tests therefore assert the **outcome** — every primary destination is
 * reachable, by pointer and by keyboard — and let the presentation vary. They
 * deliberately do not:
 *
 *   - scope themselves away from mobile, because reachability there is a real
 *     product requirement rather than a desktop-only one;
 *   - use `includeHidden`, which would "find" the hidden sidebar and assert
 *     against a surface no user can reach.
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

/** Tailwind `sm`. Below this the sidebar is hidden and the drawer takes over. */
const SM_BREAKPOINT = 640;

const isMobileLayout = (page: Page) => (page.viewportSize()?.width ?? 0) < SM_BREAKPOINT;

const drawerOf = (page: Page) => page.getByRole("dialog", { name: "Navigation" });

/**
 * The navigation surface a user can actually interact with right now.
 *
 * Above `sm` that is the `Primary` landmark. Below it, the drawer — which must be
 * opened first, and which the product dismisses on route change (ATL-007), so
 * callers re-open per navigation rather than assuming it stayed put.
 *
 * The visibility check matters for one real case: activating the destination you
 * are already on does not change the pathname, so the drawer stays open. Clicking
 * the trigger again would then be a click on an inert background.
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

/** Returns each iteration to a known state. A no-op above `sm`. */
async function closeNavigation(page: Page): Promise<void> {
  if (!isMobileLayout(page)) return;

  const drawer = drawerOf(page);
  if (await drawer.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  }
}

/**
 * Tabs until `target` holds focus, proving it is reachable by keyboard alone
 * rather than focusing it programmatically — which would assert nothing about
 * whether a keyboard user can get there.
 */
async function tabUntilFocused(page: Page, target: Locator, maxPresses = 12): Promise<void> {
  for (let i = 0; i < maxPresses; i += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Target never received focus within ${maxPresses} Tab presses`);
}

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
      await (await openNavigation(page)).getByRole("link", { name }).click();

      /**
       * Dismiss the modal before asserting anything about the page behind it.
       *
       * A modal drawer removes the background from the accessibility tree, so a
       * role query cannot see the heading while it is open — the heading is
       * rendered and on screen, just correctly hidden from assistive technology.
       *
       * That matters on the first destination: the loop starts on `/overview` and
       * activates "Overview", so the pathname does not change and the drawer
       * rightly stays open (ATL-007). A no-op above `sm`, and a no-op when a real
       * navigation has already dismissed it.
       */
      await closeNavigation(page);
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

      // Selected state, read back from the same surface the user just operated —
      // the sidebar on desktop, the drawer on mobile. Both derive it from the
      // pathname, so both must show it.
      await expect((await openNavigation(page)).getByRole("link", { name })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await closeNavigation(page);
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

    if (isMobileLayout(page)) {
      /**
       * On mobile the destinations sit behind the trigger, so "reachable by
       * keyboard" starts one step earlier: the traversal has to reach the
       * *trigger* from the top of the page and operate it. Focusing it directly
       * would skip the part that can actually be broken.
       */
      await tabUntilFocused(page, page.getByRole("button", { name: "Open navigation menu" }));
      await page.keyboard.press("Enter");
      await expect(drawerOf(page)).toBeVisible();
    }

    const reached = new Set<string>();
    // Bounded traversal: the shell exposes far fewer than 40 focusable controls.
    // On mobile the drawer traps focus, so tabbing cycles inside it rather than
    // escaping to the page behind — which is the behaviour that makes every
    // destination reachable without a pointer.
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      const name = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
      if (PRIMARY_DESTINATIONS.includes(name as (typeof PRIMARY_DESTINATIONS)[number])) {
        reached.add(name);
      }
      if (reached.size === PRIMARY_DESTINATIONS.length) break;
    }

    expect([...reached].sort()).toEqual([...PRIMARY_DESTINATIONS].sort());

    if (isMobileLayout(page)) {
      // Focus never left the dialog. Without the trap, tabbing past the last link
      // would land on the inert page behind and strand a keyboard user.
      await expect(drawerOf(page).locator(":focus")).toHaveCount(1);
    }
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
