import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./tests/auth-state";

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
    /**
     * Signs in once through the real flow and saves the session (ATL-012).
     *
     * Product routes require a verified server-side session, so every browser
     * project depends on this. It runs one magic-link round trip per suite
     * rather than one per spec — the link is single-use, and re-issuing it for
     * every test would both slow the run and hit the auth rate limit.
     *
     * `testMatch` is overridden because the top-level pattern only picks up
     * `*.spec.ts`.
     */
    { name: "setup", testMatch: /auth\.setup\.ts$/ },

    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
      dependencies: ["setup"],
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], storageState: STORAGE_STATE },
      dependencies: ["setup"],
    },
    {
      // Smallest supported viewport per frontend spec §21 / accessibility checklist.
      name: "small-viewport",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 320, height: 720 },
        storageState: STORAGE_STATE,
      },
      dependencies: ["setup"],
    },
  ],

  webServer: {
    command: "pnpm build && pnpm start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
