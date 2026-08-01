# hooks

Shared client hooks used across features. Feature-specific hooks live in
`src/features/<feature>/hooks/`.

## Before adding one

State lives at the lightest workable level (`.claude/skills/frontend/SKILL.md`):

1. **Server state** — fetch in a Server Component and pass props. Most Atlas state is this.
2. **URL state** — filters, sort, tab, pagination cursor.
3. **Local `useState`** — component-scoped interaction.
4. **`useReducer`** — multi-step flows with interdependent fields.
5. **React Hook Form** — any form with validation.

A hook that caches or mirrors server data is usually the wrong answer: a stale
privacy view is a correctness bug, not a cosmetic one. Revalidate after mutations
rather than patching client copies.

Never use `localStorage` or `sessionStorage` — prohibited for preferences and any
privacy-relevant value, and enforced by ESLint.
