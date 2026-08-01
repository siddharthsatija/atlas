# Frontend Review Checklist

## Component states (frontend §18)

- [ ] Default, hover, focus, active, disabled, loading, error, success, empty all implemented
- [ ] Skeletons resemble final structure; no indefinite page-level spinners
- [ ] Layout space reserved so async content does not shift the page
- [ ] `aria-live` used for asynchronous status changes

## Atlas-specific states

- [ ] Score: not-yet-scored state (no non-demo asset)
- [ ] Score: demo state with persistent "Demo score" label
- [ ] Score: coverage note when factors were excluded
- [ ] Findings empty state explains findings come from the user's own records
- [ ] AI-unavailable fallback with editable deterministic template, no provider error text
- [ ] Mailto over length threshold disables the action and steers to copy
- [ ] Filtered-empty distinguished from first-run empty on every list
- [ ] New-account dashboard offers a meaningful first action

## Rendering and data

- [ ] Protected data read in Server Components
- [ ] `"use client"` at the smallest leaf; no server-only module imported in client code
- [ ] Props contain only rendered values (no full records, no unrevealed sensitive values)
- [ ] Mutations go through server actions; data revalidated rather than patched client-side
- [ ] Dashboard uses the aggregated query, not several client fetches
- [ ] No `localStorage`/`sessionStorage` for preferences or privacy-relevant values

## Sensitive data in the UI

- [ ] Identifiers, emails, recipients masked by default via `SensitiveValue`
- [ ] Reveal is explicit, temporary, and keyboard accessible
- [ ] No sensitive values in URLs, query strings, or analytics payloads
- [ ] Lists and tables show masked values only
- [ ] Filters and search operate on non-restricted fields only

## Forms

- [ ] Zod schema shared between client and server
- [ ] Labels visible; placeholders not used as labels
- [ ] Help text before errors; errors explain recovery
- [ ] Error summary plus field-level errors, correctly associated
- [ ] Input preserved on recoverable errors; drafts autosave
- [ ] Double submission prevented; loading state on submit

## Interaction parity

- [ ] Every hover action has keyboard and touch equivalents (overflow menu)
- [ ] Targets meet 44x44 CSS px where practical
- [ ] Dialogs and drawers: focus trap, escape, focus return
- [ ] Multi-step flows preserve state across steps and accidental dismissal
- [ ] Destructive actions use explicit language; archive and dismiss offer undo

## Responsive

- [ ] Verified at small (<640), medium (640–1023), large (1024–1439), xl (1440+)
- [ ] Sidebar becomes a drawer on mobile, not a compressed rail
- [ ] Tables become cards on mobile
- [ ] Assistant becomes bottom sheet or full-screen panel on mobile
- [ ] Content max width respected (~1440 px)

## Charts and motion

- [ ] Chart has a text summary; axes and units labeled
- [ ] No reliance on color alone; markers or patterns distinguish series
- [ ] Charts lazy-loaded
- [ ] Transitions within 150–300 ms and purposeful
- [ ] `prefers-reduced-motion` respected without losing meaning

## Hierarchy

- [ ] Score card carries more emphasis than supporting metrics
- [ ] Metrics row is exactly four cards
- [ ] Assistant does not visually outweigh user data
- [ ] Danger styling reserved for destructive actions or verified critical risk
- [ ] Severity conveyed with text, not color alone
