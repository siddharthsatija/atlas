---
name: backend
description: Atlas backend guidance for services, repositories, DTOs, validation, API and server-action conventions, background jobs, rate limiting, error handling, and logging. Use when implementing server-side behavior, server actions, route handlers, or jobs.
---

# Atlas Backend

**Sources of truth:** `docs/02-technical-architecture.md` §9–14 (services, API conventions, lifecycle, jobs), `docs/03-security-and-access.md`. Layer rules live in the `architecture` skill.

## Purpose

Make server-side behavior predictable: authorization in one place, validation at every boundary, errors as typed codes, and jobs that can run twice without harm.

## Core principles

1. Authenticate before reading input; authorize before doing anything.
2. Validate every boundary with Zod — client input, provider responses, AI output, job payloads, JSON columns.
3. Services own rules and authorization; repositories own I/O.
4. Typed error codes out; provider errors never escape.
5. Idempotent transitions and jobs.
6. Deterministic business logic; AI is advisory.
7. Emit activity and audit from one call site.

## Services

- One service per domain concept (architecture §9). Public methods take `userId` derived from the verified session plus validated arguments.
- Every method verifies ownership before acting — RLS is a backstop, not the check.
- Services orchestrate: call repositories, other services, the emitter, and job enqueues. They do not render, and they do not talk to the database client directly.
- Keep pure logic (rules, score factors, state-machine validation) in separate pure modules so it is unit-testable without a database.
- Return domain objects or throw domain errors. No HTTP concepts inside a service.

## Repositories

- Only layer touching the database client. One per table or tightly coupled group.
- Handles encryption/decryption via the crypto module; services see plaintext domain objects.
- Parameterized queries; every read scoped by `user_id`; every write sets it from the session.
- Keyset pagination for growing collections; no encrypted-column filters.
- Maps rows to domain types — provider row types never escape.

## DTOs and type boundaries

Three distinct shapes; do not collapse them:

| Shape           | Lives in                | Purpose                                                                |
| --------------- | ----------------------- | ---------------------------------------------------------------------- |
| **Input DTO**   | `features/*/schemas.ts` | What the client may send. Zod-validated. Never contains `user_id`.     |
| **Domain type** | `types/`                | Internal truth. May contain decrypted values.                          |
| **View DTO**    | service return type     | What the UI receives: masked values, no secrets, only rendered fields. |

Rules:

- Never return a domain object straight to the client if it holds decrypted restricted values — map to a view DTO with masked fields.
- Input DTOs never accept ownership fields; the server supplies identity.
- A field that exists only for internal logic (dedup keys, hashes, wrapped keys) never appears in a view DTO.

## Validation

- Zod at every boundary, including places people forget: job payloads, webhook bodies, JSON columns read from the database, AI responses, environment variables.
- Parse, do not cast. `schema.parse()` produces trusted data; `as` produces hope.
- Validate before authorization only when authorization needs the parsed value; otherwise authenticate first (architecture §10).
- Reject unknown fields on input DTOs (`.strict()`), so a client cannot smuggle extra properties.
- Validate AI output against its schema and reject/retry on failure (ATL-050), then fall back deterministically.

## API and server-action conventions

- Response envelope always: `{ data, error, requestId }`. Errors are `{ code, message }` with codes from a central enum.
- Server actions are thin: `requireSession()` → `schema.parse()` → service call → map errors. No business logic.
- Route handlers exist for AI streaming, exports, and webhooks; same rules apply plus signature verification on webhooks.
- Paginate every collection; return a cursor, not a page number.
- Use idempotency keys for state transitions and job creation (ATL-104); a repeat call returns the recorded result.
- Never accept `user_id` from the client as authority. Never expose internal identifiers in logs.
- No sensitive values in URLs or query strings.

## Background jobs

MVP jobs are listed in architecture §14. Requirements for each:

- **Idempotent.** Running twice produces the same state. Use idempotency keys or predicate-based updates (`where status = 'sent' and follow_up_at <= now()`).
- **Observable.** Report start, success, failure, retries, and duration (ATL-096). Alert on repeated failure.
- **Bounded.** Process in batches with limits so one user's data volume cannot starve the queue.
- **Resumable.** Long jobs (export generation, DEK rotation) checkpoint progress.
- **Redacted.** Job logs follow the same allowlist as everything else.
- **Time-correct.** Follow-up dates compute in the user's profile timezone, not server local time.

Jobs that write user-visible state (findings sweep, follow-up transitions, notifications) must emit activity/audit events with `actor_type = 'system'` so the user sees why something changed.

## Rate limiting

- Applies to authentication, AI operations, exports, and request generation (ATL-086).
- Backed by the shared durable store — **in-memory counters do not work on serverless**; each instance would have its own.
- Key by user for authenticated surfaces and by IP for pre-auth surfaces; consider both where abuse is plausible.
- Return the typed envelope with a 429 and a calm retry message; never leak limit internals that aid enumeration.
- Rate limits are security controls, not performance tuning: they protect against takeover attempts and AI cost abuse.

## Error handling

- Domain errors carry a code: `ASSET_NOT_FOUND`, `REQUEST_INVALID_TRANSITION`, `AI_UNAVAILABLE`, `AI_SCHEMA_INVALID`, `RATE_LIMITED`, `CONSENT_REQUIRED`, `REAUTH_REQUIRED`.
- Map at the boundary; never surface provider text, stack traces, or identifiers.
- Not-found for cross-user access (no existence oracle).
- Preserve user work: recoverable failures keep form input and draft text.
- AI failures degrade to deterministic behavior rather than blocking the workflow.
- Unknown errors log a code and request ID only, and return a generic user-safe message.

## Logging

- Central redaction-aware logger only (ATL-085). Direct transport use fails lint.
- Log: request ID, route/operation, status, latency, error code, provider availability, AI schema failures, job status, RLS denial counts.
- Never log: names, addresses, phone numbers, emails, account identifiers, request bodies, prompts, draft bodies, personal field values, tokens.
- Structured key-value logs with an allowlist; unknown keys dropped and counted.
- Audit events are not logs — they go to `audit_events` through the audit writer (ADR-006).

## Common mistakes

- Business logic in a server action instead of a service.
- A service method that accepts `userId` and skips the ownership check because "RLS covers it".
- Returning a domain object containing a decrypted value to the client.
- Casting with `as` instead of parsing.
- Forgetting to validate a job payload or a JSON column.
- Non-idempotent transition handlers that double-apply on retry.
- In-memory rate limiting on serverless.
- Logging the whole error object, which contains the request body.
- Emitting activity but not audit (or vice versa) by bypassing the emitter.
- A job that writes user-visible state without an event explaining it.
- Computing follow-up dates in server local time.

## Decision framework

**Server action or route handler?** Server action for mutations from the UI. Route handler for streaming, file responses, webhooks, or non-UI clients.

**Where does this rule go?** A pure module if it is a calculation or validation; a service if it needs data or coordination.

**Job or inline?** Inline if it must complete before the response and is fast. Job if it is slow, retryable, scheduled, or fan-out. Findings recompute and score recalculation are jobs.

**New error code?** Add one when the client should behave differently. Reuse when the client's handling is identical.

**Needs idempotency?** Yes if it transitions state, creates an external-facing artifact, or can be retried by a job or a double-click.

**Can this be logged?** Only allowlisted non-restricted fields. Default to not logging.

## Review checklist

Full version in `checklists.md`. Fast pass:

- [ ] Authenticate then validate then authorize; no trusted client identity
- [ ] Zod at every boundary, including job payloads and JSON columns
- [ ] Typed error codes; no provider text; not-found for cross-user
- [ ] View DTOs mask restricted values; internal fields excluded
- [ ] Transitions and jobs idempotent, observable, bounded, timezone-correct
- [ ] Rate limits on auth, AI, export, request generation via the shared store
- [ ] Logging via the redaction utility only
- [ ] Activity and audit emitted together; system actions attributed
