---
name: design-system
description: Atlas design tokens, typography, color, spacing, radius, elevation, icons, component inventory, visual hierarchy, animation principles, and the accessibility requirements baked into the visual layer. Use when building UI primitives, styling components, or reviewing visual work.
---

# Atlas Design System

**Source of truth:** `docs/06-design-system.md` (tokens and components) and `docs/04-frontend-specification.md` (layout and behavior). Baseline palette values are in design system §2.1.

## Purpose

Make complex privacy information feel calm, precise, and premium — and make that consistency cheap to maintain through semantic tokens rather than ad hoc styling.

## Core principles

1. **Semantic tokens only.** Components reference `surface`, `text-secondary`, `danger` — never raw hex or Tailwind palette names like `slate-500`.
2. **Borders and tonal contrast before shadows.** Elevation is restrained.
3. **Not everything looks the same.** Card weight and radius reflect importance; the score card is not a generic metric card.
4. **Color is never the only signal.** Severity and status always carry text.
5. **Danger is rare.** Reserved for destructive actions and verified critical risk.
6. **Dark mode is a token concern**, handled at the variable level — never per-component overrides.

## Tokens

### Color

Semantic roles (design system §2): `background`, `surface`, `surface-raised`, `surface-subtle`, `text-primary`, `text-secondary`, `text-muted`, `border-default`, `border-strong`, `accent`, `accent-subtle`, `success`, `warning`, `danger`, `info`.

Baseline light/dark values are tabulated in design system §2.1. Rules when implementing (ATL-008):

- Every text-on-surface pairing must pass WCAG 2.2 AA (4.5:1 body, 3:1 large text and UI boundaries). Verify programmatically, not by eye.
- Adjustments to the baseline stay within the same hue family and get documented.
- Never introduce a new semantic role without adding it to the documentation.
- Status and severity colors always accompany a text label.

### Typography

Inter or a similarly neutral sans. Scale: Display 40/48 semibold · H1 32/40 semibold · H2 24/32 semibold · H3 20/28 semibold · Body large 18/28 · Body 16/24 · Body small 14/20 · Label 13/18 medium · Caption 12/16.

- Use tabular numerals for scores, metrics, and timestamps so values do not jitter as they update.
- One H1 per page; heading levels never skip (see `accessibility`).
- Body text does not go below 14 px for content; 12 px is for captions only.

### Spacing

Base unit 4 px. Sequence: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80. Card padding: compact 16, standard 20–24, prominent 28–32.

### Radius

Small controls 8 · inputs and buttons 10 · standard cards 14 · prominent panels 18 · modals 20 · pills full. **Do not give every container the same radius** — differentiation carries hierarchy.

### Elevation

Level 0 none · 1 subtle card separation · 2 floating panel or dropdown · 3 modal. Shadows soft and restrained; prefer a border plus tonal shift.

### Motion

Standard 150–220 ms; larger panels 220–300 ms; ease-out entering, ease-in exiting. Motion explains hierarchy or state change. No ambient or continuous animation. `prefers-reduced-motion` reduces to opacity or none while preserving meaning.

## Icons

- One family: Lucide. Consistent stroke width.
- Icons never replace unfamiliar concepts — pair with a label or an accessible name.
- Icon-only controls require `aria-label`.
- Service logos are a separate concern from interface icons; treat them as content (optimize, handle missing logos with a neutral fallback).

## Components

Required inventory (design system §16): AppShell, Sidebar, TopBar, CommandSearch, MetricCard, PrivacyScore, AssetCard, InsightCard, AssistantCard, ActivityItem, StatusBadge, SeverityBadge, SourceLabel, ConfidenceIndicator, EmptyState, DataTable, FilterBar, Dialog, Drawer, Sheet, Toast, FormField, SensitiveValue, Timeline, ChartContainer.

Notes on the Atlas-specific ones:

- **SensitiveValue** is a security primitive, not a display nicety: masked by default, explicit and temporary reveal, keyboard accessible, emits an audit hook on reveal (ATL-035).
- **SourceLabel** and **ConfidenceIndicator** appear wherever a factual claim appears — every finding shows source and confidence (frontend §8).
- **PrivacyScore** must handle not-yet-scored, demo-labeled, and scored states, plus coverage messaging (ADR-004).
- **StatusBadge** covers neutral, active, pending, completed, archived, rejected. **SeverityBadge** covers low, medium, high, critical.
- Cards deliberately differ: Metric, Asset, Insight, Assistant, Activity, EmptyState, Settings section.

### Buttons

Variants: primary, secondary, tertiary, destructive, icon, link. Sizes 32 / 40 / 48 px. Every variant implements hover, focus, pressed, disabled, and loading.

- One primary action per card or section; keep action count low.
- Destructive variant only for genuinely destructive operations, always with explicit confirmation copy.

### Forms

Labels visible, placeholders are not labels, help text before errors, errors explain recovery, sensitive fields masked with explicit reveal, destructive confirmations never rely on a vague "OK".

## Visual hierarchy

The dashboard is the test case (frontend §5):

1. Score card carries the most weight (prominent padding, larger radius, arc indicator).
2. Supporting metrics are lighter and uniform among themselves — exactly four cards total including the score.
3. Insights are prioritized, one primary action each.
4. The assistant sits after primary content and never outweighs user data.
5. Activity is compact and quiet.

Density: dashboard medium · detail pages progressive disclosure · settings compact but readable · mobile preserves priority rather than desktop density.

## Common mistakes

- Raw hex or Tailwind color names in a component instead of semantic tokens.
- Adding a shadow where a border and tonal shift would do.
- Uniform radius everywhere, flattening hierarchy.
- Severity or status conveyed by color alone.
- Using the danger token for a warning or for emphasis.
- Icon-only buttons without accessible names.
- Proportional numerals in score and metric displays (values jitter).
- Dark-mode fixes applied per component instead of at the token layer.
- Introducing a fifth metric card, breaking the four-card row.
- Letting the assistant card visually compete with the score.

## Decision framework

**Need a new color?** Map it to an existing semantic role first. New roles require a documentation change and a contrast audit.

**Border or shadow?** Border and tonal contrast by default; shadow only for genuinely floating surfaces (dropdown, modal).

**Which radius?** Match the container's tier (control, input, card, panel, modal). If you are unsure of the tier, you are probably nesting incorrectly.

**New component or variant?** New component when behavior differs; variant when only appearance differs. If a variant matrix exceeds a handful of options, split it.

**Emphasis conflict?** Rank by what the user owns: their data first, guidance second, AI third.

## Review checklist

Full list in `checklists.md`. Fast pass:

- [ ] Semantic tokens only; no raw hex or palette names
- [ ] Contrast verified for all pairings in both modes
- [ ] Severity and status carry text, not just color
- [ ] Radius and elevation reflect hierarchy tiers
- [ ] Icon-only controls have accessible names
- [ ] Tabular numerals for scores, metrics, timestamps
- [ ] Motion within duration bands and reduced-motion safe
- [ ] Danger styling reserved; one primary action per section
