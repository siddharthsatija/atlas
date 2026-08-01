# Features

Feature-first organization. A feature owns its UI, input schemas, and server-action
wrappers:

```
src/features/<feature>/
  components/    feature-specific composition
  hooks/         feature-local hooks
  actions.ts     server actions — authenticate, validate, delegate, map errors
  schemas.ts     Zod schemas for this feature's inputs
```

Planned features (architecture §6.3): `auth`, `onboarding`, `dashboard`, `assets`,
`findings`, `requests`, `activity`, `assistant`, `settings`.

## Rules

- **Never import another feature's internals.** Shared code is promoted to
  `components/ui` or `lib/`. Enforced by ESLint.
- Features call **services** via server actions — never repositories, never the AI
  adapter, never the database client.
- Server actions stay thin: `requireSession()` → `schema.parse()` → service → map errors.
- Input schemas never accept an ownership field; the server supplies identity.
- Pages are Server Components; `"use client"` sits on the smallest interactive leaf.
