/**
 * Playwright globalTeardown (ATL-214).
 *
 * Stops the deterministic GitHub API stub started in globalSetup.  Because
 * globalSetup and globalTeardown run in the same main Playwright process,
 * they share the Node.js module cache — stopGithubStub() reads the stop
 * handle stored by startGithubStub() without needing an IPC channel or a
 * temp file.
 */

import { stopGithubStub } from "./support/github-stub-server";

export default async function globalTeardown(): Promise<void> {
  await stopGithubStub();
}
