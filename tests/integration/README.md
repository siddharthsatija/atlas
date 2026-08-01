# Integration tests

Run against a **local** Supabase instance with migrations applied:

```bash
pnpm db:start
pnpm test:integration
```

## What belongs here

Per `docs/02-technical-architecture.md` §17 and `.claude/skills/testing/SKILL.md`:

- Authorization and RLS — the two-user matrix for every user-owned table (ATL-088)
- Service and repository behavior with ownership enforcement
- Findings generation and auto-resolution (ADR-001)
- Request transitions, including system-driven ones and idempotency replay
- Personal fields lifecycle (ADR-002)
- Notifications creation, preferences, read state (ADR-005)
- Audit writer immutability and chain verification (ADR-006)
- Export generation and account deletion, including crypto-shredding (ADR-003)

## Non-negotiable rules

- **Never mock the database here.** These tests exist to verify RLS and SQL behaviour.
- **Two users, always.** A single-user test proves nothing about isolation.
- **No production data.** Fixtures are synthetic and obviously so (`ada@example.test`).
- Each test creates and cleans up its own users; no shared mutable fixtures.
- Inject time (`FIXED_NOW` from `src/test/setup.ts`); never `sleep`.

The RLS matrix must be generated from the schema so that a new table without tests
fails CI — see the completeness guard in `.claude/skills/testing/examples.md`.
