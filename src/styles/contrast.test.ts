import { describe, expect, it } from "vitest";
import {
  TONE_TINT_ALPHA,
  WCAG_AA,
  blend,
  buildPairings,
  contrastRatio,
  evaluatePairings,
  floorTo2dp,
  parseHex,
  relativeLuminance,
  type Mode,
} from "./contrast";
import {
  MODE_INVARIANT_ROLES,
  REQUIRED_COLOR_ROLES,
  readDeclaredRoles,
  readPalette,
} from "./palette";

/**
 * ATL-008 — programmatic WCAG 2.2 AA verification of the token matrix.
 *
 * Values are read from the shipped `tokens.css`, so this asserts what actually
 * renders. Every required foreground/background combination is checked in **both**
 * modes; a failure names the pairing, its measured ratio, and its requirement.
 */

const MODES: Mode[] = ["light", "dark"];

describe("WCAG 2.2 contrast primitives", () => {
  it("computes the reference extremes exactly", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#4F5BD5", "#FFFFFF")).toBeCloseTo(
      contrastRatio("#FFFFFF", "#4F5BD5"),
      10,
    );
  });

  it("matches known relative luminance values", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 10);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 10);
    // sRGB mid grey is ~0.2159 relative luminance, not 0.5.
    expect(relativeLuminance("#808080")).toBeCloseTo(0.2159, 3);
  });

  it("parses shorthand and full hex", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("4F5BD5")).toEqual({ r: 79, g: 91, b: 213 });
  });

  it("rejects a non-hex value rather than silently scoring it", () => {
    expect(() => parseHex("rebeccapurple")).toThrow(/Not a hex colour/);
  });

  it("composites a translucent foreground over a background", () => {
    expect(blend("#000000", "#FFFFFF", 0.5)).toBe("#808080");
    expect(blend("#FFFFFF", "#000000", 0)).toBe("#000000");
    expect(blend("#FFFFFF", "#000000", 1)).toBe("#FFFFFF");
  });

  it("floors ratios so a displayed 4.50 is never a rounded-up 4.495", () => {
    expect(floorTo2dp(4.499)).toBe(4.49);
    expect(floorTo2dp(4.5)).toBe(4.5);
  });
});

describe("token palette", () => {
  it.each(MODES)("declares every required semantic role in %s mode", (mode) => {
    const palette = readPalette(mode);
    for (const role of REQUIRED_COLOR_ROLES) {
      expect(palette[role], `missing --color-${role} in ${mode}`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("overrides every colour role in dark mode at the token layer", () => {
    // Dark mode must switch at the token layer, not per component.
    const declared = readDeclaredRoles("dark");
    for (const role of REQUIRED_COLOR_ROLES) {
      expect(declared, `--color-${role} is not overridden in .dark`).toContain(role);
    }
  });

  it("uses a different value for every role between modes", () => {
    const light = readPalette("light");
    const dark = readPalette("dark");
    // Every role inverts with the theme except the documented mode-invariant ones.
    const shared = REQUIRED_COLOR_ROLES.filter(
      (role) => light[role] === dark[role] && !MODE_INVARIANT_ROLES.includes(role),
    );
    expect(shared).toEqual([]);
  });
});

describe.each(MODES)("WCAG 2.2 AA contrast — %s mode", (mode) => {
  const palette = readPalette(mode);
  const results = evaluatePairings(palette, mode);

  it("checks a non-trivial number of pairings", () => {
    // 8 text x 4 surfaces + 5 tones x 4 tints + 2 fills + 1 selected + 4 non-text.
    expect(results).toHaveLength(59);
  });

  it.each(results.map((r) => [`${r.foreground} on ${r.background}`, r] as const))(
    "%s",
    (_label, result) => {
      expect(
        result.ratio,
        `${result.foreground} (${result.foregroundValue}) on ${result.background} ` +
          `(${result.effectiveBackground}) = ${result.ratio}:1, needs ${result.minimum}:1 — ${result.usage}`,
      ).toBeGreaterThanOrEqual(result.minimum);
    },
  );

  it("reports zero failures across the whole matrix", () => {
    const failures = results.filter((r) => !r.passes);
    expect(failures.map((f) => `${f.foreground}/${f.background} ${f.ratio}`)).toEqual([]);
  });
});

describe("contrast contract", () => {
  it("uses the WCAG 2.2 AA thresholds", () => {
    expect(WCAG_AA).toEqual({ normalText: 4.5, largeText: 3, nonText: 3 });
  });

  it("does not require 3:1 of border-default, which is decorative", () => {
    // border-default separates surfaces; it never identifies a control, so
    // SC 1.4.11 does not apply. Interactive boundaries use border-strong.
    expect(buildPairings().some((p) => p.foreground === "border-default")).toBe(false);
    expect(buildPairings().some((p) => p.foreground === "border-strong")).toBe(true);
  });

  it("verifies the tone tint pattern actually used by badges", () => {
    expect(TONE_TINT_ALPHA).toBe(0.1);
    expect(buildPairings().some((p) => p.backgroundAlpha === TONE_TINT_ALPHA)).toBe(true);
  });

  it("verifies solid-fill foregrounds in both modes", () => {
    for (const mode of MODES) {
      const fills = evaluatePairings(readPalette(mode), mode).filter((r) =>
        r.foreground.endsWith("-foreground"),
      );
      expect(fills).toHaveLength(2);
      for (const fill of fills) expect(fill.passes).toBe(true);
    }
  });
});
