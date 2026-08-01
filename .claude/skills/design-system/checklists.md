# Design System Review Checklist

## Tokens

- [ ] No raw hex, rgb, or framework palette names in components
- [ ] Every color reference maps to a semantic role
- [ ] New semantic roles documented in `docs/06-design-system.md` before use
- [ ] Dark mode handled at the variable layer only
- [ ] Spacing values come from the 4 px sequence
- [ ] Radius matches the container tier (control / input / card / panel / modal)
- [ ] Elevation uses border and tonal contrast before shadow

## Contrast and color independence

- [ ] All text/background pairings pass WCAG 2.2 AA in light and dark
- [ ] Non-text UI boundaries and focus indicators meet 3:1
- [ ] Severity conveys meaning with text and icon, not color alone
- [ ] Status badges include text labels
- [ ] Charts distinguish series with markers or patterns, not color alone
- [ ] Danger token used only for destructive actions or verified critical risk

## Typography

- [ ] Scale values used as defined; no ad hoc font sizes
- [ ] One H1 per page; heading levels do not skip
- [ ] Tabular numerals for scores, metrics, and timestamps
- [ ] Content text no smaller than 14 px; 12 px reserved for captions

## Components

- [ ] Reuses the required component inventory rather than re-implementing
- [ ] Card type matches purpose; cards do not all look identical
- [ ] One primary action per card or section
- [ ] Every button variant implements hover, focus, pressed, disabled, loading
- [ ] Icon-only controls have accessible names
- [ ] Icons paired with labels for unfamiliar concepts
- [ ] Service logos handle the missing-logo case with a neutral fallback

## Atlas-specific primitives

- [ ] `SensitiveValue` masks by default with explicit, temporary, keyboard-accessible reveal
- [ ] Reveal emits the server-side audit hook
- [ ] `SourceLabel` and `ConfidenceIndicator` present wherever a factual claim is shown
- [ ] `PrivacyScore` handles not-yet-scored, demo, scored, and coverage messaging
- [ ] `EmptyState` explains the concept and offers a next step

## Hierarchy

- [ ] Score card is visually heaviest; metrics row is exactly four cards
- [ ] Assistant does not outweigh user-owned data
- [ ] Density appropriate per surface (dashboard medium, settings compact, mobile prioritized)
- [ ] Progressive disclosure used on detail pages rather than dumping all sections

## Motion

- [ ] Durations within 150–220 ms (standard) or 220–300 ms (panels)
- [ ] Ease-out entering, ease-in exiting
- [ ] Motion communicates hierarchy or state change, not decoration
- [ ] No ambient or looping animation
- [ ] `prefers-reduced-motion` respected without losing meaning
- [ ] No heavy animation library added for basic transitions
