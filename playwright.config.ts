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
  /**
   * Two workers everywhere, not just CI.
   *
   * Playwright's default is half the available cores — 5 on this hardware — and
   * at 5 the local Supabase stack intermittently fails to serve `getUser()`:
   * GoTrue cannot open a socket to Postgres (`connect: cannot assign requested
   * address`), returns 500, and ATL-111 correctly reports an auth outage rather
   * than pretending the user is signed out. Measured back to back on the same
   * commit: 5 workers → 5 failures and 8 `auth.provider_unavailable` events
   * inside 250ms; 2 workers → 236 passed, zero.
   *
   * A bound rather than a retry, because the suite is not flaky — the stack is
   * saturated, and a retry would hide that. It costs nothing: 1.4m at 2 workers
   * against 1.5m at 5, since the bottleneck was queueing rather than
   * parallelism.
   *
   * This bounds the *harness*. No product behaviour, no timeout, no assertion,
   * and no provider configuration changes with it. Setting it unconditionally
   * also retires the `exactOptionalPropertyTypes` spread that used to be needed
   * to leave the key absent outside CI.
   */
  workers: 2,
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

  /**
   * The suite runs against a production build, always.
   *
   * `reuseExistingServer` used to be on locally, and a `pnpm dev` server left
   * running on the same port was silently adopted as the target. That is a
   * different runtime, not a convenience: `next dev` compiles each route on
   * first request, so `page.goto` waits on a webpack build rather than a
   * response, and navigations that take milliseconds under `next start` ran
   * past the 30-second test timeout. It also injects the dev overlay, whose
   * permanently-present empty `role="alert"` region is invisible to a human and
   * poisonous to any role-based assertion.
   *
   * Reusing a server on this port cannot be made safe, because the port is not
   * ours to disambiguate: `supabase/config.toml` pins `site_url` and the
   * callback allowlist to :3000, so the E2E harness cannot move elsewhere
   * without changing auth configuration. Starting our own build is the only
   * option that guarantees what is under test. If the port is occupied,
   * `next start` fails loudly — which is the correct outcome, and far better
   * than a green run against something else.
   *
   * The cost is a build per local run, and it is deliberate: nothing here is
   * allowed to be faster by testing something other than what ships.
   */
  webServer: {
    command: "pnpm build && pnpm start",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
