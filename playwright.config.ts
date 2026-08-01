import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

/**
 * End-to-end and accessibility harness.
 *
 * Journeys required before launch are listed in docs/02-technical-architecture.md §17
 * and ATL-092 — including the AI-unavailable variant of the draft journey.
 * Flake budget: under 2% over 20 runs (.claude/skills/testing/SKILL.md).
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // `exactOptionalPropertyTypes` forbids assigning undefined to an optional property,
  // so the key is omitted entirely rather than set to undefined (Playwright then
  // applies its own default of half the available cores).
  ...(process.env.CI ? { workers: 2 } : {}),
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["html", { open: "never" }], ["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Waiting on state, never on time: no arbitrary sleeps in Atlas tests.
    actionTimeout: 10_000,
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    {
      // Smallest supported viewport per frontend spec §21 / accessibility checklist.
      name: "small-viewport",
      use: { ...devices["Desktop Chrome"], viewport: { width: 320, height: 720 } },
    },
  ],

  webServer: {
    command: "pnpm build && pnpm start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
