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
}
