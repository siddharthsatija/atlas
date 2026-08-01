---
name: accessibility
description: WCAG 2.2 AA compliance for Atlas covering keyboard navigation, focus management, screen readers, forms, dialogs, reduced motion, color contrast, charts, and the accessibility testing checklist. Use when building any UI, and always before marking a UI ticket done.
---

# Atlas Accessibility

**Sources of truth:** `docs/04-frontend-specification.md` §20, `docs/01-product-requirements.md` NFR-03. Target: **WCAG 2.2 AA**, a launch criterion (PRD §14), not a stretch goal.

## Purpose

Atlas helps people control sensitive information about themselves. If someone cannot operate it with a keyboard or a screen reader, they cannot exercise that control. Accessibility here is part of the product promise.

## Core principles

1. Every action reachable and completable by keyboard alone.
2. Focus is always visible and always somewhere sensible.
3. Information is never conveyed by color alone.
4. Anything asynchronous is announced.
5. Motion is optional; meaning is not.
6. Icon-only controls always have names.
7. Masked-value reveal must be operable without a pointer.

## Keyboard navigation

- Tab order follows visual order. Never use positive `tabindex`.
- Interactive elements are real semantic elements: `<button>`, `<a href>`, `<input>`. A `div` with an onClick is a defect.
- `tabindex="-1"` only for programmatic focus targets (dialog containers, error summaries).
- Hover-revealed actions must be reachable by keyboard — Atlas requires an overflow menu equivalent for every hover action (frontend §5.3).
- Provide a skip-to-content link as the first focusable element in the shell.
- Command palette opens by shortcut and by visible trigger; both paths tested.
- Roving tabindex for composite widgets (menus, tabs): arrow keys move within, Tab moves out.

Expected key support:

| Component               | Keys                                                          |
| ----------------------- | ------------------------------------------------------------- |
| Dialog / drawer / sheet | Escape closes; Tab cycles inside; focus returns to trigger    |
| Dropdown / menu         | Arrows move, Enter/Space select, Escape closes, Home/End jump |
| Tabs                    | Arrows switch, Tab exits the tablist                          |
| Command palette         | Arrows navigate, Enter selects, Escape closes                 |
| Table / list rows       | Tab reaches row actions; no pointer-only affordances          |

## Focus management

- Visible focus indicator on every focusable element, meeting 3:1 contrast against adjacent colors. Never `outline: none` without an equivalent replacement.
- **Route transitions:** move focus to the new page's H1 (or main landmark) and announce the page name.
- **Dialogs:** trap focus, focus the first meaningful element (not the close button when a heading or field is more useful), restore focus to the trigger on close.
- **Multi-step modals:** on step change, move focus to the new step's heading and announce the step.
- **Error submission:** focus the error summary, which links to each invalid field.
- **Async content replacing a region:** keep focus stable; do not yank it to newly loaded content unless the user initiated navigation.
- **Destructive confirmations:** focus the safe (cancel) action by default.

## Screen readers

- Semantic landmarks: one `<main>`, plus `<nav>`, `<header>`, `<aside>` as appropriate.
- Logical heading hierarchy: one H1 per page, no skipped levels.
- Accessible names for all icon-only controls (`aria-label`), and for the sidebar collapse control the name must convey state.
- Use `aria-live="polite"` for status (score updated, draft saved, notification arrived) and `aria-live="assertive"` sparingly for errors.
- `aria-busy` or a visible loading message during long AI operations — plus a cancel control (NFR-01).
- Decorative icons get `aria-hidden="true"`.
- Do not announce raw sensitive values. Masked values announce as masked; the reveal button announces the action, and the revealed value is announced only after the user's explicit action.
- Tables use real `<table>` semantics with `<caption>` or an accessible name, `<th scope>` on headers.
- Badges convey meaning in text so a screen reader hears "Severity: high", not just a color swatch.

## Forms

- Every input has a visible, programmatically associated `<label>`. Placeholders are never labels.
- Help text and errors associated via `aria-describedby`; invalid fields carry `aria-invalid="true"`.
- Errors explain how to recover, in text — not only a red border.
- Required fields marked in text, not only with an asterisk color.
- Grouped controls (the request modal's field checkboxes) wrapped in `<fieldset>` with a `<legend>`.
- Error summary at the top of the form on submit failure, focusable and linked to fields.
- Autocomplete attributes where a value is a standard personal field, which also helps the personal-fields flow.

## Dialogs

Requirements for every Dialog/Drawer/Sheet (ATL-009):

- `role="dialog"` with `aria-modal="true"` and an accessible name from its heading.
- Focus trap while open; Escape closes; background content is inert.
- Focus returns to the invoking control on close.
- Scrim click closes only when the action is non-destructive and no unsaved work would be lost — the request modal must confirm before discarding an edited draft.

## Reduced motion

- Respect `prefers-reduced-motion: reduce`: replace transforms and slides with instant or opacity-only changes.
- Never convey state exclusively through animation.
- No parallax, autoplay, or continuous ambient motion anywhere in Atlas.

## Color contrast

- Body text 4.5:1; large text (≥18.66 px bold or ≥24 px) 3:1; UI components and focus indicators 3:1.
- Verify programmatically over the token matrix in both light and dark modes (ATL-008) — never approve by eye.
- Never use color as the only carrier of meaning: severity, status, chart series, validation state, and score bands all require text or shape.

## Charts

- Every chart has a text summary conveying the same insight (frontend §12, design system §13).
- Axes and units labeled; series distinguished by markers or patterns.
- Data available in an accessible form (summary sentence or adjacent table) so the chart is never the only path to the information.

## Common mistakes

- `div` or `span` with onClick instead of a button.
- `outline: none` with no replacement focus style.
- Hover-only row actions.
- Modal that closes on scrim click and silently discards a draft.
- Focus left on a removed element after a delete or filter change.
- Icon-only buttons with no `aria-label`.
- Placeholder used as the only label.
- Red border as the only error signal.
- Toast as the only notification of an important async result (durable status must also appear in the page).
- Announcing a full account identifier to a screen reader when the UI shows it masked.
- Skipping heading levels to get a particular font size — use tokens instead.

## Decision framework

**Can I use a `div` here?** Only if it is non-interactive. Anything clickable, focusable, or stateful uses the semantic element or a fully-implemented ARIA pattern.

**Custom widget or native?** Native first. Radix primitives second (they implement the ARIA patterns). Hand-rolled ARIA only with a documented reason and full keyboard tests.

**Where should focus go?** To the thing the user's action created or the thing they must act on next. If the triggering element disappeared, the nearest stable heading.

**Polite or assertive live region?** Polite for status and success; assertive only for errors that block progress.

**Is color enough?** Never. Add text or shape.

## Review checklist

Full version in `checklists.md`, which is the pre-merge gate for UI tickets. Fast pass:

- [ ] Complete keyboard operation, logical tab order, visible focus
- [ ] Focus managed on route change, dialog open/close, step change, error submit
- [ ] Semantic landmarks and heading hierarchy; one H1
- [ ] Icon-only controls named; decorative icons hidden
- [ ] Forms: labels, descriptions, `aria-invalid`, error summary
- [ ] Contrast verified in both modes; no color-only meaning
- [ ] `aria-live` for async status; long AI operations cancellable
- [ ] Reduced motion respected; charts have text alternatives
- [ ] Masked values not announced in full
