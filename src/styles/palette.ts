import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLOR_ROLES, type ColorRole } from "@/config/design-tokens";
import type { Mode } from "./contrast";

/**
 * Reads the semantic colour palette out of `tokens.css` (ATL-008).
 *
 * The tests parse the **shipped stylesheet** rather than a duplicated table of
 * values. A second copy of the palette would let the verified values and the
 * rendered values drift apart, which is precisely the failure this ticket exists
 * to prevent.
 */

const TOKENS_CSS = join(import.meta.dirname, "tokens.css");

/** Re-exported from the shared list so verification and display cannot drift. */
export const REQUIRED_COLOR_ROLES = COLOR_ROLES;
export type { ColorRole };

/**
 * Roles that are intentionally identical in both modes. A scrim darkens whatever
 * sits behind it, so it does not invert with the theme.
 */
export const MODE_INVARIANT_ROLES: readonly ColorRole[] = ["scrim"];

function readTokensCss(): string {
  return readFileSync(TOKENS_CSS, "utf8");
}

/** The `@theme { … }` block holds light mode; `.dark { … }` overrides it. */
function extractBlock(css: string, mode: Mode): string {
  if (mode === "light") {
    const start = css.search(/@theme\s*\{/);
    if (start === -1) throw new Error("tokens.css: no @theme block found");
    const end = css.indexOf("@layer theme");
    return css.slice(start, end === -1 ? undefined : end);
  }
  const start = css.indexOf(".dark {");
  if (start === -1) throw new Error("tokens.css: no .dark block found");
  return css.slice(start);
}

function parseColorDeclarations(block: string): Record<string, string> {
  const palette: Record<string, string> = {};
  for (const match of block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8});/g)) {
    const [, role, value] = match;
    if (role !== undefined && value !== undefined) palette[role] = value;
  }
  return palette;
}

/**
 * Resolved palette for a mode. Dark mode inherits any role it does not override,
 * exactly as the cascade does at runtime.
 */
export function readPalette(mode: Mode): Record<string, string> {
  const css = readTokensCss();
  const light = parseColorDeclarations(extractBlock(css, "light"));
  if (mode === "light") return light;
  return { ...light, ...parseColorDeclarations(extractBlock(css, "dark")) };
}

/** Roles explicitly declared in a mode's own block (not inherited). */
export function readDeclaredRoles(mode: Mode): string[] {
  return Object.keys(parseColorDeclarations(extractBlock(readTokensCss(), mode)));
}

export { readTokensCss };
