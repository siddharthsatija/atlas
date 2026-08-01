# Atlas Definition of Done

Three levels: a **ticket**, a **milestone**, a **release**. Nothing is "done" because it demonstrates well. Done means the criteria below are demonstrably met.

Derived from `docs/05-feature-ticket-list.md`, `CLAUDE.md`, and `docs/01-product-requirements.md` §14. Where those documents are more specific, they govern.

---

## Ticket level

### Engineering

- [ ] Acceptance criteria in the ticket are met literally, each one demonstrable
- [ ] Implemented as a complete vertical slice — no half-wired layers
- [ ] Layering respected: dependencies point downward, no cross-feature imports
- [ ] Server-side authorization present in the service, independent of RLS
- [ ] Inputs validated with Zod at every boundary, including job payloads and JSON columns
- [ ] Typed error codes with user-safe messages; no provider text reaching clients
- [ ] Deterministic logic extracted as pure functions
- [ ] Business logic absent from UI components and repositories
- [ ] TypeScript strict; no `any`; external data parsed, not cast
- [ ] All required commands pass: `format:check`, `lint`, `typecheck`, `test`, `test:integration`, `build`

### Testing

- [ ] The ticket's stated testing requirements are satisfied
- [ ] Mandatory suites for the change type present (see `testing/checklists.md`)
- [ ] New user-owned table: two-user RLS tests for all four operations
- [ ] New rule: boundary, severity, confidence, and dedup tests
- [ ] Score change: golden test updated and score version bumped
- [ ] New transition: exhaustive matrix updated
- [ ] New encrypted column: round-trip, AAD mismatch, post-shred tests
- [ ] New AI surface: schema, invariant, injection, and fallback tests
- [ ] New job: idempotency and telemetry tests
- [ ] Failure paths covered: denial, invalid input, invalid transition, rate limit, AI outage, missing consent
- [ ] Every new guard has a test that fails when the guard is removed
- [ ] Time injected; boundaries asserted; no sleeps or shared mutable fixtures
- [ ] No production or realistic personal data in fixtures; demo rows labeled

### Accessibility (any UI change)

- [ ] `accessibility/checklists.md` passed in full
- [ ] Every action completable by keyboard alone
- [ ] Focus managed on route change, dialog open/close, modal step change, error submit
- [ ] Semantic elements and landmarks; one H1; no skipped levels
- [ ] Icon-only controls named; decorative icons hidden
- [ ] Contrast verified programmatically in light and dark; no color-only meaning
- [ ] `aria-live` for async status; long AI operations cancellable
- [ ] Reduced motion respected; charts have text alternatives
- [ ] Masked values not announced in full
- [ ] Usable at 320 px and 200% zoom; axe smoke passing

### Security and privacy

- [ ] `security/checklists.md` passed for the surfaces touched
- [ ] Identity server-derived; client ownership fields ignored
- [ ] New tables have RLS with all four policies; internal tables deny all client access
- [ ] Restricted fields encrypted per the security §8 inventory with bound AAD
- [ ] No query, filter, sort, or index on an encrypted column; no plaintext searchable copy
- [ ] No restricted data in logs, analytics, URLs, error reports, or notification bodies
- [ ] Consent checked server-side before gated behavior
- [ ] AI context purpose-scoped, capped, redacted, per-request approved; outputs invariant-checked
- [ ] Audit and activity emitted together; audit context allowlisted
- [ ] Rate limits present where required
- [ ] No secret in code, tests, fixtures, or client bundle
- [ ] Nothing sends externally without explicit user review

### Product and UX

- [ ] All nine component states plus the Atlas-specific states: not-yet-scored, demo score, AI-unavailable, filtered-empty
- [ ] No claim of scanning, guaranteed deletion, autonomous sending, or end-to-end encryption
- [ ] Nothing implies Atlas sent something it did not send
- [ ] Demo data labeled; unverified data labeled; low confidence and staleness disclosed
- [ ] Findings show source and confidence; score views explain limitations
- [ ] Calm, nonjudgmental tone; danger styling reserved; severity carries text
- [ ] Destructive actions use explicit confirmation; archive and dismissal offer undo
- [ ] Personal fields optional, masked, unchecked by default
- [ ] User input and drafts preserved on recoverable error
- [ ] No open question answered by implementation choice

### Performance

- [ ] No authenticated response in a shared cache; no decrypted value cached across requests
- [ ] Protected reads server-side; client boundary at the leaves
- [ ] Keyset pagination with supporting indexes; no N+1
- [ ] Heavy components lazy-loaded; layout space reserved; skeletons match structure
- [ ] Budgets met with realistic data (dashboard 2.5 s, interaction 100 ms)

### Documentation

- [ ] Behavior or architecture change reflected in `docs/`
- [ ] Major decision captured as an ADR with problem, options, decision, rationale, tradeoffs
- [ ] Scope addition recorded in `CHANGELOG.md` with rationale
- [ ] New unresolved product decision added to `docs/open-questions.md`
- [ ] Ticket notes updated with assumptions surfaced and work deferred
- [ ] Any documentation contradiction reported rather than silently resolved

### Technical debt

- [ ] Deferred work is ticketed with an owner
- [ ] Every `TODO` links to a ticket or is removed
- [ ] No workaround added to avoid a CI gate
- [ ] Irreversible surfaces (schema, encryption, audit, prompt contracts) covered by an ADR
- [ ] Temporary measures documented with their removal condition

### Review

- [ ] Self-review completed against `code-review/checklists.md`
- [ ] Required reviewers approved: `security-engineer` for auth/data/personal-data/AI/infra changes; `accessibility-reviewer` and `design-reviewer` for UI; `architect` for structural change; `product-manager` for behavior or copy
- [ ] All blocking findings resolved, not negotiated

---

## Milestone level

Everything above for each ticket, plus:

- [ ] All P0 tickets in the milestone complete; P1 tickets either complete or explicitly deferred with a decision recorded
- [ ] Two-user authorization matrix covers every table added in the milestone, and the completeness check passes
- [ ] Accessibility checks pass for every UI surface added
- [ ] Integration suite green, including RLS, transitions, and jobs
- [ ] E2E journeys touched by the milestone pass, including the AI-unavailable variant where applicable
- [ ] Documentation consistent: no contradiction between `docs/`, ADRs, and shipped behavior
- [ ] `docs/open-questions.md` reviewed; nothing was answered silently
- [ ] Deferred work ticketed with owners
- [ ] Performance budgets still met after the milestone's additions
- [ ] Milestone outcome recorded, including residual risks

---

## Release level

Everything above, plus the release checklist in `deployment/checklists.md`:

### Gates

- [ ] Format, lint, typecheck, unit, integration, build, migration validation all green
- [ ] Dependency and secret scans clean of unresolved critical findings
- [ ] Two-user RLS matrix passing, including new tables
- [ ] Accessibility smoke checks passing
- [ ] Performance budgets passing
- [ ] Client bundle asserted free of server secrets
- [ ] No gate bypassed or suppressed

### Validation

- [ ] Full E2E suite passes on staging, including the AI-unavailable variant
- [ ] Export generation, signed URL, and expiry verified
- [ ] Account deletion verified end to end, including DEK destruction and audit survivors
- [ ] Security headers, rate limits, notifications, and background jobs verified
- [ ] Environment isolation intact; no production data or keys in lower environments

### Migration and rollback

- [ ] Migrations append-only and backward-compatible with the deployed app version
- [ ] New tables ship with RLS policies in the same migration
- [ ] Backfills idempotent, resumable, bounded
- [ ] Rollback path identified, rehearsed, and safe with the new schema in place
- [ ] Rollback criteria agreed in advance

### Operations

- [ ] Migrations applied before the new application version serves traffic
- [ ] Post-deploy smoke: health, sign-in, dashboard, one mutation, one job completion
- [ ] Alerts live for error rate, latency regression, provider outage, job failure, RLS denial spikes
- [ ] Monitoring payloads free of personal data
- [ ] Release recorded: version, migrations, tickets, residual risk

### Launch only (ATL-099, ATL-100)

- [ ] Security §21 launch checklist fully evidenced
- [ ] Threat model T1–T8 controls confirmed
- [ ] Accessibility audit complete
- [ ] Legal and privacy copy reviewed
- [ ] Demo claims clearly labeled throughout
- [ ] AI-unavailable state tested
- [ ] Production monitoring enabled
- [ ] `docs/open-questions.md` reviewed with no launch-blocking decision outstanding (OQ-01 EU scope in particular)
- [ ] Residual risks documented and signed off

---

## Non-negotiables

These are never traded for schedule. If pressure exists, escalate.

1. Server-side authorization on every protected operation
2. RLS plus two-user tests on every user-owned table
3. Restricted data encrypted, masked, and never logged
4. Nothing leaves Atlas without explicit user review
5. No claim of scanning, guaranteed deletion, or end-to-end encryption
6. WCAG 2.2 AA on every UI surface
7. Migrations append-only
8. Open questions decided by the owner, on the record
