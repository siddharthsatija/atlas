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
- `success`
- `warning`
- `danger`
- `info`

Rules:

- Danger is reserved for destructive actions or verified critical risk.
- Severity never relies on color alone.
- Dark mode is supported from token level.
- Decorative gradients must remain subtle and never reduce readability.

### 2.1 Baseline palette values

Starting values for ATL-008. These are the implementation baseline; every text/background pairing must be verified against WCAG 2.2 AA contrast during token implementation, and adjustments stay within these hue families.

| Token            | Light                   | Dark      |
| ---------------- | ----------------------- | --------- |
| `background`     | `#F8F9FB`               | `#101216` |
| `surface`        | `#FFFFFF`               | `#171A20` |
| `surface-raised` | `#FFFFFF` (elevation 2) | `#1E222A` |
| `surface-subtle` | `#F1F3F6`               | `#14171C` |
| `text-primary`   | `#16181D`               | `#F2F4F8` |
| `text-secondary` | `#4A5160`               | `#B4BAC7` |
| `text-muted`     | `#6E7688`               | `#838B9B` |
| `border-default` | `#E3E6EC`               | `#262B34` |
| `border-strong`  | `#C9CEDA`               | `#3A4150` |
| `accent`         | `#4F5BD5`               | `#7B86E8` |
| `accent-subtle`  | `#EEF0FC`               | `#232848` |
| `success`        | `#1F7A4D`               | `#3DA972` |
| `warning`        | `#B0680F`               | `#D08C2E` |
| `danger`         | `#B3352E`               | `#E06A5F` |
| `info`           | `#2563A8`               | `#5B9BD8` |

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
