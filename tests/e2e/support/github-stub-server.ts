/**
 * Deterministic local GitHub API stub for E2E testing (ATL-214).
 *
 * The GitHub adapter runs server-side (import "server-only"), so browser-level
 * route interception (page.route()) cannot intercept its outbound fetch.  This
 * stub runs in the same Node.js process as Playwright's global setup and
 * listens on a fixed port that the webServer env-var points the adapter at.
 *
 * Any GET /<path> returns a canned GitHub-shaped profile.  The last path
 * segment is echoed back as `login` so assertions can verify the handle
 * that was queried — useful when the test adds a username field and wants
 * to confirm the correct handle was dispatched.
 *
 * Exports two functions:
 *   startGithubStub()  — called from globalSetup; module-level stop handle stored
 *   stopGithubStub()   — called from globalTeardown; uses the stored stop handle
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const STUB_PORT = 3333;

/**
 * Module-level stop handle.  Playwright's globalSetup and globalTeardown run
 * in the same main Node.js process, so the module cache is shared between the
 * two imports — the handle written here by globalSetup is readable by
 * globalTeardown via stopGithubStub().
 */
let _stop: (() => Promise<void>) | null = null;

/**
 * Starts the stub HTTP server on port 3333.
 *
 * Throws EADDRINUSE if the port is already occupied rather than silently
 * binding to a random port, so test runs fail loudly when the port is in use.
 *
 * Returns { port, stop } for callers that want to manage the lifecycle
 * themselves.  globalSetup uses this and delegates teardown via stopGithubStub.
 */
export async function startGithubStub(): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Extract the last path segment as the GitHub login.
    // URL is e.g. /users/testhandle or just /testhandle — take the last part.
    const segments = (req.url ?? "/").split("/").filter(Boolean);
    const login = segments.at(-1) ?? "unknown";

    const body = JSON.stringify({
      id: 1_234_567,
      login,
      html_url: `https://github.com/${login}`,
      public_repos: 10,
      followers: 5,
      created_at: "2020-01-01T00:00:00Z",
      name: null,
    });

    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () => resolve());
  });

  const stop = () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

  _stop = stop;
  return { port: STUB_PORT, stop };
}

/**
 * Stops the stub server started by startGithubStub().
 *
 * Safe to call when the stub was never started (no-op).
 */
export async function stopGithubStub(): Promise<void> {
  if (_stop) {
    await _stop();
    _stop = null;
  }
}
