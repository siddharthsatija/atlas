# Backend Review Checklist

## Boundary discipline

- [ ] Server action or handler authenticates before reading input
- [ ] Input validated with a strict Zod schema; unknown fields rejected
- [ ] Input DTO contains no ownership field; identity comes from the session
- [ ] No business logic in the action/handler — it delegates to a service
- [ ] Response uses the `{ data, error, requestId }` envelope

## Services

- [ ] Ownership verified in the service, independent of RLS
- [ ] Pure logic (rules, state machine, score factors) extracted into testable modules
- [ ] No database client access from the service
- [ ] Cross-domain work goes service to service
- [ ] Domain errors thrown with codes, not strings
- [ ] Derived values written only by their owning service

## Repositories

- [ ] Parameterized queries only
- [ ] Every read scoped by `user_id`; writes set it from the session
- [ ] Encryption/decryption handled here
- [ ] No filter, sort, or join on an encrypted column
- [ ] Returns domain types; provider rows do not escape
- [ ] Keyset pagination for growing collections

## DTOs

- [ ] View DTOs mask restricted values (recipients, identifiers, personal fields)
- [ ] Internal fields (dedup keys, hashes, wrapped keys) excluded from view DTOs
- [ ] `included_fields_json` exposes keys only, never values
- [ ] No decrypted restricted value returned to the client unless the user explicitly revealed it

## Validation coverage

- [ ] Client input
- [ ] Job payloads
- [ ] Webhook bodies (plus signature verification)
- [ ] JSON columns read from the database
- [ ] AI responses (with reject/retry then deterministic fallback)
- [ ] Environment variables at boot
- [ ] Parsed, not cast — no `as` on external data

## Transitions and idempotency

- [ ] State transitions validated against the allowed-transition table
- [ ] Invalid transitions return `REQUEST_INVALID_TRANSITION`
- [ ] Idempotency keys used for transitions and job creation
- [ ] Concurrent double-submit produces one effect (expected-from guard or unique constraint)
- [ ] Multi-record changes wrapped in a short transaction; enqueues happen after commit

## Background jobs

- [ ] Idempotent: running twice leaves the same state
- [ ] Bounded batches; one user cannot starve the queue
- [ ] Resumable with checkpoints if long-running
- [ ] Telemetry reports start, success, failure, retries, duration
- [ ] Repeated failure alerts
- [ ] System-driven state changes emit activity/audit with `actor_type = 'system'`
- [ ] Date computations use the user's profile timezone
- [ ] Job logs pass the redaction allowlist

## Rate limiting

- [ ] Applied to authentication, AI, export, and request generation
- [ ] Backed by the shared durable store (no in-memory counters)
- [ ] Keyed by user and/or IP appropriately
- [ ] 429 returns the typed envelope with a calm message
- [ ] No response detail that aids account enumeration

## Errors

- [ ] All failures mapped to typed codes with user-safe messages
- [ ] No provider text, stack traces, or identifiers reach the client
- [ ] Cross-user access returns not-found
- [ ] Auth errors neutral about account existence
- [ ] User input and drafts preserved on recoverable failure
- [ ] AI-dependent paths degrade deterministically

## Logging

- [ ] Redaction-aware logger used exclusively
- [ ] Only allowlisted, non-restricted fields logged
- [ ] No error objects logged whole
- [ ] Audit events written through the audit writer, not the logger
- [ ] RLS denials and AI schema failures counted for monitoring
