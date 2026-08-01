# Atlas Design System Specification

## 1. Design direction

Atlas is calm, precise, premium, and human. The design system should make complex privacy information feel understandable and actionable.

## 2. Semantic color roles

Use semantic tokens rather than raw color names in components.

- `background`: page canvas
- `surface`: standard cards and panels
- `surface-raised`: dialogs and elevated panels
- `surface-subtle`: quiet grouped sections
- `text-primary`
- `text-secondary`
- `text-muted`
- `border-default`
- `border-strong`
- `accent`
- `accent-subtle`
- `accent-foreground`
- `success`
- `warning`
- `danger`
- `danger-foreground`
- `info`
- `scrim`

Rules:

- Danger is reserved for destructive actions or verified critical risk.
- Severity never relies on color alone.
- Dark mode is supported from token level.
- Decorative gradients must remain subtle and never reduce readability.

### 2.1 Baseline palette values

Baseline values. ATL-008 verified every pairing programmatically against WCAG 2.2 AA
and adjusted seven values within their hue families; the table below is the **verified**
palette, and the adjustments are recorded in §2.2.

The implemented source of truth is `src/styles/tokens.css`; verification lives in
`src/styles/contrast.test.ts` and the generated sheet in
`src/styles/__snapshots__/token-sheet.md`.

| Token            | Light                   | Dark      |
| ---------------- | ----------------------- | --------- |
| `background`     | `#F8F9FB`               | `#101216` |
| `surface`        | `#FFFFFF`               | `#171A20` |
| `surface-raised` | `#FFFFFF` (elevation 2) | `#1E222A` |
| `surface-subtle` | `#F1F3F6`               | `#14171C` |
| `text-primary`   | `#16181D`               | `#F2F4F8` |
| `text-secondary` | `#4A5160`               | `#B4BAC7` |
| `text-muted`     | `#686F80`               | `#838B9B` |
| `border-default` | `#E3E6EC`               | `#262B34` |
| `border-strong`  | `#8590AC`               | `#5B667D` |
| `accent`         | `#4C58D4`               | `#828DE9` |
| `accent-subtle`  | `#EEF0FC`               | `#212644` |
| `success`        | `#1E7449`               | `#3DA972` |
| `warning`        | `#95580D`               | `#D08C2E` |
| `danger`         | `#B3352E`               | `#E27267` |
| `info`           | `#2563A8`               | `#5B9BD8` |
| `accent-foreground` | `#FFFFFF`            | `#101216` |
| `danger-foreground` | `#FFFFFF`            | `#101216` |

### 2.2 Verified deviations from the starting values (ATL-008)

Every change preserves hue and saturation and adjusts lightness only.

| Token | Mode | Was | Now | Why |
| --- | --- | --- | --- | --- |
| `text-muted` | light | `#6E7688` | `#686F80` | 4.10:1 on `surface-subtle` — below 4.5 |
| `warning` | light | `#B0680F` | `#95580D` | 3.91:1 on `surface-subtle`, and 4.43:1 on its own 10% tint |
| `accent` | light | `#4F5BD5` | `#4C58D4` | 4.37:1 on its own 10% tint |
| `success` | light | `#1F7A4D` | `#1E7449` | 4.20:1 on its own 10% tint over `surface-subtle` |
| `border-strong` | light | `#C9CEDA` | `#8590AC` | 1.50:1 — below the 3:1 required of an interactive boundary (SC 1.4.11) |
| `accent` | dark | `#7B86E8` | `#828DE9` | 4.23:1 on its own 10% tint over `surface-raised` |
| `accent-subtle` | dark | `#232848` | `#212644` | accent text on it measured 4.37:1 |
| `danger` | dark | `#E06A5F` | `#E27267` | 4.4:1 on its own 10% tint |
| `border-strong` | dark | `#3A4150` | `#5B667D` | 1.83:1 — below 3:1 (SC 1.4.11) |

### 2.3 Two roles added

A single `white` foreground cannot serve solid fills in both modes: dark-mode
`accent` is intentionally light, so white-on-accent measures 3.27:1 there. Two
roles were added so the token layer can express an accessible solid fill:

- `accent-foreground` — label on a solid `accent` fill (primary button)
- `danger-foreground` — label on a solid `danger` fill (destructive button)

Components must use these rather than a literal colour.

### 2.4 Border roles and SC 1.4.11

- `border-default` provides **decorative** separation. It never carries information
  needed to identify a control, so the 3:1 non-text requirement does not apply.
- `border-strong` is the token for **interactive component boundaries** (inputs,
  selected states) and meets 3:1 against `background` and `surface` in both modes.

## 3. Typography

Recommended family: Inter or a similarly neutral, highly legible sans serif.

Scale:

- Display: 40/48, semibold
- H1: 32/40, semibold
- H2: 24/32, semibold
- H3: 20/28, semibold
- Body large: 18/28
- Body: 16/24
- Body small: 14/20
- Label: 13/18, medium
- Caption: 12/16

Use tabular numerals for scores, metrics, and timestamps where useful.

## 4. Spacing

Base unit: 4 px.

Preferred sequence:
4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80.

Card padding:

- Compact: 16
- Standard: 20 or 24
- Prominent: 28 or 32

## 5. Radius

- Small controls: 8 px
- Inputs and buttons: 10 px
- Standard cards: 14 px
- Prominent panels: 18 px
- Modal: 20 px
- Pills: full radius

Avoid giving every container the same radius.

## 6. Elevation

Use borders and tonal contrast before shadows.

- Level 0: no shadow
- Level 1: subtle card separation
- Level 2: floating panel or dropdown
- Level 3: modal

Shadows should be soft and restrained.

## 7. Grid

- Desktop: 12-column content grid
- Tablet: 8 columns
- Mobile: 4 columns
- Standard gap: 24 px desktop, 16 px mobile
- Main content max width: approximately 1440 px

## 8. Icons

- Use one icon family, preferably Lucide.
- Default stroke should remain consistent.
- Icons support labels and do not replace unfamiliar concepts.
- Service logos are treated separately from interface icons.

## 9. Buttons

Variants:

- Primary
- Secondary
- Tertiary
- Destructive
- Icon
- Link

Sizes:

- Small: 32 px
- Medium: 40 px
- Large: 48 px

Every variant includes hover, focus, pressed, disabled, and loading states.

## 10. Cards

Card types:

- Metric
- Asset
- Insight
- Assistant
- Activity
- Empty state
- Settings section

Cards should not all look identical. Visual hierarchy reflects importance and actionability.

## 11. Forms

- Labels remain visible.
- Placeholder text is not a label.
- Help text appears before errors when both exist.
- Errors explain how to recover.
- Sensitive fields are masked and reveal controls are explicit.
- Destructive confirmations do not rely on vague “OK” buttons.

## 12. Badges and severity

Status badges:

- Neutral
- Active
- Pending
- Completed
- Archived
- Rejected

Severity:

- Low
- Medium
- High
- Critical

Include text and optional icon. Never use color alone.

## 13. Charts

- Use charts only where they improve comprehension.
- Provide summary text.
- Label axes and units.
- Keep data series limited.
- Avoid decorative 3D effects.
- Use accessible patterns, labels, or markers when multiple series appear.

## 14. Motion

- Standard transition: 150–220 ms
- Larger panel transition: 220–300 ms
- Use ease-out for entrances and ease-in for exits
- Respect reduced motion
- Avoid continuous ambient animation
- Motion should explain hierarchy or state change

## 15. Content density

- Dashboard: medium density
- Detail pages: progressive disclosure
- Settings: compact but readable
- Mobile: preserve priority, not desktop density

## 16. Required reusable components

- AppShell
- Sidebar
- TopBar
- CommandSearch
- MetricCard
- PrivacyScore
- AssetCard
- InsightCard
- AssistantCard
- ActivityItem
- StatusBadge
- SeverityBadge
- SourceLabel
- ConfidenceIndicator
- EmptyState
- DataTable
- FilterBar
- Dialog
- Drawer
- Sheet
- Toast
- FormField
- SensitiveValue
- Timeline
- ChartContainer
