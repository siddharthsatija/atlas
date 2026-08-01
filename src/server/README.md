# Server layer

Server-only code. Nothing here may be imported by a Client Component; modules that
touch secrets or the database import `server-only` so a mistaken import fails the build.

Boundaries are enforced by ESLint (`eslint.config.mjs`), not by review alone.

| Directory       | Owns                                                                  | Must never                                            |
| --------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| `auth/`         | Session verification, reauthentication                                | Trust a client-supplied identity                      |
| `services/`     | Business rules, authorization, orchestration, event emission          | Touch the database client, import React               |
| `repositories/` | Data access, encryption/decryption, mapping to domain types           | Contain business rules, call a service                |
| `ai/`           | Provider adapter, prompt registry, policy layer                       | Read records directly (goes through the policy layer) |
| `jobs/`         | Background work: sweeps, recalculation, follow-ups, exports, deletion | Send anything externally                              |
| `audit/`        | The append-only audit writer and the shared activity+audit emitter    | Record unallowlisted context                          |

## Non-negotiables

- **Every service method verifies ownership server-side.** RLS is defense in depth,
  not the authorization design (security §6).
- **Never trust a `user_id` argument** that originated client-side.
- **One writer per derived value.** Only `PrivacyScoreService` writes score snapshots;
  only the findings engine creates or resolves findings (ADR-001, ADR-004).
- **Activity and audit are emitted together** from one call site so the two records
  cannot drift (ADR-006).
- **Deterministic logic is pure and separate** — rules, score factors, and the request
  state machine are unit-testable without a database.
- **AI is advisory.** It never writes a stored value and never triggers an external action.

Service interfaces: `docs/02-technical-architecture.md` §9.
Working guidance: `.claude/skills/backend/SKILL.md`.
