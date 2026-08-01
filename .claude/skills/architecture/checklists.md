# Architecture Review Checklist

Apply to every pull request that adds or changes structure. Paired with `code-review` skill.

## Layering and dependencies

- [ ] No UI component imports a repository, DB client, crypto module, or AI adapter
- [ ] No service imports a React component or feature module
- [ ] No repository calls a service (no upward calls)
- [ ] No cross-feature imports; shared code was promoted to `lib/` or `components/ui`
- [ ] Server-only modules are marked `server-only`
- [ ] New import paths respected by the ESLint boundary config (no suppression comments)

## Service design

- [ ] Every public service method verifies ownership server-side
- [ ] No method trusts a caller-supplied `user_id` that originated client-side
- [ ] Cross-domain work goes service to service, not into another domain's repository
- [ ] State changes emit activity and audit through the shared emitter
- [ ] Derived values (score, findings) are written only by their owning service
- [ ] Idempotent where retried: transitions and job handlers use idempotency keys

## Repository design

- [ ] All data access is parameterized; no string-built SQL
- [ ] Every query scoped by `user_id` (or documented internal-table exception)
- [ ] Encryption and decryption happen here, not in services or UI
- [ ] No filtering, sorting, or searching on encrypted columns
- [ ] Returns domain types; provider row types do not escape
- [ ] Growing collections use cursor pagination and have supporting indexes

## Server/Client split

- [ ] Reads of protected data happen in Server Components
- [ ] `"use client"` is on the smallest possible leaf
- [ ] Props contain only what the UI renders (no full records, no unrevealed sensitive values)
- [ ] Mutations run through server actions that authenticate before validating

## Error handling

- [ ] All failures return typed codes in the standard envelope
- [ ] No provider messages, stack traces, or identifiers reach the client
- [ ] Auth errors do not reveal account existence
- [ ] Form input and draft text survive recoverable errors
- [ ] AI-dependent paths have a deterministic fallback that is exercised by a test

## Determinism and AI placement

- [ ] Findings, score, and status logic are pure functions with unit tests
- [ ] AI output is schema-validated and never sets a stored value directly
- [ ] Retrieval for AI goes through the policy layer with purpose classification

## Standards

- [ ] TypeScript strict; no `any`, no unchecked non-null assertions on external data
- [ ] Zod validation at every boundary including JSON columns and job payloads
- [ ] Logging via the redaction utility only; no restricted fields present
- [ ] Constants that encode product decisions cite their ADR
- [ ] Migration is append-only and names are final

## Documentation

- [ ] Behavior or architecture change reflected in `docs/`
- [ ] New major decision captured as an ADR
- [ ] Any discovered documentation contradiction reported, not silently resolved
