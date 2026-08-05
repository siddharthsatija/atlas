/**
 * Where the authenticated Playwright session is stored (ATL-012 support).
 *
 * Shared by `playwright.config.ts` and `tests/e2e/auth.setup.ts` so the writer
 * and the readers cannot drift onto different paths — a mismatch would show up
 * as every protected-route spec redirecting to sign-in, which reads like an
 * application fault rather than a missing file.
 *
 * A plain repository-relative path, deliberately. Playwright transpiles config
 * and test files to CommonJS, where `import.meta.url` does not exist, so
 * resolving this with `fileURLToPath` fails at config load. Playwright resolves
 * `storageState` against the config directory, which is the repository root, so
 * a relative path is both simpler and free of module-system assumptions.
 *
 * Gitignored: it holds a real session cookie for a throwaway local user.
 */
export const STORAGE_STATE = "tests/.auth/session.json";
