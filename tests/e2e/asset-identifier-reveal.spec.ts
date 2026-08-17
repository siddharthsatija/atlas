import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";

/**
 * ATL-035 — masked by default, revealed deliberately, in a real browser.
 *
 * The claims that only a browser can settle: that the plaintext is absent from
 * what the server actually sent, that it appears solely in response to a user
 * action, and that it is not in the URL at any point. A jsdom render can show
 * the component's behaviour; it cannot show what crossed the network.
 */

const uniqueService = (label: string) =>
  `E2E ${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const IDENTIFIER = "dana.scully@example.com";
const REVEAL = "Reveal Account identifier";

/** Creates a service carrying an identifier and lands on its detail page. */
async function createAssetWithIdentifier(page: Page, label: string): Promise<string> {
  const serviceName = uniqueService(label);

  await page.goto("/assets/new");
  await page.getByLabel("Service name").fill(serviceName);
  await page.getByLabel("Kind of service").selectOption("social");
  await page.getByLabel("Account identifier (optional)").fill(IDENTIFIER);
  await page.getByRole("button", { name: "Save service" }).click();

  await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split("/")[2] ?? "";
}

test.describe("the identifier on the detail page", () => {
  test("is masked, and the full value is not in what the server sent", async ({ page }) => {
    /**
     * The strong form of "masked by default": not hidden, absent. A value in the
     * delivered document is readable from view-source, the network panel, and
     * any RSC payload dump, regardless of what the pixels show.
     */
    await createAssetWithIdentifier(page, "Masked");

    await expect(page.getByRole("button", { name: REVEAL })).toBeVisible();
    expect(await page.content()).not.toContain(IDENTIFIER);
    expect(await page.content()).not.toContain("dana.scully");
  });

  test("shows the full value only after an explicit reveal", async ({ page }) => {
    await createAssetWithIdentifier(page, "Reveal");

    await page.getByRole("button", { name: REVEAL }).click();

    await expect(page.getByText(IDENTIFIER)).toBeVisible();
  });

  test("keeps the value out of the URL", async ({ page }) => {
    // ATL-035: "no sensitive values in URLs or query strings". The action carries
    // the asset id in a POST body; the address bar never changes.
    const id = await createAssetWithIdentifier(page, "NoUrl");
    const before = page.url();

    await page.getByRole("button", { name: REVEAL }).click();
    await expect(page.getByText(IDENTIFIER)).toBeVisible();

    expect(page.url()).toBe(before);
    expect(page.url()).toContain(`/assets/${id}`);
    expect(page.url()).not.toContain("dana");
  });

  test("hides it again on request", async ({ page }) => {
    await createAssetWithIdentifier(page, "Hide");

    await page.getByRole("button", { name: REVEAL }).click();
    await expect(page.getByText(IDENTIFIER)).toBeVisible();

    await page.getByRole("button", { name: "Hide Account identifier" }).click();

    await expect(page.getByText(IDENTIFIER)).toBeHidden();
    await expect(page.getByRole("button", { name: REVEAL })).toBeVisible();
  });

  test("is masked again after a reload, not left open", async ({ page }) => {
    // Reveal is a disclosure, not a preference. Persisting it would leave the
    // value on screen for whoever opens the page next.
    const id = await createAssetWithIdentifier(page, "Reload");

    await page.getByRole("button", { name: REVEAL }).click();
    await expect(page.getByText(IDENTIFIER)).toBeVisible();

    await page.goto(`/assets/${id}`);

    await expect(page.getByRole("button", { name: REVEAL })).toBeVisible();
    expect(await page.content()).not.toContain(IDENTIFIER);
  });

  test("offers no reveal when nothing was recorded", async ({ page }) => {
    // There is nothing to disclose, so there is no control suggesting there is.
    const serviceName = uniqueService("NoIdentifier");

    await page.goto("/assets/new");
    await page.getByLabel("Service name").fill(serviceName);
    await page.getByLabel("Kind of service").selectOption("work");
    await page.getByRole("button", { name: "Save service" }).click();
    await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);

    await expect(page.getByText("Not recorded")).toBeVisible();
    await expect(page.getByRole("button", { name: REVEAL })).toHaveCount(0);
  });
});

test.describe("@a11y accessibility", () => {
  test("the detail page has no axe violations while masked", async ({ page }) => {
    await createAssetWithIdentifier(page, "AxeMasked");

    await expectNoAxeViolations(page);
  });

  test("and none while revealed", async ({ page }) => {
    await createAssetWithIdentifier(page, "AxeRevealed");

    await page.getByRole("button", { name: REVEAL }).click();
    await expect(page.getByText(IDENTIFIER)).toBeVisible();

    await expectNoAxeViolations(page);
  });

  test("reveal is operable by keyboard alone", async ({ page }) => {
    await createAssetWithIdentifier(page, "AxeKeyboard");

    await page.getByRole("button", { name: REVEAL }).focus();
    await page.keyboard.press("Enter");

    await expect(page.getByText(IDENTIFIER)).toBeVisible();
  });
});
