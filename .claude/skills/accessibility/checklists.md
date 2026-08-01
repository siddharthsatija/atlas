# Accessibility Review Checklist

**This is the pre-merge gate for every UI ticket.** WCAG 2.2 AA is a launch criterion.

## Keyboard

- [ ] Every action completable with keyboard alone
- [ ] Tab order matches visual order; no positive `tabindex`
- [ ] All interactive elements are semantic (`button`, `a href`, `input`) — no clickable `div`
- [ ] Hover-revealed actions have keyboard and touch equivalents
- [ ] Skip-to-content link is the first focusable element
- [ ] Dialogs: Escape closes, Tab cycles within, background inert
- [ ] Menus/tabs: arrow-key navigation, Escape closes, Tab exits composite
- [ ] Command palette reachable by shortcut and visible trigger
- [ ] No keyboard trap outside of intentional modal focus traps

## Focus

- [ ] Visible focus indicator on every focusable element, 3:1 contrast
- [ ] No `outline: none` without an equivalent replacement
- [ ] Route change moves focus to the page heading and announces it
- [ ] Dialog open focuses the most useful element; close restores to trigger
- [ ] Modal step change moves focus to the new step heading
- [ ] Form submit failure focuses the error summary
- [ ] Focus never stranded on a removed element (after delete, filter, or dismiss)
- [ ] Destructive confirmations default focus to the safe action

## Structure and semantics

- [ ] One `<main>`; `nav`/`header`/`aside` used appropriately
- [ ] One H1 per page; no skipped heading levels
- [ ] Lists use list semantics; tables use `table`/`th scope`/caption or accessible name
- [ ] Decorative icons `aria-hidden="true"`
- [ ] Icon-only controls have `aria-label`
- [ ] Sidebar collapse control's accessible name conveys state

## Forms

- [ ] Visible label associated with every input
- [ ] Placeholder never used as the label
- [ ] Help text and errors linked via `aria-describedby`
- [ ] `aria-invalid` set on invalid fields
- [ ] Error text explains recovery, not just failure
- [ ] Required state communicated in text
- [ ] Grouped controls wrapped in `fieldset`/`legend`
- [ ] Error summary present, focusable, and linked to fields
- [ ] Input preserved on error

## Announcements

- [ ] `aria-live="polite"` for status (saved, updated, notification received)
- [ ] `aria-live="assertive"` reserved for blocking errors
- [ ] Long AI operations expose progress and a cancel control
- [ ] Toasts are not the only signal for durable status
- [ ] Masked values are not announced in full; reveal is an explicit user action

## Color and contrast

- [ ] Body text 4.5:1; large text 3:1; UI boundaries and focus 3:1
- [ ] Verified programmatically in light and dark modes
- [ ] Severity, status, validation, and score bands carry text or shape
- [ ] Chart series distinguished by marker or pattern, not color alone

## Motion

- [ ] `prefers-reduced-motion` honored across all transitions
- [ ] No state communicated only through animation
- [ ] No autoplay, parallax, or ambient looping motion

## Charts and data

- [ ] Text summary conveys the same insight as the chart
- [ ] Axes and units labeled
- [ ] Data reachable without interpreting the visual

## Responsive and target size

- [ ] Targets 44x44 CSS px where practical
- [ ] Usable at 320 px width and at 200% zoom without loss of function
- [ ] Touch equivalents exist for all pointer-dependent interactions

## Automation

- [ ] axe smoke check passes for the route (ATL-091)
- [ ] Keyboard-only path test exists for the primary journey touched
- [ ] Screen-reader spot check performed on new complex widgets
