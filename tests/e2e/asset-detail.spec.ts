import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";
import {
  removeSeededAsset,
  seedSensitiveAsset,
  type SeededFinding,
} from "./support/finding-fixture";

/**
 * ATL-034 — the asset detail page, in a real browser.
 *
 * ## What only a browser can settle
 *
 * The unit suites prove the sections' contents, the header's controls and the
 * page's wiring. None of them can prove the two things this file exists for:
 * that the **native disclosure** actually opens from the keyboard — jsdom
 * implements neither Tab-to-`<summary>` nor Enter-to-toggle — and that the
 * account identifier's plaintext is absent from what the server really sent.
 *
 * ## Every precondition is produced by the product
 *
 * `seedSensitiveAsset` creates an asset through the create form, attaches one
 * high-sensitivity category (the single step with no UI), re-saves through the
 * edit form, and lets the real `FindingsEngine` derive R-003. No
 * `privacy_findings` row is ever written by a fixture.
 *
 * The same principle governs the harder states below: a **permission** is added
 * through the edit page's own form, and a finding is moved out of `open` through
 * the Insights panel's own resolve flow. Nothing is inserted to manufacture a
 * state the product can reach on its own.
 *
 * ## Runs at 1280, Pixel 7 and 320
 *
 * The disclosure state is asserted identically in all three projects, which is
 * how "initial state does not depend on the viewport" is proven: the same
 * expectations pass at every width because there is one DOM and one server-
 * rendered `open` attribute.
 */

/** Frontend §7, sections 2–8. Section 1 is the always-visible identity header. */
const SECTION_ORDER = [
  "Overview",
  "Information held",
  "Permissions",
  "Findings",
  "Requests",
  "Activity",
  "Notes",
];

/**
 * Every section's `<details>`, in DOM order.
 *
 * A **descendant** selector, not `> details`. Each section is wrapped in a
 * `Card`, so the disclosure is a grandchild of the container:
 *
 *   `div[data-slot=asset-detail-sections] > div.card > details[data-slot=…]`
 *
 * The child combinator matched nothing and the position assertion below failed
 * in all three projects while the page was rendering correctly — the section
 * order test, which uses a descendant selector for its headings, passed
 * throughout. Matching the real DOM rather than reshaping the markup keeps the
 * `Card` where the design system put it.
 */
const sections = (page: Page) => page.locator("[data-slot='asset-detail-sections'] details");
const section = (page: Page, slot: string) => page.locator(`[data-slot='asset-section-${slot}']`);
const headerActions = (page: Page) => page.locator("[data-slot='asset-header-actions']");
const summaryOf = (target: Locator) => target.locator("> summary");

/**
 * A section's content region, excluding its `<summary>`.
 *
 * Used wherever a test counts controls. `<summary>`'s computed role is not the
 * same across engines — Chromium exposes a disclosure widget, and role queries
 * can pick it up as a button — so counting roles across the whole `<details>`
 * would assert the engine's mapping rather than the product's markup.
 */
const contentOf = (target: Locator) => target.locator("> div");

let seeded: SeededFinding;

test.beforeEach(async ({ page }) => {
  seeded = await seedSensitiveAsset(page, "ATL034 Detail");
});

test.afterEach(async () => {
  await removeSeededAsset(seeded);
});

const openDetail = async (page: Page) => {
  await page.goto(`/assets/${seeded.assetId}`);
  await expect(page.getByRole("heading", { name: seeded.serviceName, level: 1 })).toBeVisible();
};

test.describe("section structure", () => {
  test("renders sections 2 to 8 in frontend §7 order", async ({ page }) => {
    await openDetail(page);

    await expect(page.locator("[data-slot='asset-detail-sections'] h2")).toHaveText(SECTION_ORDER);
  });

  test("keeps the identity header outside the disclosure stack", async ({ page }) => {
    await openDetail(page);

    /**
     * §7's section 1 is always visible. A header nested inside a `<details>`
     * would become collapsible — and the Edit action would disappear behind a
     * disclosure the user has to find first.
     */
    await expect(headerActions(page)).toBeVisible();
    await expect(page.locator("details [data-slot='asset-header-actions']")).toHaveCount(0);
  });
});

test.describe("disclosure semantics", () => {
  test("opens Overview and collapses the rest, at every viewport", async ({ page }) => {
    await openDetail(page);

    /**
     * The same expectation runs in all three projects. Passing identically at
     * 1280, 412 and 320 is the evidence that nothing measures the viewport —
     * the `open` attribute is server-rendered and there is one DOM.
     */
    await expect(section(page, "overview")).toHaveAttribute("open", "");

    for (const slot of [
      "information",
      "permissions",
      "findings",
      "requests",
      "activity",
      "notes",
    ]) {
      await expect(section(page, slot)).not.toHaveAttribute("open", "");
    }
  });

  test("reaches a collapsed section's control with the Tab key", async ({ page }) => {
    await openDetail(page);

    const target = summaryOf(section(page, "permissions"));

    /**
     * Tabbed to, not focused programmatically: `focus()` succeeds on elements
     * the browser's tab order skips, so it would pass even if `<summary>` had
     * been replaced by something unreachable. The loop is bounded and asserts a
     * positive result rather than running to exhaustion.
     */
    let reached = false;
    for (let step = 0; step < 25 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      reached = await target.evaluate((node) => node === document.activeElement);
    }

    expect(reached, "the section's summary should be reachable by Tab").toBe(true);
  });

  test("opens a collapsed section with the keyboard and reveals its content", async ({ page }) => {
    await openDetail(page);

    const findings = section(page, "findings");
    await expect(findings).not.toHaveAttribute("open", "");

    /**
     * `press` focuses the element and dispatches a real key event, so this is
     * the browser's own `<details>` activation — not a click standing in for
     * it, and not `open` being set by the test.
     */
    await summaryOf(findings).press("Enter");

    await expect(findings).toHaveAttribute("open", "");

    /** Collapsed content is not visible; expanding is what makes it so. */
    await expect(
      contentOf(findings)
        .getByRole("list")
        .or(contentOf(findings).getByText(/no open findings/i)),
    ).toBeVisible();
  });

  test("shows a visible focus ring on the disclosure control", async ({ page }) => {
    await openDetail(page);

    const target = summaryOf(section(page, "notes"));
    await target.focus();

    /**
     * The global `:focus-visible` rule in `globals.css` supplies this; nothing
     * per-component declares it. Asserted as a computed outline width so the
     * rule's *effect* is checked rather than a class name.
     */
    const outline = await target.evaluate((node) =>
      window.getComputedStyle(node).getPropertyValue("outline-width"),
    );

    expect(outline).not.toBe("0px");
  });
});

test.describe("header actions", () => {
  test("offers a live Edit that reaches the edit route", async ({ page }) => {
    await openDetail(page);

    await headerActions(page).getByRole("link", { name: "Edit" }).click();

    await expect(page).toHaveURL(new RegExp(`/assets/${seeded.assetId}/edit$`));
  });

  /**
   * The controls with no capability behind them.
   *
   * Archive left this list in ATL-036: it is a live control now, and its
   * behaviour — including the undo toast and the failure paths — is covered in
   * `asset-archive.spec.ts`. The entry was removed rather than relaxed, because
   * an assertion that Archive is "present, unavailable and explained" is now
   * false rather than merely weaker.
   *
   * The two request controls are unchanged. ATL-056/057 own them and
   * `data_requests` still has no migration.
   */
  const DEFERRED = [
    ["Request correction", "Atlas cannot make data requests yet."],
    ["Request deletion", "Atlas cannot make data requests yet."],
  ] as const;

  for (const [label, reason] of DEFERRED) {
    test(`shows ${label} as present, unavailable and explained`, async ({ page }) => {
      await openDetail(page);

      const control = headerActions(page).getByRole("button", { name: new RegExp(label) });

      await expect(control).toBeVisible();
      await expect(control).toHaveAttribute("aria-disabled", "true");

      /** The reason is associated, so it is announced rather than merely nearby. */
      const describedBy = await control.getAttribute("aria-describedby");
      expect(describedBy).not.toBeNull();
      await expect(page.locator(`#${describedBy}`)).toHaveText(reason);
    });

    test(`keeps ${label} reachable by keyboard`, async ({ page }) => {
      await openDetail(page);

      const control = headerActions(page).getByRole("button", { name: new RegExp(label) });

      let reached = false;
      for (let step = 0; step < 25 && !reached; step += 1) {
        await page.keyboard.press("Tab");
        reached = await control.evaluate((node) => node === document.activeElement);
      }

      expect(reached, `${label} should remain in the tab order`).toBe(true);
    });
  }

  test("opens More from the shared dropdown primitive and offers nothing unbuilt", async ({
    page,
  }) => {
    await openDetail(page);

    await headerActions(page)
      .getByRole("button", { name: /More actions/ })
      .click();

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();

    /** No `menuitem` at all: a label makes no claim to be an action. */
    await expect(page.getByRole("menuitem")).toHaveCount(0);
    await expect(menu).not.toHaveText(/delete|restore|export|duplicate|request/i);
  });
});

test.describe("the findings section", () => {
  test("shows the open finding the engine derived for this service", async ({ page }) => {
    await openDetail(page);

    const findings = section(page, "findings");
    await summaryOf(findings).press("Enter");

    /** R-003, produced by the real engine from the seeded category. */
    await expect(contentOf(findings).getByRole("link")).toHaveCount(1);
    await expect(findings).not.toHaveText(/no open findings/i);
  });

  test("drops the finding once it is resolved through the product", async ({ page }) => {
    /**
     * Resolved through the Insights panel's own flow rather than by writing a
     * status. That is what makes this a test of the open-only contract: the
     * product decided the finding was closed, and the section must stop showing
     * it without any filtering of its own.
     */
    await page.goto("/insights?view=all");
    await page
      .locator("[data-slot='finding-card']")
      .filter({ hasText: seeded.serviceName })
      .first()
      .locator("[data-slot='finding-details-link']")
      .click();

    await page.waitForURL(/finding=/);
    await page.locator("[data-slot='resolve-start']").click();
    await page.getByRole("radio", { name: /reviewed the service/i }).check();
    await page.locator("[data-slot='resolve-confirm']").click();
    await expect(page.locator("[data-slot='resolve-result']")).toBeVisible();

    await openDetail(page);
    const findings = section(page, "findings");
    await summaryOf(findings).press("Enter");

    /**
     * The exact copy, because it is load-bearing. This user *did* have a finding
     * on this service and resolved it; "No findings" would deny that the work
     * ever happened.
     */
    await expect(findings).toContainText("No open findings for this service.");
    await expect(contentOf(findings).getByRole("link")).toHaveCount(0);
  });
});

test.describe("the requests section", () => {
  test("sits in §7 position 6 and claims nothing", async ({ page }) => {
    await openDetail(page);

    /** Fifth of the seven disclosures; sixth of §7's eight sections. */
    await expect(sections(page).nth(4)).toHaveAttribute("data-slot", "asset-section-requests");

    const requests = section(page, "requests");
    await summaryOf(requests).press("Enter");

    await expect(requests).toContainText(/Atlas cannot make data requests yet/i);

    /** Nothing that would suggest a request exists, is moving, or was sent. */
    await expect(requests).not.toHaveText(/\b(sent|submitted|pending|awaiting|in progress)\b/i);

    /** Scoped past the summary — see `contentOf`. */
    await expect(contentOf(requests).getByRole("button")).toHaveCount(0);
    await expect(contentOf(requests).getByRole("link")).toHaveCount(0);
  });
});

test.describe("provenance, only where the record has it", () => {
  test("shows the asset's own source and confidence", async ({ page }) => {
    await openDetail(page);

    const overview = section(page, "overview");

    /** `digital_assets` carries these, and the create form set them. */
    await expect(overview.getByText("Source", { exact: true })).toBeVisible();
    await expect(overview.getByText("Confidence", { exact: true })).toBeVisible();
    await expect(overview.getByText("Last verified", { exact: true })).toBeVisible();
  });

  test("gives the data category no verified date it does not have", async ({ page }) => {
    await openDetail(page);

    const information = section(page, "information");
    await summaryOf(information).press("Enter");

    /** The fixture inserts `category` only, so both of these are genuinely absent. */
    await expect(information).not.toHaveText(/last verified/i);
    await expect(information).not.toHaveText(/unknown source/i);
  });

  test("gives a permission no source or confidence it does not have", async ({ page }) => {
    /** Added through the edit page's own form — no insert. */
    await page.goto(`/assets/${seeded.assetId}/edit`);
    await page
      .getByRole("combobox", { name: "Permission", exact: true })
      .selectOption("data_sharing");
    await page.locator("form:has(#permissionType)").getByRole("button", { name: "Add" }).click();

    /**
     * Wait for the product's own confirmation before navigating away.
     *
     * `click()` resolves when the click is dispatched, not when the server
     * action commits and the route revalidates — so the original version raced
     * its own setup and `page.goto` could abort the in-flight write. The detail
     * page then honestly reported no permissions, and the assertion below failed
     * for a reason that had nothing to do with what it was testing.
     *
     * This is the row `asset-edit.spec.ts` waits for, matching its pattern
     * exactly: an auto-retrying assertion on the rendered row, with no sleep and
     * no arbitrary timeout.
     */
    await expect(page.getByRole("listitem").filter({ hasText: "Share your data" })).toBeVisible();

    await openDetail(page);
    const permissions = section(page, "permissions");
    await summaryOf(permissions).press("Enter");

    await expect(permissions).toContainText(/Share your data/i);

    /** `asset_permissions` has neither column — the mirror of the section above. */
    await expect(permissions).not.toHaveText(/\bSource\b/);
    await expect(permissions).not.toHaveText(/\bConfidence\b/);
  });
});

test.describe("ATL-035 masking on the detail page", () => {
  test("never puts the plaintext identifier in what the server sent", async ({ page }) => {
    const identifier = "dana.scully@example.test";
    const name = `ATL034 Masked ${Date.now().toString(36)}`;

    await page.goto("/assets/new");
    await page.getByLabel("Service name").fill(name);
    await page.getByLabel("Kind of service").selectOption("social");
    await page.getByLabel("Account identifier (optional)").fill(identifier);
    await page.getByRole("button", { name: "Save service" }).click();
    await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);

    /**
     * The strong form of "masked by default": not hidden, absent. A value in the
     * delivered document is readable from view-source and the network panel no
     * matter what the pixels show — and the rebuilt page must not have changed
     * that.
     */
    expect(await page.content()).not.toContain(identifier);
    expect(await page.content()).not.toContain("dana.scully");
    await expect(page.getByRole("button", { name: /Reveal/ })).toBeVisible();
  });
});

test.describe("layout and accessibility", () => {
  test("has no axe violations", async ({ page }) => {
    await openDetail(page);

    await expectNoAxeViolations(page);
  });

  test("has no axe violations with every section expanded", async ({ page }) => {
    await openDetail(page);

    for (const slot of [
      "information",
      "permissions",
      "findings",
      "requests",
      "activity",
      "notes",
    ]) {
      await summaryOf(section(page, slot)).press("Enter");
    }

    await expectNoAxeViolations(page);
  });

  test("does not overflow horizontally at any viewport", async ({ page }) => {
    await openDetail(page);

    for (const slot of [
      "information",
      "permissions",
      "findings",
      "requests",
      "activity",
      "notes",
    ]) {
      await summaryOf(section(page, slot)).press("Enter");
    }

    /**
     * Measured on the document: a section that fits while pushing the page wider
     * is still a horizontal scrollbar at 320px. One pixel for sub-pixel rounding.
     */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("keeps the detail stack inside the viewport", async ({ page }) => {
    await openDetail(page);

    const box = await page.locator("[data-slot='asset-detail-sections']").boundingBox();
    const viewport = page.viewportSize();

    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (!box || !viewport) return;

    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  });
});
