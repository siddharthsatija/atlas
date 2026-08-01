/**
 * WCAG 2.2 contrast computation and the Atlas token pairing matrix (ATL-008).
 *
 * Contrast is verified programmatically, never by eye (accessibility skill).
 * Pure functions with no DOM dependency so the whole matrix can be asserted in
 * unit tests and regenerated into the token sheet.
 *
 * Reference: WCAG 2.2 relative luminance and contrast-ratio definitions.
 */

export type Mode = "light" | "dark";

/** WCAG 2.2 minimum ratios. */
export const WCAG_AA = {
  /** SC 1.4.3 — body text. */
  normalText: 4.5,
  /** SC 1.4.3 — large text (>=18.66px bold or >=24px). */
  largeText: 3,
  /** SC 1.4.11 — non-text UI components, boundaries, focus indicators. */
  nonText: 3,
} as const;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): Rgb {
  const value = hex.trim().replace(/^#/, "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex colour: "${hex}"`);
  }
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** sRGB channel to linear-light value (WCAG 2.2). */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.2 relative luminance. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.2 contrast ratio, always >= 1. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composites a translucent foreground over an opaque background.
 * Needed because Atlas renders tone badges as `bg-{tone}/10 text-{tone}`: the
 * effective background is a blend, not the raw surface.
 */
export function blend(foreground: string, background: string, alpha: number): string {
  const f = parseHex(foreground);
  const b = parseHex(background);
  const mix = (x: number, y: number) => Math.round(x * alpha + y * (1 - alpha));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(mix(f.r, b.r))}${hex(mix(f.g, b.g))}${hex(mix(f.b, b.b))}`.toUpperCase();
}

/** Rounds down to 2dp so a displayed 4.50 can never be a rounded-up 4.495. */
export function floorTo2dp(value: number): number {
  return Math.floor(value * 100) / 100;
}

/** Alpha used by the tone badge/callout pattern (design system §12). */
export const TONE_TINT_ALPHA = 0.1;

export interface Pairing {
  foreground: string;
  background: string;
  /** Minimum ratio this pairing must meet. */
  minimum: number;
  /** Why this pairing exists — surfaced in failures and in the token sheet. */
  usage: string;
  /** Alpha applied to the background token before compositing. */
  backgroundAlpha?: number;
}

/** Backgrounds any text may sit on. */
export const SURFACE_TOKENS = [
  "background",
  "surface",
  "surface-raised",
  "surface-subtle",
] as const;

/** Foreground roles used for text. */
export const TEXT_TOKENS = [
  "text-primary",
  "text-secondary",
  "text-muted",
  "accent",
  "success",
  "warning",
  "danger",
  "info",
] as const;

/** Tones rendered as `bg-{tone}/10 text-{tone}` by badges and callouts. */
export const TONE_TOKENS = ["accent", "success", "warning", "danger", "info"] as const;

/**
 * Every pairing Atlas must satisfy.
 *
 * `border-default` is deliberately absent: it provides decorative separation and
 * never carries information required to identify a control, so SC 1.4.11 does not
 * apply to it. Interactive boundaries use `border-strong`, which is included.
 */
export function buildPairings(): Pairing[] {
  const pairings: Pairing[] = [];

  for (const foreground of TEXT_TOKENS) {
    for (const background of SURFACE_TOKENS) {
      pairings.push({
        foreground,
        background,
        minimum: WCAG_AA.normalText,
        usage: "body text on a surface (SC 1.4.3)",
      });
    }
  }

  for (const tone of TONE_TOKENS) {
    for (const background of SURFACE_TOKENS) {
      pairings.push({
        foreground: tone,
        background,
        backgroundAlpha: TONE_TINT_ALPHA,
        minimum: WCAG_AA.normalText,
        usage: "tone text on its own 10% tint (badge / callout)",
      });
    }
  }

  // Solid fills: the foreground role must work against its own fill in both modes.
  pairings.push({
    foreground: "accent-foreground",
    background: "accent",
    minimum: WCAG_AA.normalText,
    usage: "label on a solid accent fill (primary button)",
  });
  pairings.push({
    foreground: "danger-foreground",
    background: "danger",
    minimum: WCAG_AA.normalText,
    usage: "label on a solid danger fill (destructive button)",
  });

  // Selected/active state: accent text on the subtle accent fill.
  pairings.push({
    foreground: "accent",
    background: "accent-subtle",
    minimum: WCAG_AA.normalText,
    usage: "selected navigation and accent badges",
  });

  // Non-text (SC 1.4.11).
  for (const background of ["background", "surface"] as const) {
    pairings.push({
      foreground: "border-strong",
      background,
      minimum: WCAG_AA.nonText,
      usage: "interactive component boundary (SC 1.4.11)",
    });
    pairings.push({
      foreground: "accent",
      background,
      minimum: WCAG_AA.nonText,
      usage: "focus indicator (SC 1.4.11)",
    });
  }

  return pairings;
}

export interface PairingResult extends Pairing {
  mode: Mode;
  foregroundValue: string;
  backgroundValue: string;
  /** Background after compositing, when an alpha is applied. */
  effectiveBackground: string;
  ratio: number;
  passes: boolean;
}

export function evaluatePairings(
  palette: Record<string, string>,
  mode: Mode,
  pairings: Pairing[] = buildPairings(),
): PairingResult[] {
  return pairings.map((pairing) => {
    const foregroundValue = palette[pairing.foreground];
    const backgroundValue = palette[pairing.background];

    if (foregroundValue === undefined || backgroundValue === undefined) {
      throw new Error(
        `Missing token in ${mode} palette: ${pairing.foreground} / ${pairing.background}`,
      );
    }

    const effectiveBackground =
      pairing.backgroundAlpha === undefined
        ? backgroundValue.toUpperCase()
        : blend(foregroundValue, backgroundValue, pairing.backgroundAlpha);

    const ratio = floorTo2dp(contrastRatio(foregroundValue, effectiveBackground));

    return {
      ...pairing,
      mode,
      foregroundValue: foregroundValue.toUpperCase(),
      backgroundValue: backgroundValue.toUpperCase(),
      effectiveBackground,
      ratio,
      passes: ratio >= pairing.minimum,
    };
  });
}
