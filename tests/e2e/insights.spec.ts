import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";
import {
  removeSeededAsset,
  seedSensitiveAsset,
  type SeededFinding,
} from "./support/finding-fixture";

/* ------------------------------------------------------------------------- *
 * Fixture-owned findings (task #130).
 *
 * Every finding-dependent test below used to take `.first()` from the list on a
 * shared account, and every one of them could therefore act on a record another
 * spec — or the other Playwright worker — owned. That produced two observed
 * failure shapes in the full suite: a panel whose finding had been closed by
 * someone else between the list render and the RSC navigation, so
 * `FindingResolve` returned null and `resolve-start` never existed; and a panel
 * whose finding had been deleted, so `getFindingDetail` answered NOT_FOUND and
 * no panel rendered at all.
 *
 * Each test now seeds its own asset through the product's own form, gives it one
 * high-sensitivity data category, and lets the real `FindingsEngine` derive
 * R-003 — the one rule with no time dependency. **Nothing is written to
 * `privacy_findings`.** Teardown deletes the asset; the category and the derived
 * finding cascade with it.
 *
 * The skip guards are gone. They existed because the suite could not create a
 * finding; it can now, so "no findings" is a failure rather than a reason to
 * skip.
 * ------------------------------------------------------------------------- */

/** The fixture for the current test. Seeded per test, never shared. */
let seeded: SeededFinding;

/** Seeds a finding this test owns, and removes it afterwards. */
function useOwnFinding(label: string) {
  test.beforeEach(async ({ page }) => {
    seeded = await seedSensitiveAsset(page, label);
  });

  test.afterEach(async () => {
    await removeSeededAsset(seeded);
  });
}

/** This test's own card, never `.first()` of everything on the page. */
const seededCard = (page: Page): Locator =>
  page.locator("[data-slot='finding-card']").filter({ hasText: seeded.serviceName }).first();

const seededDetailsLink = (page: Page): Locator =>
  seededCard(page).locator("[data-slot='finding-details-link']");

/**
 * ATL-040 — the Insights page in a real browser.
 *
 * ## What this spec can and cannot assert
 *
 * Findings are written by the engine (ATL-101), not by any UI, and the rules
 * that fire depend on records aging — R-001 needs an asset unreviewed for
 * months. A browser test cannot conjure one without seeding the database behind
 * the product's back, which would prove the fixture works rather than the page.
 *
 * So this spec asserts what is true for a signed-in user whichever way that
 * goes: the four views exist and are reachable by pointer and by keyboard, the
 * current view is announced rather than merely coloured, each view renders
 * *something* — its own empty state or a list of cards — and every view passes
 * axe. Card field rendering and per-view empty-state copy are asserted in
 * `src/features/findings/finding-list.test.tsx`, where both states can be
 * produced directly.
 *
 * Runs in all three viewport projects: the view navigation must work at 320px
 * as well as 1280.
 */

const VIEWS = [
  { id: "recommended", label: "Recommended", href: "/insights" },
  { id: "all", label: "All", href: "/insights?view=all" },
  { id: "resolved", label: "Resolved", href: "/insights?view=resolved" },
  { id: "dismissed", label: "Dismissed", href: "/insights?view=dismissed" },
] as const;

/** The view's content: either the finding list or the empty state standing in for it. */
function results(page: Page) {
  return page.locator("[data-slot='finding-list'], [data-slot='empty-state']");
}

/**
 * The page header's own description, from `PageLayout` (`page-layout.tsx:65`).
 *
 * Scoped rather than matched by text: the empty states carry the same "does not
 * scan the internet" sentence by design — it is the explanation of where
 * findings come from, and it belongs in both places — so a bare `getByText`
 * resolved to two elements and tripped strict mode. This names the one the test
 * is about.
 */
function pageDescription(page: Page) {
  return page.locator("[data-slot='page-description']");
}

test.describe("the Insights page", () => {
  test("opens on Recommended and offers all four views", async ({ page }) => {
    await page.goto("/insights");

    await expect(page.getByRole("heading", { level: 1, name: "Privacy Insights" })).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Finding views" });
    for (const view of VIEWS) {
      await expect(nav.getByRole("link", { name: view.label })).toBeVisible();
    }

    // Frontend §8 lists Recommended first, and it is what the bare route shows.
    await expect(nav.getByRole("link", { name: "Recommended" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("never claims Atlas scanned anything", async ({ page }) => {
    // CLAUDE.md: do not claim Atlas scans or deletes data. The page description
    // is the sentence most likely to drift into implying it.
    await page.goto("/insights");

    await expect(pageDescription(page)).toContainText(/does not scan the internet/i);
  });

  for (const view of VIEWS) {
    test(`shows the ${view.label} view and passes axe`, async ({ page }) => {
      await page.goto(view.href);

      const nav = page.getByRole("navigation", { name: "Finding views" });
      await expect(nav.getByRole("link", { name: view.label })).toHaveAttribute(
        "aria-current",
        "page",
      );

      // Something is rendered: a list of findings, or this view's own empty
      // state. A view that rendered neither would be a blank page.
      await expect(results(page).first()).toBeVisible();

      await expectNoAxeViolations(page);
    });
  }

  test("switches view by clicking, and the URL carries the state", async ({ page }) => {
    await page.goto("/insights");

    await page
      .getByRole("navigation", { name: "Finding views" })
      .getByRole("link", { name: "Dismissed" })
      .click();

    await page.waitForURL(/\/insights\?view=dismissed$/);
    await expect(
      page
        .getByRole("navigation", { name: "Finding views" })
        .getByRole("link", { name: "Dismissed" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("is reachable by keyboard", async ({ page }) => {
    /**
     * The views are links, not a Radix tablist, so the guarantee is plain tab
     * order and Enter — no arrow-key semantics are promised and none are
     * asserted. Focus is moved onto the link directly rather than tabbed to
     * from the top of the page: the number of stops before it differs between
     * the desktop sidebar and the mobile drawer, and counting them would test
     * the shell rather than this page.
     */
    await page.goto("/insights");

    const link = page
      .getByRole("navigation", { name: "Finding views" })
      .getByRole("link", { name: "Resolved" });

    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");

    await page.waitForURL(/\/insights\?view=resolved$/);
    await expect(results(page).first()).toBeVisible();
  });

  test("falls back to Recommended for an unknown view", async ({ page }) => {
    // A query string is user input; a typo must not produce an error page.
    await page.goto("/insights?view=not-a-view");

    await expect(
      page
        .getByRole("navigation", { name: "Finding views" })
        .getByRole("link", { name: "Recommended" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(results(page).first()).toBeVisible();
  });
});

/**
 * ATL-041 — the detail panel, and specifically the parts only a browser can
 * show: that the URL carries the open state, and that Back, Forward and a
 * refresh all agree with it. What the panel *renders* is asserted in
 * `src/features/findings/finding-detail.test.tsx`, where every rule type and
 * every evidence shape can be produced directly.
 *
 * The suite cannot create a finding — the engine writes those and its rules
 * depend on records aging (see the note at the top of this file) — so these
 * tests are written to be meaningful whether or not the signed-in user has one,
 * and skip the parts that need a real finding rather than pretending.
 */
test.describe("the finding detail panel", () => {
  const panel = (page: Page) => page.locator("[data-slot='finding-detail']");

  useOwnFinding("E2E Panel");

  /**
   * Opens **this test's own** finding.
   *
   * The three-step skip guard this replaces existed because the suite could not
   * create a finding, so "no cards" had to be told apart from "the read failed".
   * The fixture removes that ambiguity: a finding is guaranteed to exist, so the
   * page description assertion still catches a store failure via ATL-010's
   * boundary, and an absent card is now a real failure rather than a skip.
   *
   * Scoped by service name rather than `.first()`, so a card belonging to
   * another spec or the other worker can never be the one opened.
   */
  async function openPanel(page: Page): Promise<void> {
    // The page itself rendered: the ATL-010 boundary carries no description.
    await expect(page.locator("[data-slot='page-description']")).toBeVisible();

    await expect(seededDetailsLink(page)).toBeVisible();
    await seededDetailsLink(page).click();
    await page.waitForURL(/finding=/);
    await expect(panel(page)).toBeVisible();
  }

  test("a bad finding id neither errors nor confirms the id exists", async ({ page }) => {
    /**
     * The non-oracle rule, in the browser. `getFindingDetail` answers
     * `NOT_FOUND` for "no such finding" and "not yours" alike, and the page
     * renders the list with no panel — erroring would confirm that some id
     * names a real record.
     */
    await page.goto("/insights?finding=11111111-1111-4111-8111-111111111111");

    await expect(page.getByRole("heading", { level: 1, name: "Privacy Insights" })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(results(page).first()).toBeVisible();
  });

  test("a malformed finding id is refused the same way", async ({ page }) => {
    // A query string is user input; a typo must not produce an error page.
    await page.goto("/insights?finding=not-a-uuid");

    await expect(page.getByRole("heading", { level: 1, name: "Privacy Insights" })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });

  test("opens from the card, and Back and Forward follow the URL", async ({ page }) => {
    await page.goto("/insights?view=all");
    await openPanel(page);

    // Close: the id leaves the URL and the view survives.
    await page.getByRole("button", { name: /close/i }).click();
    await page.waitForURL((url) => !url.searchParams.has("finding"));
    await expect(panel(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("view")).toBe("all");

    // Back reopens what was just closed; Forward closes it again.
    await page.goBack();
    await expect(panel(page)).toBeVisible();
    await page.goForward();
    await expect(panel(page)).toHaveCount(0);
  });

  test("a refreshed deep link restores the panel", async ({ page }) => {
    await page.goto("/insights?view=all");
    await openPanel(page);

    const deepLink = page.url();

    await page.reload();

    // Open state is the URL, not component state, so a reload restores it.
    await expect(panel(page)).toBeVisible();
    expect(page.url()).toBe(deepLink);
  });

  test("closes on Escape and returns focus to the card", async ({ page }) => {
    await page.goto("/insights?view=all");
    await openPanel(page);

    // Radix supplies the focus trap and the return; this asserts the outcome.
    await page.keyboard.press("Escape");
    await page.waitForURL((url) => !url.searchParams.has("finding"));
    /** This test's own link — the one that opened the drawer, not the page's first. */
    await expect(seededDetailsLink(page)).toBeFocused();
  });

  test("has no axe violations while open", async ({ page }) => {
    await page.goto("/insights?view=all");
    await openPanel(page);

    await expectNoAxeViolations(page);
  });
});

/**
 * ATL-042 — the inline resolution flow, in a browser.
 *
 * Inside the ATL-041 drawer and never over it, so what a browser adds over the
 * component tests is the part they cannot show: that the flow is reachable from
 * a real panel, that Confirm actually writes, and that the list reflects it.
 *
 * Same data dependency and the same honest guard as the panel tests above — the
 * engine writes findings, and a browser cannot conjure one.
 */
test.describe("resolving a finding", () => {
  const panel = (page: Page) => page.locator("[data-slot='finding-detail']");

  useOwnFinding("E2E Resolve");

  /**
   * Opens **this test's own** open finding.
   *
   * The fixture's finding is newly derived and therefore open, so `resolve-start`
   * is guaranteed to render. Taking `.first()` here was what produced the
   * `resolve-start` timeouts in the full suite: it could land on a finding
   * another test had already resolved, and `FindingResolve` renders nothing for
   * a closed one.
   */
  async function openResolvable(page: Page): Promise<void> {
    await page.goto("/insights");
    await expect(page.locator("[data-slot='page-description']")).toBeVisible();

    await expect(seededDetailsLink(page)).toBeVisible();
    await seededDetailsLink(page).click();
    await expect(panel(page)).toBeVisible();
  }

  test("requires an action to be selected before confirming", async ({ page }) => {
    await openResolvable(page);

    // ATL-042: the action is *selected*, never defaulted.
    await page.locator("[data-slot='resolve-start']").click();
    await expect(page.locator("[data-slot='resolve-confirm']")).toBeDisabled();

    await page.getByRole("radio", { name: /reviewed the service/i }).check();
    await expect(page.locator("[data-slot='resolve-confirm']")).toBeEnabled();
  });

  test("shows the chosen action before it is submitted", async ({ page }) => {
    await openResolvable(page);

    await page.locator("[data-slot='resolve-start']").click();
    await page.getByRole("radio", { name: /closed the account/i }).check();

    await expect(page.locator("[data-slot='resolve-summary']")).toContainText(
      "You are recording: I closed the account",
    );
  });

  test("records the resolution and says what was recorded", async ({ page }) => {
    await openResolvable(page);

    await page.locator("[data-slot='resolve-start']").click();
    await page.getByRole("radio", { name: /reviewed the service/i }).check();
    await page.locator("[data-slot='resolve-confirm']").click();

    await expect(page.locator("[data-slot='resolve-result']")).toContainText(
      "Recorded as: I reviewed the service",
    );
    // No error surfaced alongside a success.
    await expect(page.locator("[data-slot='resolve-error']")).toHaveCount(0);
  });

  test("the resolved finding leaves Recommended and appears under Resolved", async ({ page }) => {
    await openResolvable(page);

    const title = await panel(page).getByRole("heading").first().textContent();

    await page.locator("[data-slot='resolve-start']").click();
    await page.getByRole("radio", { name: /reviewed the service/i }).check();
    await page.locator("[data-slot='resolve-confirm']").click();
    await expect(page.locator("[data-slot='resolve-result']")).toBeVisible();

    // Recommended answers "what next", so a resolved finding is no longer one.
    await page.goto("/insights?view=resolved");
    await expect(page.getByText(title ?? "", { exact: false }).first()).toBeVisible();
  });

  test("can be abandoned without resolving anything", async ({ page }) => {
    await openResolvable(page);

    await page.locator("[data-slot='resolve-start']").click();
    await page.getByRole("radio", { name: /reviewed the service/i }).check();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.locator("[data-slot='resolve-start']")).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
  });

  test("offers Ask Atlas as a live control", async ({ page }) => {
    // Rewritten by ATL-053, which built the assistant and enabled this control.
    // It previously asserted `[data-action='ask-atlas']` was disabled, which was
    // right while the panel did not exist; the deferred-affordance markup is
    // gone, so the selector no longer exists either. Dismiss left this assertion
    // in ATL-043 for the same reason — a deferred control becoming a real one.
    await openResolvable(page);

    await expect(panel(page).locator("[data-slot='assistant-ask']")).toBeEnabled();
  });

  test("has no axe violations while choosing", async ({ page }) => {
    await openResolvable(page);

    await page.locator("[data-slot='resolve-start']").click();
    await expect(page.getByRole("radio").first()).toBeVisible();

    await expectNoAxeViolations(page);
  });
});

/**
 * ATL-043 — dismissing a finding, and undoing it.
 *
 * The three things only a browser can settle: that the flow is reachable from a
 * real panel, that Confirm actually writes, and that the finding moves into the
 * Dismissed view and comes back out again.
 *
 * Same data dependency and the same honest guard as every panel test in this
 * file — a skip means the user genuinely has no findings, proven by the
 * successful empty state being visible, not by cards merely being absent.
 */
test.describe("dismissing a finding", () => {
  const panel = (page: Page) => page.locator("[data-slot='finding-detail']");

  useOwnFinding("E2E Dismiss");

  /**
   * Opens **this test's own** open finding.
   *
   * Scoping also removes the other failure this helper produced in the full
   * suite: `.first()` could resolve a card whose finding had since been deleted,
   * so `getFindingDetail` answered NOT_FOUND and no panel rendered at all.
   */
  async function openDismissable(page: Page): Promise<void> {
    await page.goto("/insights");
    await expect(page.locator("[data-slot='page-description']")).toBeVisible();

    await expect(seededDetailsLink(page)).toBeVisible();
    await seededDetailsLink(page).click();
    await expect(panel(page)).toBeVisible();
  }

  test("can be confirmed without choosing a reason", async ({ page }) => {
    // Frontend §5.4 makes the reason optional; Confirm is live from the start.
    await openDismissable(page);

    await page.locator("[data-slot='dismiss-start']").click();

    await expect(page.locator("[data-slot='dismiss-confirm']")).toBeEnabled();
    await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
  });

  test("says the score will not improve, before the user confirms", async ({ page }) => {
    // ADR-004 keeps the deduction; OQ-04 made that a rule. Silence here would
    // let a user dismiss expecting a reward.
    await openDismissable(page);

    await page.locator("[data-slot='dismiss-start']").click();

    await expect(page.locator("[data-slot='dismiss-score-note']")).toContainText(
      "does not improve your privacy score",
    );
  });

  test("offers no 'incorrect' reason", async ({ page }) => {
    // OQ-04: a disputed finding is answered by correcting the record, and that
    // path is a separate ticket. Offering it here would be the wrong promise.
    await openDismissable(page);

    await page.locator("[data-slot='dismiss-start']").click();

    await expect(page.getByRole("radio")).toHaveCount(2);
    await expect(page.getByRole("radio", { name: /incorrect|is wrong/i })).toHaveCount(0);
  });

  test("dismisses, then offers undo", async ({ page }) => {
    await openDismissable(page);

    await page.locator("[data-slot='dismiss-start']").click();
    await page.getByRole("radio", { name: /not relevant to me/i }).check();
    await page.locator("[data-slot='dismiss-confirm']").click();

    await expect(page.locator("[data-slot='dismiss-restore']")).toBeVisible();
    await expect(page.locator("[data-slot='restore-confirm']")).toBeEnabled();
    await expect(page.locator("[data-slot='dismiss-error']")).toHaveCount(0);
  });

  test("the dismissed finding leaves Recommended and appears under Dismissed", async ({ page }) => {
    await openDismissable(page);

    const title = await panel(page).getByRole("heading").first().textContent();

    await page.locator("[data-slot='dismiss-start']").click();
    await page.locator("[data-slot='dismiss-confirm']").click();
    await expect(page.locator("[data-slot='dismiss-restore']")).toBeVisible();

    await page.goto("/insights?view=dismissed");
    await expect(page.getByText(title ?? "", { exact: false }).first()).toBeVisible();
  });

  test("undo returns it to the open views", async ({ page }) => {
    await openDismissable(page);

    const title = await panel(page).getByRole("heading").first().textContent();

    await page.locator("[data-slot='dismiss-start']").click();
    await page.locator("[data-slot='dismiss-confirm']").click();
    await expect(page.locator("[data-slot='restore-confirm']")).toBeVisible();

    await page.locator("[data-slot='restore-confirm']").click();
    await expect(page.locator("[data-slot='dismiss-start']")).toBeVisible();

    await page.goto("/insights?view=all");
    await expect(page.getByText(title ?? "", { exact: false }).first()).toBeVisible();
  });

  test("can be abandoned without dismissing anything", async ({ page }) => {
    await openDismissable(page);

    await page.locator("[data-slot='dismiss-start']").click();
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.locator("[data-slot='dismiss-start']")).toBeVisible();
    await expect(page.locator("[data-slot='dismiss-form']")).toHaveCount(0);
  });

  test("has no axe violations while choosing a reason", async ({ page }) => {
    await openDismissable(page);

    await page.locator("[data-slot='dismiss-start']").click();
    await expect(page.getByRole("radio").first()).toBeVisible();

    await expectNoAxeViolations(page);
  });
});
