import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DURATION, EASING } from "@/config/design-tokens";

/**
 * SCAFFOLD VALIDATION — not a product test.
 *
 * Guards the rules in docs/06-design-system.md that are cheap to break silently:
 * every semantic role exists, names are unique, raw hex appears only in the token
 * source, and the TS motion constants stay aligned with the CSS.
 */

const ROOT = join(__dirname, "../..");
const tokensCss = readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8");

/** Semantic color roles required by design system §2. */
const REQUIRED_COLOR_ROLES = [
  "background",
  "surface",
  "surface-raised",
  "surface-subtle",
  "text-primary",
  "text-secondary",
  "text-muted",
  "border-default",
  "border-strong",
  "accent",
  "accent-subtle",
  "success",
  "warning",
  "danger",
  "info",
] as const;

const REQUIRED_RADIUS_TIERS = ["control", "input", "card", "panel", "modal"] as const;
const REQUIRED_SHADOW_LEVELS = ["level-1", "level-2", "level-3"] as const;
const REQUIRED_TEXT_SIZES = [
  "display",
  "h1",
  "h2",
  "h3",
  "body-lg",
  "body",
  "body-sm",
  "label",
  "caption",
] as const;

function themeBlock(): string {
  const start = tokensCss.search(/@theme\s*\{/);
  const end = tokensCss.indexOf("@layer theme");
  return tokensCss.slice(start, end === -1 ? undefined : end);
}

function darkBlock(): string {
  return tokensCss.slice(tokensCss.indexOf(".dark {"));
}

describe("design tokens", () => {
  it.each(REQUIRED_COLOR_ROLES)("defines the %s color role in light mode", (role) => {
    expect(themeBlock()).toMatch(new RegExp(`--color-${role}:\\s*#[0-9a-fA-F]{6};`));
  });

  it.each(REQUIRED_COLOR_ROLES)("overrides the %s color role in dark mode", (role) => {
    expect(darkBlock()).toMatch(new RegExp(`--color-${role}:\\s*#[0-9a-fA-F]{6};`));
  });

  it.each(REQUIRED_RADIUS_TIERS)("defines the %s radius tier", (tier) => {
    expect(tokensCss).toMatch(new RegExp(`--radius-${tier}:`));
  });

  it.each(REQUIRED_SHADOW_LEVELS)("defines shadow %s", (level) => {
    expect(tokensCss).toMatch(new RegExp(`--shadow-${level}:`));
  });

  it.each(REQUIRED_TEXT_SIZES)("defines the %s type size", (size) => {
    expect(tokensCss).toMatch(new RegExp(`--text-${size}:`));
  });

  it("declares every token name exactly once per theme block", () => {
    for (const [label, block] of [
      ["light", themeBlock()],
      ["dark", darkBlock()],
    ] as const) {
      const names = [...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]);
      const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
      expect(duplicates, `duplicate tokens in ${label} block`).toEqual([]);
    }
  });

  it("keeps motion constants aligned between CSS and TypeScript", () => {
    // Unavoidable duplication: Framer Motion takes numbers, not CSS variables.
    const standard = /--duration-standard:\s*(\d+)ms/.exec(tokensCss);
    const panel = /--duration-panel:\s*(\d+)ms/.exec(tokensCss);

    expect(standard).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(Number(standard?.[1])).toBe(DURATION.standard);
    expect(Number(panel?.[1])).toBe(DURATION.panel);
  });

  it("keeps easing curves aligned between CSS and TypeScript", () => {
    const entrance = /--ease-entrance:\s*cubic-bezier\(([^)]+)\)/.exec(tokensCss);
    const exit = /--ease-exit:\s*cubic-bezier\(([^)]+)\)/.exec(tokensCss);

    const parse = (m: RegExpExecArray | null) =>
      m?.[1]?.split(",").map((n) => Number(n.trim())) ?? [];

    expect(parse(entrance)).toEqual([...EASING.entrance]);
    expect(parse(exit)).toEqual([...EASING.exit]);
  });

  it("keeps motion durations within the bands in design system §14", () => {
    expect(DURATION.standard).toBeGreaterThanOrEqual(150);
    expect(DURATION.standard).toBeLessThanOrEqual(220);
    expect(DURATION.panel).toBeGreaterThanOrEqual(220);
    expect(DURATION.panel).toBeLessThanOrEqual(300);
  });
});
