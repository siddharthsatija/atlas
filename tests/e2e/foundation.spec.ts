import { expect, test } from "@playwright/test";
import { expectNoAxeViolations } from "../a11y-helpers";

/**
 * Harness validation only — not a feature test.
 *
 * Confirms the app builds, serves, applies security headers, and that the
 * accessibility harness runs. Product journeys are added with their tickets
 * (ATL-092); this file should stay small.
 */
test.describe("foundation", () => {
  test("serves the application shell", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("applies baseline security headers @security", async ({ page }) => {
    const response = await page.goto("/");
    const headers = response?.headers() ?? {};

    // Content-Security-Policy is intentionally absent until ATL-087 adds a
    // nonce-based policy; the rest of §18 applies from the start.
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["strict-transport-security"]).toContain("max-age=");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["permissions-policy"]).toContain("geolocation=()");
  });

  test("has no accessibility violations @a11y", async ({ page }) => {
    await page.goto("/");
    await expectNoAxeViolations(page);
  });

  test("respects reduced motion @a11y", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
