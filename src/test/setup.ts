import "@testing-library/jest-dom/vitest";
import { afterEach, expect, vi } from "vitest";
import { toHaveNoViolations } from "jest-axe";

// Component-level accessibility assertions (jest-axe). Route-level axe checks
// run in Playwright — see tests/a11y.
expect.extend(toHaveNoViolations);

// @testing-library/react cleans up automatically because vitest exposes a global
// `afterEach` (globals: true), so no manual cleanup is registered here.
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Time is injected in Atlas tests, never read ambiently.
 * Findings rules and follow-up jobs depend on controllable time
 * (.claude/skills/testing/SKILL.md).
 */
export const FIXED_NOW = new Date("2026-07-29T12:00:00.000Z");

/**
 * Browser shims, applied only in the jsdom (unit) project.
 *
 * The integration project runs in the `node` environment, where `window` does not
 * exist and these would throw during setup — taking the whole suite with them
 * before a single test ran. The guard keeps one setup file serving both projects.
 */
if (typeof window !== "undefined") {
  // matchMedia is required by next-themes and by reduced-motion behavior.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // ResizeObserver is required by several Radix primitives under jsdom.
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  /**
   * Pointer capture, which jsdom does not implement at all.
   *
   * Radix Toast's swipe-to-dismiss handler calls `target.hasPointerCapture(...)`
   * on every pointer-down. Without these, any `userEvent.click` inside a toast
   * throws `TypeError: target.hasPointerCapture is not a function` — surfacing
   * as six unhandled errors that vitest correctly warns "might cause false
   * positive tests", while the assertions themselves still passed.
   *
   * Shimmed rather than worked around: the alternative was to stop using real
   * pointer events in those tests, which would mean no longer exercising the
   * primitive's own behaviour. This is a gap in the environment, not in the
   * product, so it belongs here beside the other jsdom shims.
   *
   * Deliberately inert. Nothing in Atlas reads pointer capture, and a shim that
   * pretended to track captured pointers would be inventing behaviour no test
   * has asked for.
   */
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
