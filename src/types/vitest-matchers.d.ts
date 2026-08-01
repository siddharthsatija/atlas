/**
 * Registers the jest-axe matcher on Vitest's `expect`.
 *
 * Separate from `jest-axe.d.ts` because an ambient module declaration must live in
 * a script file, while interface augmentation must live in a module file.
 * `@testing-library/jest-dom/vitest` augments its own matchers separately.
 */
import "vitest";

declare module "vitest" {
  interface Assertion<T = unknown> {
    toHaveNoViolations(): T;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}
