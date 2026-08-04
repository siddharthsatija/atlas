import { ESLint } from "eslint";

/**
 * lint-staged configuration.
 *
 * Replaces `.lintstagedrc.json`, which could only express static command
 * strings. The one thing it could not express is the reason for this file:
 * **staged files that ESLint ignores must not be handed to ESLint.**
 *
 * `src/types/database.generated.ts` is committed (it is the `pnpm db:types`
 * output that the Supabase clients are typed against) but ignored by
 * `eslint.config.mjs`. Passing an ignored file explicitly makes ESLint emit
 * "File ignored because of a matching ignore pattern" as a *warning*, and
 * `--max-warnings=0` correctly turns that into a failed commit. Any commit
 * touching a generated file was therefore unlandable.
 *
 * The fix filters rather than silences. `--no-warn-ignored` would also make the
 * error go away, but it suppresses the warning for every ignored file forever —
 * including a future case where the warning is telling us something true.
 *
 * The filter asks **ESLint itself** whether a path is ignored, via
 * `isPathIgnored`. A hand-maintained list here would be a second copy of the
 * ignore rules in `eslint.config.mjs`, and the two would drift the first time
 * either changed.
 */

const eslint = new ESLint();

/** Quoted for lint-staged's argv parser: route groups like `(auth)` are common here. */
const asArgs = (files) => files.map((file) => JSON.stringify(file)).join(" ");

/** Staged files ESLint will actually lint, in staged order. */
async function lintableFiles(files) {
  const ignored = await Promise.all(files.map((file) => eslint.isPathIgnored(file)));
  return files.filter((_file, index) => !ignored[index]);
}

/**
 * ESLint over the files it accepts, then Prettier over all of them.
 *
 * Prettier still receives the full set: it applies its own `.prettierignore`
 * silently and exits zero, so an ignored file costs nothing there. Only ESLint
 * treats an explicitly-passed ignored file as noteworthy.
 */
async function lintAndFormat(files) {
  const commands = [];

  const lintable = await lintableFiles(files);
  if (lintable.length > 0) {
    // `--max-warnings=0` is unchanged: warnings still fail the commit.
    commands.push(`eslint --fix --max-warnings=0 ${asArgs(lintable)}`);
  }

  commands.push(`prettier --write ${asArgs(files)}`);
  return commands;
}

/** Named rather than exported anonymously (`import/no-anonymous-default-export`). */
const config = {
  "*.{ts,tsx}": lintAndFormat,
  "*.{js,mjs,cjs}": lintAndFormat,
  "*.{json,md,yml,yaml,css}": (files) => [`prettier --write ${asArgs(files)}`],
  "*.sql": (files) => [`prettier --write ${asArgs(files)}`],
};

export default config;
