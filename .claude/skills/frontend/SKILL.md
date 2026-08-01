---
name: frontend
description: Atlas Next.js frontend guidance covering App Router structure, component composition, state management, forms, tables, dialogs, responsive design, loading/error/empty states, charts, and motion. Use when building or reviewing any UI surface.
---

# Atlas Frontend

**Sources of truth:** `docs/04-frontend-specification.md` (behavior and layout), `docs/06-design-system.md` (visual tokens and components). Architecture rules live in the `architecture` skill; accessibility requirements in the `accessibility` skill.

## Purpose

Build a calm, fast, accessible product shell where the user's data — not the framework or the AI — is the main event.

## Core principles

1. Server Components by default; client boundaries at the leaves.
2. Every interactive component implements all nine states (frontend §18): default, hover, focus, active, disabled, loading, error, success, empty.
3. Hover may enhance, never gate. Keyboard and touch parity is mandatory.
4. The user's data outweighs the assistant, visually and structurally.
5. Skeletons resemble final structure; no indefinite page-level spinners.
6. Never render an unmasked sensitive value by default.
7. Filters and search touch non-restricted fields only (encrypted columns are unsearchable by design, ADR-003).

## App Router structure

Route groups per architecture §6.1: `(public)`, `(auth)`, `(product)`, `api`.

- `(product)/layout.tsx` owns the shell (sidebar, top bar, content region) and the session guard.
- Pages are Server Components that fetch through services and pass plain props down.
- Use `loading.tsx` for route-level skeletons and `error.tsx` for route error boundaries (ATL-010).
- Never put sensitive values in route params or query strings (security §8). Filter state in the URL is fine; identifiers of restricted values are not.
- Dashboard reads go through the single aggregated query (ATL-019), not several parallel client fetches.

## Component structure

```
components/ui/          generic primitives (Button, Dialog, SensitiveValue, EmptyState)
components/layout/      AppShell, Sidebar, TopBar
features/<x>/components feature-specific composition
```

- Primitives are unaware of Atlas domain concepts. `SeverityBadge` takes a severity, not a finding.
- Feature components own layout and copy for their domain.
- Required reusable components are listed in design system §16; build them once and reuse.
- Composition over configuration: prefer `<Card><CardHeader/></Card>` to a `variant` matrix with fifteen options.

## State management

Use the lightest tool that works, in this order:

1. **Server state** — fetch in a Server Component and pass props. Most Atlas state is this.
2. **URL state** — filters, sort, tab selection, pagination cursors. Shareable and back-button friendly.
3. **Local `useState`** — component-scoped interaction (open/closed, revealed, hovered).
4. **`useReducer`** — multi-step flows with interdependent fields (the request modal).
5. **React Hook Form** — any form with validation (ATL-032, ATL-060).

Rules:

- No global client store in MVP. If you think you need one, the data probably belongs on the server.
- Never mirror server data into client state "for speed" — it desynchronizes and risks showing stale privacy information.
- After a mutation, revalidate the server data rather than patching client copies (architecture §15).
- **Never use `localStorage`/`sessionStorage` for anything privacy-relevant.** The sidebar collapse preference persists server-side per user (ATL-006).
- Optimistic UI only for reversible, non-external actions (archive, dismiss). Never for request transitions or anything with external meaning.

## Forms

- Labels always visible; placeholders are never labels (design system §11).
- Zod schema shared between client and server action — one definition, two uses.
- Help text appears before errors when both exist; errors explain recovery.
- Sensitive fields masked with explicit reveal.
- Preserve input on recoverable errors. Draft bodies autosave (NFR-02).
- Error summary at the top plus field-level errors, wired with `aria-describedby`.
- Submit buttons show loading state and disable to prevent double submission; server actions are idempotency-protected where transitions are involved.

## Tables and lists

- Card grid is the default for assets; compact list is optional (frontend §6).
- Dense enterprise tables are not the default anywhere.
- On mobile, tables become cards; horizontal scroll only when unavoidable.
- Server-side pagination, filtering, and sorting. Cursor pagination for activity and notifications.
- Every row action reachable by keyboard and via a touch overflow menu.
- Masked values in lists (e.g. request recipients) — no unmasked identifiers in bulk views.

## Dialogs, drawers, sheets

- Modals for focused, contained tasks (the request flow). Side panels for contextual inspection (finding detail, assistant).
- Requirements: focus trap, escape to close, focus return to trigger, scrim click where non-destructive.
- Multi-step modals preserve state across steps and survive accidental dismissal — the request modal must not lose an edited draft.
- Mobile: assistant and detail panels become bottom sheets or full-screen; navigation becomes a drawer, never a compressed rail.

## Loading, error, empty states

| State   | Requirement                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------- |
| Loading | Skeletons matching final structure; reserve layout space to avoid shift; `aria-live` for async status   |
| Error   | Calm recovery copy, retry where safe, user input preserved, no provider text                            |
| Empty   | Explain the concept, offer the next step; distinguish "nothing yet" from "nothing matched your filters" |

Atlas-specific states that are easy to forget and are explicitly required:

- **Score: not-yet-scored** (no non-demo asset) and **demo score** (labeled) — frontend §5.2.
- **Findings: empty** — explain findings come from the user's own data, not scanning.
- **AI unavailable** — deterministic fallback, editable template, no provider error text (ATL-052).
- **Mailto too long** — action disabled with copy guidance above ~1,800 characters (ATL-062).
- **Filtered-empty** vs first-run empty on every list.

## Charts

- Charts only where they improve comprehension (design system §13). Recharts, lazy-loaded.
- Always provide a text summary; never rely on color alone; label axes and units.
- Limit series; no 3D or decorative effects.
- Reserve container height to prevent layout shift.

## Motion

- Standard transitions 150–220 ms; larger panels 220–300 ms; ease-out entering, ease-in exiting.
- Motion explains hierarchy or state change. No ambient or continuous animation.
- Respect `prefers-reduced-motion` — reduce to opacity or none, never remove meaning.
- Avoid heavy animation libraries for basic transitions.

## Common mistakes

- `"use client"` at the top of a page because a child needs interactivity.
- Fetching protected data in a Client Component via an API route that re-implements authorization.
- Building only the happy path and skipping the four Atlas-specific states above.
- Hover-only row actions with no keyboard or touch path.
- Mirroring server data in client state and drifting.
- Using `localStorage` for preferences or any privacy-relevant value.
- Rendering an identifier or recipient unmasked in a list.
- Indefinite spinners for page loads instead of structural skeletons.
- Letting the assistant card visually dominate the dashboard.
- Adding a chart where a sentence would be clearer.

## Decision framework

**Server or Client Component?** See `architecture`. Default server; split rather than escalating the whole tree.

**Where does this state live?** Server → URL → local → reducer → form library. Stop at the first that works.

**Modal, panel, or page?** Contained task → modal. Inspecting something alongside context → side panel. Primary destination or deep content → page.

**Optimistic update?** Only if reversible and internal. Never for anything with external meaning.

**Table or cards?** Cards by default. Table only when comparing many records across the same fields, and it must become cards on mobile.

## Review checklist

Full version in `checklists.md`. Fast pass:

- [ ] All nine component states handled; Atlas-specific states (not-yet-scored, demo, AI-unavailable, filtered-empty) implemented
- [ ] Client boundary minimal; no server-only imports in client code
- [ ] Keyboard and touch parity for every hover action
- [ ] Sensitive values masked by default; nothing sensitive in URLs
- [ ] Loading uses structural skeletons; layout space reserved
- [ ] Forms preserve input; drafts autosave; errors explain recovery
- [ ] Motion respects reduced-motion; no ambient animation
- [ ] Charts have text alternatives and do not rely on color
