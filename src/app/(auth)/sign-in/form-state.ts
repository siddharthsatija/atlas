import type { MagicLinkResultCode } from "@/lib/auth/auth-result";

/**
 * Form state for the sign-in screen (ATL-014).
 *
 * Deliberately **not** in `actions.ts`. A `"use server"` module may only export
 * async functions — every export becomes a callable server reference, so a plain
 * object is rejected at module evaluation with:
 *
 *     A "use server" file can only export async functions, found object.
 *
 * That is a runtime error, not a type error: `tsc`, ESLint and the unit suite all
 * pass, because each of them sees an ordinary module. It surfaces only when the
 * built server actually evaluates the file, which is why it reached E2E as a
 * global error boundary on submit rather than as a failing check.
 *
 * `use-server-exports.test.ts` guards the rule for every action file.
 */
export interface MagicLinkFormState {
  /** `null` before the first submission. */
  code: MagicLinkResultCode | null;
  /**
   * Increments per submission so the UI can re-announce an unchanged result.
   * Without it, submitting the same address twice produces an identical state
   * object and a screen reader stays silent on the second attempt.
   */
  attempt: number;
}

export const INITIAL_MAGIC_LINK_STATE: MagicLinkFormState = { code: null, attempt: 0 };
