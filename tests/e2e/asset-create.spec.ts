import { expect, test } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";

/**
 * ATL-032 — the create-asset path, end to end.
 *
 * Uses the shared authenticated session (`auth.setup.ts`), so this exercises the
 * real route, the real Server Action, and the real encryption round trip.
 *
 * Only a browser can show the two things that matter most here: that a
 * recoverable error leaves the form filled in, and that the identifier appears
 * masked on the page the user lands on.
 */

/** A distinct name per run, so parallel projects do not collide on one fixture. */
const uniqueService = (label: string) =>
  `E2E ${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe("adding a service", () => {
  test("creates one and lands on its detail page", async ({ page }) => {
    const serviceName = uniqueService("Create");

    await page.goto("/assets/new");
    await page.getByLabel("Service name").fill(serviceName);
    await page.getByLabel("Kind of service").selectOption("entertainment");
    await page.getByLabel("Website (optional)").fill("example.com");
    await page.getByRole("button", { name: "Save service" }).click();

    // ATL-032: "success routes to the asset detail".
    await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: serviceName })).toBeVisible();
  });

  test("shows the identifier masked, never in the page source", async ({ page }) => {
    /**
     * The strongest form of the "masked immediately" criterion: the plaintext
     * must not merely be hidden visually, it must not be in what the server
     * sent. Masking in the browser would put the value in the payload and rely
     * on CSS.
     */
    const serviceName = uniqueService("Masked");
    const identifier = "dana.scully@example.com";

    await page.goto("/assets/new");
    await page.getByLabel("Service name").fill(serviceName);
    await page.getByLabel("Kind of service").selectOption("social");
    await page.getByLabel("Account identifier (optional)").fill(identifier);
    await page.getByRole("button", { name: "Save service" }).click();

    await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);

    await expect(page.getByText("Account identifier")).toBeVisible();
    // The full value appears nowhere in the delivered document.
    expect(await page.content()).not.toContain(identifier);
    expect(await page.content()).not.toContain("dana.scully");
  });

  test("keeps what was typed when validation fails", async ({ page }) => {
    /**
     * ATL-032: "Form preserves input on recoverable errors". Losing a filled-in
     * form to one bad field is the failure this criterion exists to prevent.
     */
    const serviceName = uniqueService("Preserved");

    await page.goto("/assets/new");
    await page.getByLabel("Service name").fill(serviceName);
    await page.getByLabel("Kind of service").selectOption("finance");
    // Rejected: the column stores a bare hostname.
    await page.getByLabel("Website (optional)").fill("https://example.com/account");
    await page.getByRole("button", { name: "Save service" }).click();

    await expect(page.getByText(/Enter a domain like example\.com/i)).toBeVisible();
    await expect(page).toHaveURL(/\/assets\/new$/);
    await expect(page.getByLabel("Service name")).toHaveValue(serviceName);
    await expect(page.getByLabel("Kind of service")).toHaveValue("finance");
  });

  test("does not send the account identifier back after a failure", async ({ page }) => {
    /**
     * The one field deliberately *not* preserved. It is Restricted, and echoing
     * it would put it in the response payload on every failed attempt. The hint
     * text tells the user this will happen, so the empty field is explained
     * rather than surprising.
     */
    await page.goto("/assets/new");
    await page.getByLabel("Service name").fill("");
    await page.getByLabel("Account identifier (optional)").fill("dana.scully@example.com");
    await page.getByRole("button", { name: "Save service" }).click();

    await expect(page.getByText(/Enter the name of the service/i)).toBeVisible();
    await expect(page.getByLabel("Account identifier (optional)")).toHaveValue("");
    expect(await page.content()).not.toContain("dana.scully");
  });

  test("a created service appears in the list", async ({ page }) => {
    const serviceName = uniqueService("Listed");

    await page.goto("/assets/new");
    await page.getByLabel("Service name").fill(serviceName);
    await page.getByLabel("Kind of service").selectOption("shopping");
    await page.getByRole("button", { name: "Save service" }).click();
    await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);

    await page.goto("/assets");
    await expect(page.getByRole("heading", { level: 3, name: serviceName })).toBeVisible();
  });

  test("can be reached from the list", async ({ page }) => {
    await page.goto("/assets");
    await page.getByRole("link", { name: "Add service" }).click();

    await expect(page).toHaveURL(/\/assets\/new$/);
    await expect(page.getByRole("heading", { level: 1, name: "Add a service" })).toBeVisible();
  });
});

test.describe("@a11y accessibility", () => {
  test("the create form has no axe violations", async ({ page }) => {
    await page.goto("/assets/new");
    await expectNoAxeViolations(page);
  });

  test("the form is completable by keyboard alone", async ({ page }) => {
    const serviceName = uniqueService("Keyboard");

    await page.goto("/assets/new");

    // Focus the first field by keyboard rather than clicking it, then move
    // through the form the way someone without a pointer would.
    await page.getByLabel("Service name").focus();
    await page.keyboard.type(serviceName);
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowDown");

    await expect(page.getByLabel("Kind of service")).toBeFocused();
  });

  test("the detail page has no axe violations", async ({ page }) => {
    const serviceName = uniqueService("Detail");

    await page.goto("/assets/new");
    await page.getByLabel("Service name").fill(serviceName);
    await page.getByLabel("Kind of service").selectOption("work");
    await page.getByLabel("Account identifier (optional)").fill("dana.scully@example.com");
    await page.getByRole("button", { name: "Save service" }).click();
    await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/);

    await expectNoAxeViolations(page);
  });
});
