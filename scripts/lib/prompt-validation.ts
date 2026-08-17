/**
 * Prompt version validation (ATL-051).
 *
 * Published prompt versions are **append-only**. The acceptance criterion —
 * "changing a prompt requires a version bump" — is unenforceable by review
 * alone: a two-word edit to a task template reads as a typo fix and silently
 * puts an unevaluated prompt in front of users, while `ai_interactions` keeps
 * recording the old version number against outputs the old prompt never
 * produced. That is the failure this gate exists to make impossible.
 *
 * The same invariant as migrations, enforced the same way (architecture §8,
 * `scripts/lib/migration-validation.ts`): compare the working tree against a
 * committed baseline and reject modification or deletion of anything already
 * published. Adding a new version file is always allowed.
 *
 * File-level comparison rather than parsing TypeScript is deliberate. A parser
 * would need to keep up with however the definitions are written; byte equality
 * of a published file cannot be fooled by reformatting, a moved constant, or a
 * whitespace-preserving edit.
 *
 * Pure functions over file lists, so they are exhaustively unit-testable without
 * git. The CLI wrapper (`scripts/verify-prompts.mts`) supplies the baseline.
 */

/** A prompt version file as it exists in some revision. */
export interface PromptFile {
  /** Basename, e.g. `explain-finding-v1.ts`. */
  name: string;
  content: string;
}

export type PromptViolationRule =
  "prompt-modified" | "prompt-deleted" | "invalid-filename" | "duplicate-version";

export interface PromptViolation {
  rule: PromptViolationRule;
  file: string;
  message: string;
}

/**
 * `slug-vN.ts`.
 *
 * The version lives in the filename so the append-only rule can be checked
 * without reading the file: a name that never repeats is a version that was
 * never reused.
 */
const FILENAME_PATTERN = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-v([1-9][0-9]*)\.ts$/;

export function parsePromptName(name: string): { slug: string; version: number } | null {
  const match = FILENAME_PATTERN.exec(name);
  if (!match?.[1] || !match[2]) return null;
  return { slug: match[1], version: Number(match[2]) };
}

export function sortPrompts<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name));
}

function validateFilenames(current: PromptFile[]): PromptViolation[] {
  const violations: PromptViolation[] = [];
  const seen = new Map<string, string>();

  for (const file of current) {
    const parsed = parsePromptName(file.name);

    if (parsed === null) {
      violations.push({
        rule: "invalid-filename",
        file: file.name,
        message:
          "Prompt version filenames must be slug-vN.ts (e.g. explain-finding-v1.ts) " +
          "so the version is checkable without reading the file (ATL-051).",
      });
      continue;
    }

    const key = `${parsed.slug}-v${parsed.version}`;
    const existing = seen.get(key);
    if (existing !== undefined) {
      violations.push({
        rule: "duplicate-version",
        file: file.name,
        message: `Version ${key} is already defined by ${existing}. A version identifies exactly one prompt text.`,
      });
      continue;
    }

    seen.set(key, file.name);
  }

  return violations;
}

/**
 * Compares published prompts against the baseline.
 *
 * A file absent from the baseline is a new version and always passes — that is
 * the supported way to change a prompt.
 */
function validateAppendOnly(current: PromptFile[], baseline: PromptFile[]): PromptViolation[] {
  const violations: PromptViolation[] = [];
  const currentByName = new Map(current.map((file) => [file.name, file]));

  for (const published of baseline) {
    const live = currentByName.get(published.name);

    if (live === undefined) {
      violations.push({
        rule: "prompt-deleted",
        file: published.name,
        message:
          "A published prompt version was deleted. Interactions recorded against it " +
          "would no longer be reproducible; publish a new version instead.",
      });
      continue;
    }

    if (live.content !== published.content) {
      violations.push({
        rule: "prompt-modified",
        file: published.name,
        message:
          "A published prompt version was modified. Changing a prompt requires a " +
          "version bump: add the next slug-vN.ts and point the registry at it (ATL-051).",
      });
    }
  }

  return violations;
}

export interface PromptValidationInput {
  current: PromptFile[];
  /**
   * The committed baseline, or `null` when no git baseline is available.
   *
   * `null` is not an empty baseline. An empty array means "nothing was published
   * yet" and passes legitimately; `null` means the comparison could not run, and
   * the caller must report that as a skip rather than a pass.
   */
  baseline: PromptFile[] | null;
}

export interface PromptValidationResult {
  violations: PromptViolation[];
  /** True when the append-only comparison could not run. */
  appendOnlySkipped: boolean;
}

export function validatePrompts({
  current,
  baseline,
}: PromptValidationInput): PromptValidationResult {
  const violations = validateFilenames(current);

  if (baseline === null) {
    return { violations, appendOnlySkipped: true };
  }

  return {
    violations: [...violations, ...validateAppendOnly(current, baseline)],
    appendOnlySkipped: false,
  };
}
