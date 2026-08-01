# Atlas Review Checklists

Ten reviews in order, then the release checklist. Domain skills hold the exhaustive detail; this is the review gate.

---

## 1. Architecture review

- [ ] Code lives in the correct layer; dependencies point downward only
- [ ] No UI component imports a repository, DB client, crypto module, or AI adapter
- [ ] No cross-feature imports; shared code promoted to `lib/` or `components/ui`
- [ ] Server-only modules marked `server-only` and absent from client code
- [ ] Service owns authorization and event emission
- [ ] Repository owns data access and encryption; contains no business rules
- [ ] Derived values (score, findings) written only by their owning service
- [ ] Deterministic logic extracted as pure, testable functions
- [ ] Client boundary at the smallest interactive leaf
- [ ] Errors surfaced as typed codes in the standard envelope

## 2. Security review

- [ ] Identity derived from the verified server-side session
- [ ] No client-provided ownership field trusted
- [ ] Service-layer ownership check present, independent of RLS
- [ ] Cross-user access returns not-found, not forbidden
- [ ] New user-owned table: RLS enabled, four policies, two-user tests
- [ ] Internal tables (`audit_events`, `user_encryption_keys`) deny all client access
- [ ] Restricted fields encrypted per security §8; AAD bound to table/column/record
- [ ] No query, filter, sort, or index on an encrypted column; no plaintext searchable copy
- [ ] No restricted data in logs, analytics, URLs, query strings, or error reports
- [ ] Logging goes through the redaction utility only
- [ ] Audit and activity emitted together; audit context allowlisted
- [ ] No UPDATE or DELETE issued against `audit_events`
- [ ] Rate limits on auth, AI, export, and request generation via the shared durable store
- [ ] Consent checked server-side before gated behavior
- [ ] AI context purpose-scoped, capped, redacted, and per-request approved
- [ ] AI output schema-validated with invariant checks (evidence refs, field subset, action allowlist)
- [ ] Retrieved user text treated as untrusted and delimited
- [ ] Nothing sends or shares externally without explicit user review
- [ ] No secret in code, tests, fixtures, or client bundle
- [ ] All rendered user content encoded; no rich text rendering

## 3. Accessibility review

- [ ] Every action completable by keyboard alone
- [ ] Hover-revealed actions have keyboard and touch equivalents
- [ ] Interactive elements are semantic; no clickable `div`
- [ ] Visible focus indicator meeting 3:1
- [ ] Focus managed on route change, dialog open/close, modal step change, error submit
- [ ] Focus never stranded on a removed element
- [ ] Landmarks present; one H1; no skipped heading levels
- [ ] Icon-only controls have accessible names; decorative icons hidden
- [ ] Form labels visible and associated; help and errors linked; `aria-invalid` set
- [ ] Error summary present, focusable, linked to fields
- [ ] Contrast verified in light and dark; no color-only meaning
- [ ] `aria-live` for async status; assertive reserved for blocking errors
- [ ] Long AI operations expose progress and cancellation
- [ ] Reduced motion respected without losing meaning
- [ ] Charts have text alternatives; axes and units labeled
- [ ] Masked values not announced in full
- [ ] Targets 44x44 CSS px where practical; usable at 320 px and 200% zoom
- [ ] axe smoke passes for affected routes

## 4. Performance review

- [ ] No authenticated response cached in a shared cache; `private, no-store` set
- [ ] No decrypted value cached across requests or in client storage
- [ ] Data-heavy reads are Server Components; no client fetching of protected data
- [ ] Dashboard uses the single aggregated query
- [ ] Keyset pagination for growing collections, with supporting indexes
- [ ] No N+1 across repository calls
- [ ] Decryption limited to displayed values
- [ ] Heavy components lazy-loaded; nothing in the critical path lazy-loaded
- [ ] Layout space reserved; skeletons match final structure
- [ ] Query plans verified against realistic row counts
- [ ] Budgets pass (dashboard 2.5 s, interaction 100 ms, LCP/CLS/bundle)
- [ ] Monitoring captures the allowlist only

## 5. UX review

- [ ] All nine component states implemented
- [ ] Atlas states: not-yet-scored, demo score, AI-unavailable, filtered-empty
- [ ] No claim of scanning, guaranteed deletion, autonomous sending, or end-to-end encryption
- [ ] Nothing implies Atlas sent something it did not send
- [ ] Score framed as guidance; 100 never implies zero risk
- [ ] Demo data labeled in every surface
- [ ] Unverified data (MVP recipients) labeled unverified
- [ ] Findings show source, confidence, and evidence; low confidence and staleness disclosed
- [ ] Calm, nonjudgmental tone; no fear framing or urgency pressure
- [ ] Danger styling reserved; severity carries text
- [ ] Destructive actions use explicit confirmation language
- [ ] Archive and dismissal offer undo
- [ ] Personal fields unchecked by default; masked by default
- [ ] User input and drafts preserved on error
- [ ] Empty states teach and offer a next step
- [ ] Errors explain how to recover
- [ ] Assistant does not visually outweigh user data
- [ ] Metrics row is exactly four cards

## 6. Maintainability review

- [ ] Names describe intent; booleans read as predicates
- [ ] TypeScript strict; no `any`; no unchecked non-null assertions on external data
- [ ] External data parsed with Zod, not cast
- [ ] Validation covers job payloads, webhook bodies, JSON columns, AI output, env vars
- [ ] Rules and calculations are pure functions
- [ ] Duplication removed, or deliberate with a stated reason
- [ ] Constants encoding product decisions cite their ADR
- [ ] Comments explain why; no commented-out code
- [ ] Feature-first organization respected
- [ ] Domain types used; provider row types stop at the repository
- [ ] Migration names final; append-only respected

## 7. Testing review

- [ ] The ticket's stated testing requirements are satisfied literally
- [ ] New user-owned table → two-user tests for all four operations
- [ ] New internal table → client-inaccessible test
- [ ] New or changed rule → boundary, severity, confidence, and dedup tests
- [ ] Score change → golden test updated and score version bumped
- [ ] New transition → exhaustive matrix updated
- [ ] New encrypted column → round-trip, AAD mismatch, post-shred tests
- [ ] New AI surface → schema failure, invariant violation, injection, fallback tests
- [ ] New job → idempotency and telemetry tests
- [ ] New logged field → redaction assertion
- [ ] Failure paths covered, not only happy paths
- [ ] Time injected; boundary values asserted
- [ ] No sleeps, no shared mutable fixtures, no order dependence
- [ ] No production or realistic personal data in fixtures; demo fixtures labeled
- [ ] Each new guard has a test that fails when the guard is removed
- [ ] New E2E tests meet the flake threshold

## 8. Documentation review

- [ ] Behavior or architecture change reflected in `docs/`
- [ ] New major decision captured as an ADR with problem, options, decision, rationale, tradeoffs
- [ ] Scope addition recorded in `CHANGELOG.md` with rationale
- [ ] New unresolved product decision added to `docs/open-questions.md`
- [ ] No open question answered silently by implementation choice
- [ ] Ticket notes updated; assumptions surfaced
- [ ] Any documentation contradiction reported rather than resolved in the PR
- [ ] Public-facing copy consistent with the privacy notice and honesty rules

## 9. Technical debt review

- [ ] Deferred work is named, ticketed, and owned
- [ ] No second way of doing something already solved (or convergence justified)
- [ ] Irreversible surfaces (schema shape, encryption boundary, audit contract, prompt contract) escalated before merge
- [ ] Every `TODO` links to a ticket, or is removed
- [ ] No workaround added to avoid a CI gate
- [ ] Temporary measures documented with their removal condition
- [ ] Debt introduced is visible in the ticket, not only in the diff

---

## 10. Release checklist

Run per release, not per PR. Deployment detail in the `deployment` skill.

### Gates

- [ ] Format, lint, typecheck, unit, integration, build, migration validation all green
- [ ] Dependency and secret scans clean of unresolved critical findings
- [ ] Two-user RLS matrix passing, including new tables
- [ ] Accessibility smoke checks passing
- [ ] Performance budgets passing
- [ ] Client bundle asserted free of server secrets
- [ ] No gate bypassed

### Staging validation

- [ ] Full E2E suite passes, including the AI-unavailable variant
- [ ] Export generation, signed URL, and expiry verified
- [ ] Account deletion verified end to end, including DEK destruction and audit survivors
- [ ] Security headers verified
- [ ] Rate limits verified against the shared store
- [ ] Notifications and follow-up jobs verified

### Migration safety

- [ ] Append-only; no deployed migration edited
- [ ] Backward-compatible with the currently deployed app version
- [ ] Backfills idempotent, resumable, bounded
- [ ] New tables ship with RLS and policies in the same migration

### Deploy and observe

- [ ] Migrations applied before the new app version serves traffic
- [ ] Post-deploy smoke: health, sign-in, dashboard, one mutation, one job
- [ ] Error rate, p95 latency, provider availability, job success observed for the agreed window
- [ ] Release recorded: version, migrations, tickets, residual risk

### Rollback readiness

- [ ] Previous build identified and redeployable; rollback rehearsed
- [ ] App rollback safe with the new schema in place
- [ ] Rollback criteria agreed in advance
- [ ] Suspected exposure of restricted data escalates to incident response

### Launch only (ATL-099 / ATL-100)

- [ ] Security §21 checklist fully evidenced
- [ ] Threat model T1–T8 controls confirmed
- [ ] Accessibility audit complete
- [ ] Legal and privacy copy reviewed
- [ ] Demo claims clearly labeled
- [ ] AI-unavailable state tested
- [ ] Monitoring enabled in production
- [ ] `docs/open-questions.md` reviewed with no launch-blocking decision outstanding
- [ ] Residual risks documented and signed off
