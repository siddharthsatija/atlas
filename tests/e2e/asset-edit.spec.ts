import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";
import { waitForConfirmationLink } from "./support/mailbox";

/**
 * ATL-033 — editing a service, end to end.
 *
 * Uses the shared authenticated session (`auth.setup.ts`), so every assertion
 * here runs against the real route, the real Server Actions, and the real
 * database. Four independent forms and three separate mutations meet on this
 * page, and the integration tests cannot see any of the things that only exist
 * once a browser submits them: which form a button belongs to, what the page
 * shows after a revalidation, and whether the prefilled values are the asset's.
 *
 * The cross-user case is deliberately a *mutation* attempt rather than a
 * navigation check — see `another user` below.
 */

/** A distinct name per run, so parallel projects do not collide on one fixture. */
const uniqueService = (label: string) =>
  `E2E ${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Creates a service through the real flow and returns its id and name. */
async function createAsset(
  page: Page,
  label: string,
  category = "entertainment",
): Promise<{ id: string; serviceName: string }> {
  const serviceName = uniqueService(label);

  await page.goto("/assets/new");
  await page.getByLabel("Service name").fill(serviceName);
  await page.getByLabel("Kind of service").selectOption(category);
  await page.getByRole("button", { name: "Save service" }).click();

  /**
   * The redirect, raced against the create form's own error banner.
   *
   * A recoverable failure from the Server Action — the store being briefly
   * unavailable under a parallel run, say — leaves the user on `/assets/new`
   * with an error and no redirect. Waiting on the URL alone turns that into a
   * 30-second timeout inside a fixture helper, which says only that the detail
   * page never arrived and hides the reason the browser was actually shown.
   *
   * Targeted by test id, and required to carry text. `getByRole("alert")` is
   * the wrong handle: the shell renders a permanent, empty live region of that
   * role, so the race resolved instantly on every run and reported a failure
   * with no message. The banner below is rendered only when `state.failure` is
   * set, so its presence *is* the failure.
   */
  const banner = page.getByTestId("create-asset-error").filter({ hasText: /\S/ });
  const outcome = await Promise.race([
    page.waitForURL(/\/assets\/[0-9a-f-]{36}$/).then(() => "redirected" as const),
    banner
      .waitFor({ state: "visible" })
      .then(() => "failed" as const)
      .catch(() => "redirected" as const),
  ]);

  if (outcome === "failed") {
    throw new Error(`Creating the "${label}" fixture failed: ${await banner.innerText()}`);
  }
  await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);

  const id = new URL(page.url()).pathname.split("/")[2] ?? "";
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  return { id, serviceName };
}

/** The form a control belongs to, so `Add` is never ambiguous between the two. */
const formWith = (page: Page, controlId: string) => page.locator(`form:has(#${controlId})`);

/**
 * A `<select>` on this page, addressed by role rather than by label.
 *
 * `getByLabel` is a substring, case-insensitive match against *any* accessible
 * name, and since ATL-112 each of these controls sits inside an
 * `AssetActionForm` that carries its own `aria-label` — "Update status" for the
 * status select, "Add permission" for the permission one. Both forms therefore
 * answered to the control's label as well, and strict mode failed on two
 * matches.
 *
 * The form names are correct and stay: they are what lets a screen-reader user
 * tell seven otherwise identical forms apart. Role is what separates them from
 * the controls inside — a form is not a combobox — and `getByRole` matches the
 * whole accessible name rather than a fragment of it, so "Status" no longer
 * finds "Update status" either.
 */
const selectNamed = (page: Page, name: string) => page.getByRole("combobox", { name, exact: true });

/**
 * Atlas's own mutation-error banner, rendered by `AssetActionForm` (ATL-112).
 *
 * Deliberately not `getByRole("alert")`: Next ships a permanent, empty
 * `<div role="alert" id="__next-route-announcer__">` on every page, so the role
 * query resolves whether or not anything went wrong. This slot is present only
 * when there is a failure to report.
 */
const mutationError = (page: Page) => page.locator("[data-slot='asset-action-error']");

/** The list item for one permission or category, so `Remove` is unambiguous. */
const rowFor = (page: Page, text: string | RegExp) =>
  page.getByRole("listitem").filter({ hasText: text });

test.describe("reaching the edit page", () => {
  test("the detail page's Edit action opens it", async ({ page }) => {
    const { id, serviceName } = await createAsset(page, "Reach");

    await page.getByRole("link", { name: "Edit" }).click();

    await expect(page).toHaveURL(new RegExp(`/assets/${id}/edit$`));
    await expect(
      page.getByRole("heading", { level: 1, name: `Edit ${serviceName}` }),
    ).toBeVisible();
  });

  test("prefills the asset's current values", async ({ page }) => {
    /**
     * Not a cosmetic detail: an edit form that starts empty is a form that
     * silently blanks every field the user does not retype.
     */
    const { id, serviceName } = await createAsset(page, "Prefill", "finance");

    await page.goto(`/assets/${id}/edit`);

    await expect(page.getByLabel("Service name")).toHaveValue(serviceName);
    await expect(page.getByLabel("Kind of service")).toHaveValue("finance");
  });

  test("answers 404 for a service that does not exist", async ({ page }) => {
    const response = await page.goto("/assets/11111111-1111-4111-8111-111111111111/edit");

    expect(response?.status()).toBe(404);
  });
});

test.describe("editing details", () => {
  test("saves and shows the change on the detail page", async ({ page }) => {
    const { id } = await createAsset(page, "Details");
    const renamed = uniqueService("Renamed");

    await page.goto(`/assets/${id}/edit`);
    await page.getByLabel("Service name").fill(renamed);
    await page.getByLabel("Website (optional)").fill("example.com");
    await page.getByRole("button", { name: "Save changes" }).click();

    await page.waitForURL(new RegExp(`/assets/${id}$`));
    await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();

    /**
     * Scoped to Overview, because ATL-034 gave the domain two homes.
     *
     * Frontend §7's detail page shows it twice, both legitimately: as the
     * subtitle under the identity header, and as the "Website" fact in Overview.
     * An unscoped `getByText` matched both and tripped strict mode — the page
     * was right and the locator had become ambiguous.
     *
     * Overview is the canonical one. It is the labelled row in the record's own
     * facts, where §7 says every factual item lives; the header subtitle is
     * presentation. Asserting there also keeps the test honest about *what* it
     * checks — that the edit reached the stored record — rather than that the
     * string appears somewhere on the page.
     *
     * Overview is expanded by default, so nothing has to be opened first.
     */
    await expect(
      page.locator("[data-slot='asset-section-overview']").getByText("example.com"),
    ).toBeVisible();
  });

  test("keeps what was typed when validation fails", async ({ page }) => {
    /**
     * The ATL-032 contract applies to editing too: one bad field must not cost
     * the user the rest of the form.
     */
    const { id } = await createAsset(page, "Recoverable");
    const renamed = uniqueService("Kept");

    await page.goto(`/assets/${id}/edit`);
    await page.getByLabel("Service name").fill(renamed);
    await page.getByLabel("Kind of service").selectOption("finance");
    // Rejected: the column stores a bare hostname.
    await page.getByLabel("Website (optional)").fill("https://example.com/account");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.getByText(/Enter a domain like example\.com/i)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/assets/${id}/edit$`));
    await expect(page.getByLabel("Service name")).toHaveValue(renamed);
    await expect(page.getByLabel("Kind of service")).toHaveValue("finance");
  });
});

test.describe("status", () => {
  test("moves active → inactive → removed", async ({ page }) => {
    const { id } = await createAsset(page, "Status");

    await page.goto(`/assets/${id}/edit`);
    await expect(selectNamed(page, "Status")).toHaveValue("active");

    for (const status of ["inactive", "removed"] as const) {
      await selectNamed(page, "Status").selectOption(status);
      await page.getByRole("button", { name: "Update status" }).click();
      await expect(selectNamed(page, "Status")).toHaveValue(status);
    }
  });

  test("does not offer archived", async ({ page }) => {
    /**
     * ATL-036 owns archiving, with the undo affordance and the copy explaining
     * it is not deletion from the service. Offering it here would let someone
     * archive with no way back.
     */
    const { id } = await createAsset(page, "NoArchive");

    await page.goto(`/assets/${id}/edit`);

    const values = await selectNamed(page, "Status")
      .locator("option")
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(values).toEqual(["active", "inactive", "removed"]);
  });
});

test.describe("review", () => {
  test("marking reviewed updates what the page shows", async ({ page }) => {
    const { id } = await createAsset(page, "Review");

    await page.goto(`/assets/${id}/edit`);
    await expect(page.getByText("Never reviewed.")).toBeVisible();

    await page.getByRole("button", { name: "Mark as reviewed" }).click();

    await expect(page.getByText(/Last reviewed \d{4}-\d{2}-\d{2}\./)).toBeVisible();

    /**
     * And silently: a successful write says nothing (ATL-112).
     *
     * Scoped to Atlas's own error slot, not `getByRole("alert")`. Next renders a
     * permanent `#__next-route-announcer__` with that role on every page, so the
     * global query matched an empty element and reported a failure on a review
     * that had plainly succeeded — the paragraph above says "Last reviewed".
     * This locator exists only when `AssetActionForm` has a failure to show.
     */
    await expect(mutationError(page)).toHaveCount(0);
  });

  test("an ordinary save does not count as a review", async ({ page }) => {
    /**
     * The acceptance criterion: `last_reviewed` moves "on explicit review
     * action, not on every save". It feeds R-001 and the score's freshness
     * factor, so moving it while someone fixes a typo would claim they
     * re-checked something they never looked at.
     */
    const { id } = await createAsset(page, "NotAReview");

    await page.goto(`/assets/${id}/edit`);
    await page.getByRole("button", { name: "Mark as reviewed" }).click();
    const reviewed = await page.getByText(/Last reviewed \d{4}-\d{2}-\d{2}\./).textContent();

    await page.getByLabel("Notes (optional)").fill("Fixed a typo");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(new RegExp(`/assets/${id}$`));

    await page.goto(`/assets/${id}/edit`);
    await expect(page.getByText(/Last reviewed/)).toHaveText(reviewed ?? "");
  });
});

test.describe("information held", () => {
  test("adds a category and removes it again", async ({ page }) => {
    const { id } = await createAsset(page, "Categories");

    await page.goto(`/assets/${id}/edit`);
    await expect(page.getByText("Nothing recorded yet.").first()).toBeVisible();

    await selectNamed(page, "Add what this service holds").selectOption("contact");
    await formWith(page, "category-add").getByRole("button", { name: "Add" }).click();
    await expect(rowFor(page, "contact")).toBeVisible();

    await rowFor(page, "contact").getByRole("button", { name: "Remove" }).click();
    await expect(rowFor(page, "contact")).toHaveCount(0);
  });
});

test.describe("permissions", () => {
  test("adds one from the fixed vocabulary", async ({ page }) => {
    const { id } = await createAsset(page, "Permissions");

    await page.goto(`/assets/${id}/edit`);
    await selectNamed(page, "Permission").selectOption("account_access");
    await selectNamed(page, "How much it grants").selectOption("broad");
    await formWith(page, "permissionType").getByRole("button", { name: "Add" }).click();

    await expect(rowFor(page, "Act on your behalf")).toBeVisible();
    await expect(rowFor(page, "Act on your behalf").getByText("broad")).toBeVisible();
  });

  test("revoking keeps the row and shows it as revoked", async ({ page }) => {
    /**
     * ADR-004 divides by "total recorded", so the row must survive — that is
     * what makes revoking improve the permission factor rather than erase the
     * evidence the grant existed.
     */
    const { id } = await createAsset(page, "Revoke");

    await page.goto(`/assets/${id}/edit`);
    await selectNamed(page, "Permission").selectOption("data_sharing");
    await formWith(page, "permissionType").getByRole("button", { name: "Add" }).click();

    const row = rowFor(page, "Share your data");
    await expect(row.getByText("active")).toBeVisible();

    await row.getByRole("button", { name: "Revoke" }).click();

    await expect(rowFor(page, "Share your data")).toHaveCount(1);
    await expect(rowFor(page, "Share your data").getByText("revoked")).toBeVisible();
    await expect(
      rowFor(page, "Share your data").getByRole("button", { name: "Revoke" }),
    ).toHaveCount(0);
  });

  test("offers no way to record a permission outside the vocabulary", async ({ page }) => {
    /**
     * ATL-029's design is shape-checked in SQL and vocabulary-checked in the
     * application. A text box would let one grant be recorded under two names,
     * and both would land in ADR-004's "total recorded" denominator.
     */
    const { id } = await createAsset(page, "Vocabulary");

    await page.goto(`/assets/${id}/edit`);

    /*
      By id, not by role: asserting `getByRole("combobox")` here would presuppose
      the very thing under test. The question is whether the control *is* a
      fixed-choice select rather than a free-text box, so it is located without
      reference to its role and then asked what it is.
    */
    await expect(page.locator("#permissionType")).toHaveJSProperty("tagName", "SELECT");
    const values = await selectNamed(page, "Permission")
      .locator("option")
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(values).toEqual([
      "account_access",
      "data_sharing",
      "marketing",
      "device_access",
      "other",
    ]);
  });
});

test.describe("another user", () => {
  /**
   * A navigation check alone would prove too little. The interesting failure is
   * a *write* arriving with someone else's session, so this renders the page as
   * its owner, swaps the session cookies underneath it, and submits the form
   * that is already on screen — which is as close to a real cross-user attempt
   * as a browser can get, using the live Server Action id rather than a guessed
   * endpoint.
   */
  async function signInFreshUser(context: BrowserContext): Promise<void> {
    const page = await context.newPage();
    const email = `edit-other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: /email me a sign-in link/i }).click();
    await expect(page.getByText("Check your email")).toBeVisible();

    await page.goto(await waitForConfirmationLink(email));
    await page.waitForURL(/\/(overview|onboarding)(\?.*)?$/);

    if (new URL(page.url()).pathname === "/onboarding") {
      await page.getByRole("button", { name: "Continue" }).click();
      for (let step = 0; step < 3; step++) {
        await page.getByRole("button", { name: "Skip" }).click();
      }
      // identity_profile is mandatory (ATL-209).
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Go to my dashboard" }).click();
      await page.waitForURL(/\/overview(\?.*)?$/);
    }

    await page.close();
  }

  /**
   * One project, and the reason is not convenience.
   *
   * Authorization is decided in the service and the database; nothing about it
   * varies with viewport width, so running this three times asserts the same
   * server behaviour three times. It is not free: each run is a full magic-link
   * round trip, and a trace showed the suite exceeding GoTrue's local
   * `email_sent` allowance — at which point onboarding tests failed on a message
   * the product was correct to display. Two of those sends were this test.
   *
   * Every assertion below is unchanged: the read refusals *and* the cross-user
   * write attempt still run in full.
   */
  test("can neither open nor mutate someone else's service", async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "authorization does not vary by viewport; see the comment above",
    );

    const { id } = await createAsset(page, "CrossUser");

    await page.goto(`/assets/${id}/edit`);
    await expect(page.getByText("Never reviewed.")).toBeVisible();
    const ownerCookies = await page.context().cookies();

    const intruder = await browser.newContext();
    await signInFreshUser(intruder);
    const intruderCookies = await intruder.cookies();

    // Reading is refused, and refused as 404 rather than 403 — a 403 would
    // confirm the id names something real.
    const intruderPage = await intruder.newPage();
    for (const path of [`/assets/${id}`, `/assets/${id}/edit`]) {
      expect((await intruderPage.goto(path))?.status()).toBe(404);
    }

    // The write attempt: the owner's rendered form, the intruder's session.
    await page.context().clearCookies();
    await page.context().addCookies(intruderCookies);
    await page.getByRole("button", { name: "Mark as reviewed" }).click();

    /**
     * The refusal is now *visible* (ATL-112). It used to be silent, which read
     * as success — and a refusal indistinguishable from success is one nobody
     * can act on.
     *
     * It surfaces as a 404, not as the inline error, and that is the product
     * behaving correctly: the Server Action re-renders `/assets/{id}/edit`, the
     * page's own `listAssetDetails` answers `NOT_FOUND` for a user who does not
     * own the asset, and `notFound()` replaces the view. The same non-oracle
     * rule as everywhere else — a 403 would confirm the id names something real.
     *
     * The inline slot is asserted empty alongside it, because the failure worth
     * guarding against is the opposite one: an intruder shown a page that
     * behaves as though their write landed.
     */
    await expect(
      /*
        The heading, not the text. Next's route announcer carries the same
        sentence with a "404: " prefix, so `getByText` matched two elements and
        tripped strict mode — the 404 was rendering correctly the whole time.
      */
      page.getByRole("heading", { name: "This page could not be found.", exact: true }),
    ).toBeVisible();
    await expect(mutationError(page)).toHaveCount(0);

    await intruder.close();

    // Back as the owner: the review date must not have moved.
    await page.context().clearCookies();
    await page.context().addCookies(ownerCookies);
    await page.goto(`/assets/${id}/edit`);
    await expect(page.getByText("Never reviewed.")).toBeVisible();
  });
});

test.describe("@a11y accessibility", () => {
  test("the edit page has no axe violations", async ({ page }) => {
    const { id } = await createAsset(page, "Axe");

    await page.goto(`/assets/${id}/edit`);

    /**
     * Both child lists populated, so the rows and their actions are in scope.
     *
     * The wait between the two additions is load-bearing, not caution. `click`
     * resolves when the click is dispatched, not when the Server Action it
     * triggers has re-rendered the page — and every select on this route is
     * uncontrolled, so that re-render remounts the *permission* select too,
     * back to its first option. Choosing a permission
     * while the category's re-render is still in flight therefore loses the
     * choice, and the row that appears is the default one. Waiting for the first
     * mutation to land is the only ordering that submits what was selected.
     */
    await selectNamed(page, "Add what this service holds").selectOption("financial");
    await formWith(page, "category-add").getByRole("button", { name: "Add" }).click();
    await expect(rowFor(page, "financial")).toBeVisible();

    await selectNamed(page, "Permission").selectOption("device_access");
    await formWith(page, "permissionType").getByRole("button", { name: "Add" }).click();
    await expect(rowFor(page, "Reach your device")).toBeVisible();

    await expectNoAxeViolations(page);
  });

  test("the details form is operable by keyboard alone", async ({ page }) => {
    const { id } = await createAsset(page, "Keyboard");
    const renamed = uniqueService("Typed");

    await page.goto(`/assets/${id}/edit`);

    // Focus by keyboard rather than clicking, then move through the form the way
    // someone without a pointer would.
    await page.getByLabel("Service name").focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type(renamed);
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Kind of service")).toBeFocused();

    // And the submit is reachable and activatable without a pointer.
    await page.getByRole("button", { name: "Save changes" }).focus();
    await page.keyboard.press("Enter");

    await page.waitForURL(new RegExp(`/assets/${id}$`));
    await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();
  });
});
