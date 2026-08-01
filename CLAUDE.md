# CLAUDE.md

## Project

Atlas is a personal digital identity and privacy management product. Read the documents in `/docs` before implementation.

## Source-of-truth order

1. Security and access specification
2. Product requirements
3. Technical architecture
4. Frontend specification
5. AI behavior
6. Design system
7. Feature tickets

Architecture decision records in `docs/adr/` document the rationale behind major designs (findings engine, personal fields, encryption, score, notifications, audit logging) and carry the same authority as the documents they extend. Unresolved product decisions live in `docs/open-questions.md` — do not assume answers to them.

When documents conflict, security and explicit user control win.

## Working rules

- Do not invent product behavior.
- Do not expand MVP scope without documenting the change.
- Do not claim Atlas scans or deletes data unless the implemented system truly does.
- Never add autonomous external sending.
- Never expose secrets or service-role keys to the client.
- Never trust client-provided user IDs.
- Every user-owned table must have RLS and two-user tests.
- Use TypeScript strict mode.
- Validate inputs and AI outputs with schemas.
- Keep business logic out of UI components.
- Prefer server components for reads and server-only services for protected operations.
- Use semantic design tokens.
- Implement keyboard, touch, responsive, loading, empty, error, and success states.
- Do not log personal data, AI prompts, draft bodies, tokens, or account identifiers.
- Update documentation when architecture or behavior changes.

## Required commands before completion

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run build
```

Run relevant end-to-end and security tests for changed features.

## Implementation workflow

1. Select one ticket.
2. Read linked specs.
3. Identify data, security, UX, and test implications.
4. Write or update tests.
5. Implement the smallest complete vertical slice.
6. Run checks.
7. Review for personal-data leakage.
8. Update ticket notes and documentation.
9. Stop and report unresolved assumptions rather than guessing.

## UI rules

- Sidebar collapse control belongs beside the Atlas wordmark.
- AI is contextual and must not overpower the user’s data.
- Hover actions must have keyboard and touch equivalents.
- Danger styling is rare.
- Every finding shows source and confidence.
- Every score view explains limitations.
- Every destructive action uses explicit confirmation.

## AI rules

- Calls are server-only.
- Retrieve minimum necessary context.
- Validate structured output.
- AI can propose but cannot execute irreversible or external actions.
- Drafts use only user-approved fields.
- Label uncertainty and demo data.

## Database rules

- Migrations are append-only after shared deployment.
- Include indexes for foreign keys and common filters.
- Use transactions for multi-record state transitions.
- Every status change writes an audit-safe event.
- No production data in seeds or tests.

## Definition of done

A feature is not complete until:

- Acceptance criteria pass
- Authorization is tested
- Accessibility is reviewed
- Failure states work
- Sensitive telemetry is absent
- Documentation remains accurate
