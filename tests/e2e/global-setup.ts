/**
 * Playwright globalSetup (ATL-214).
 *
 * Starts the deterministic GitHub API stub on port 3333 before the Next.js
 * webServer process launches.  The webServer receives GITHUB_API_BASE_URL
 * pointing to the stub, so GithubAdapter.query() hits the stub rather than
 * real api.github.com.
 *
 * Verification: the stub reports the port it bound to.  A failed bind
 * (EADDRINUSE) throws synchronously and aborts the test run before any spec
 * starts — correct behaviour, because a partially-started suite against the
 * wrong GitHub endpoint would produce misleading results.
 */

import { startGithubStub } from "./support/github-stub-server";

export default async function globalSetup(): Promise<void> {
  const { port } = await startGithubStub();
  // Verify the stub is listening (startGithubStub resolves only after bind).
  void port; // stub verified listening — bind resolves only after listen() succeeds
}
