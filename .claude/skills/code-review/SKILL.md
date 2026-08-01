---
name: code-review
description: Repeatable review framework for every Atlas implementation, covering architecture, security, accessibility, performance, UX, maintainability, testing, documentation, technical debt, and the release checklist. Use when reviewing any pull request, self-reviewing before opening one, or judging whether a ticket is truly done.
---

# Atlas Code Review

**Sources of truth:** the product documentation in `docs/`, the ADRs in `docs/adr/`, and the per-ticket acceptance criteria and testing requirements in `docs/05-feature-ticket-list.md`. Domain detail lives in the other skills; this one is the ordered process.

## Purpose

Make review outcomes consistent regardless of who reviews. Every implementation passes through the same ten reviews, in the same order, with blocking issues defined up front.

## Core principles

1. **Review against the documentation, not personal taste.** Cite the document or ADR.
2. **Order matters.** Security and architecture failures make style feedback irrelevant.
3. **Blocking is defined, not felt.** The severity table below decides.
4. **The definition of done is the ticket's, not the reviewer's mood.** Acceptance criteria and testing requirements are checked literally.
5. **Absence of evidence is a finding.** No test for a new guard is a defect.
6. **Report documentation contradictions; never silently resolve them.**
7. **Be specific and kind.** Point at the line, name the rule, suggest the fix.

## Severity

| Severity     | Meaning                                       | Examples                                                                                                                                                                                                                                           |
| ------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blocking** | Cannot merge                                  | Missing authorization, table without RLS or two-user tests, restricted data in logs, encrypted-column query, unapproved field reaching AI, dishonest product claim, keyboard-inaccessible action, edited deployed migration, secret in client code |
| **Major**    | Merge only with a tracked follow-up and owner | Missing failure-path test, layering violation, absent loading/empty state, unindexed hot query, undocumented behavior change                                                                                                                       |
| **Minor**    | Fix now or note it                            | Naming, comment clarity, small duplication, test readability                                                                                                                                                                                       |
| **Nit**      | Optional, label it                            | Formatting preferences the linter does not enforce                                                                                                                                                                                                 |

Anything touching authorization, encryption, personal data, AI context, or audit logging starts at Blocking until proven otherwise.

## The ten reviews, in order

### 1. Architecture review

Does the code belong where it is, and do dependencies point one way? See the `architecture` skill.

- Layer boundaries respected; no UI reaching repositories, no cross-feature imports
- Service owns authorization and events; repository owns I/O and encryption
- Client boundary minimal; server-only modules not imported into client code
- Deterministic logic pure and separated from orchestration
- Derived values written only by their owning service
- Typed error codes at boundaries

Blocking: authorization missing from the service; AI in the source-of-truth path; business logic in a repository or component.

### 2. Security review

See the `security` skill and its `checklists.md`. The non-negotiables:

- Identity from the verified session; client-supplied ownership ignored
- New user-owned tables have RLS plus two-user tests; internal tables deny all client access
- Restricted fields encrypted per the security §8 inventory; no queries on encrypted columns
- No restricted data in logs, analytics, URLs, or error reports
- Rate limits on auth, AI, export, and request generation via the shared store
- Audit and activity emitted together; audit context allowlisted
- AI context minimal, consented, redacted, per-request approved; outputs schema-validated with invariant checks
- Nothing leaves Atlas without explicit user review
- No secret in code, tests, or client bundle

Blocking: any failure here.

### 3. Accessibility review

See the `accessibility` skill `checklists.md` — the pre-merge gate for UI work.

- Full keyboard operation; hover actions have keyboard and touch equivalents
- Visible focus; focus managed on route change, dialog, modal step, and error submit
- Semantic elements and landmarks; one H1; no clickable `div`
- Labels, descriptions, `aria-invalid`, error summary on forms
- Contrast verified in both modes; no color-only meaning
- `aria-live` for async status; reduced motion respected
- Masked values not announced in full
- axe smoke passes for the route

Blocking: an action that cannot be completed by keyboard; missing accessible name on a control; contrast failure.

### 4. Performance review

See the `performance` skill.

- No user data in a shared cache; authenticated responses `private, no-store`
- No decrypted value cached across requests
- Server rendering for data-heavy views; dashboard uses the aggregated query
- Keyset pagination and supporting indexes; no N+1
- Decryption limited to displayed values
- Heavy components lazy-loaded with reserved space; skeletons match structure
- Budgets met with realistic data volumes

Blocking: shared caching of user data. Major: unindexed hot query, missing pagination.

### 5. UX review

See the `product` and `frontend` skills.

- All nine component states, plus the Atlas-specific ones: not-yet-scored, demo score, AI-unavailable, filtered-empty
- Copy honest: no scanning, guaranteed deletion, autonomous sending, or end-to-end encryption claims
- Calm, nonjudgmental tone; danger styling reserved; severity carries text
- Findings show source and confidence; score views explain limitations
- Destructive actions explicit; archive and dismissal offer undo
- User work preserved on error; drafts autosave
- Demo data labeled everywhere
- Assistant does not outweigh user data

Blocking: a dishonest claim; a destructive action without explicit confirmation.

### 6. Maintainability review

- Names describe intent; booleans read as predicates
- No `any`; external data parsed, not cast
- Zod validation at every boundary including job payloads and JSON columns
- Pure functions for rules and calculations
- Duplication either removed or deliberate with a reason
- Constants encoding product decisions cite their ADR
- Comments explain _why_, not _what_
- Feature-first organization respected; shared code promoted rather than cross-imported
- Migration names final and correct (append-only)

### 7. Testing review

See the `testing` skill `checklists.md`.

- The ticket's stated testing requirements are literally satisfied
- New table → two-user RLS tests; new rule → boundary and dedup tests; score change → golden test updated with a version bump
- New transition → exhaustive matrix; new AI surface → schema, invariant, injection, and fallback tests
- New encrypted column → round-trip, AAD mismatch, post-shred tests
- New job → idempotency and telemetry tests
- Failure paths tested, not only happy paths
- Time injected; boundaries asserted; no sleeps or shared mutable fixtures
- No production or realistic personal data in fixtures
- Each new guard has a test that fails when the guard is removed

Blocking: missing two-user tests for a new table; untested new security guard.

### 8. Documentation review

- Behavior or architecture change reflected in `docs/`
- New major decision captured as an ADR (problem, options, decision, rationale, tradeoffs)
- Scope addition recorded in `CHANGELOG.md` with rationale
- New unresolved product decision added to `docs/open-questions.md` rather than guessed
- Ticket notes updated; assumptions surfaced rather than buried
- Any documentation contradiction discovered is reported

Blocking: an undocumented scope expansion; an open question answered silently by implementation.

### 9. Technical debt review

Debt is acceptable when it is visible and owned.

- Is anything deferred? Named, ticketed, with an owner
- Does this add a second way to do something already solved? Justify or converge
- Does it entrench a decision that is hard to reverse (schema shape, encryption boundary, prompt contract)? Escalate before merging
- Are there `TODO`s? Each links to a ticket or is removed
- Did a workaround get added because a gate was inconvenient? Fix the gate instead
- Is a temporary measure documented with the condition for its removal

Blocking: hidden debt in an irreversible surface (schema, encryption, audit).

### 10. Release checklist

Run before shipping a release, not per PR. Full list in the `deployment` skill `checklists.md` and `checklists.md` here.

## Common review mistakes

- Starting with style comments while an authorization bug sits unread.
- Accepting "RLS covers it" instead of a service-layer ownership check.
- Approving a new table because the code looks fine, without checking for RLS tests.
- Treating a missing empty or demo state as a nit.
- Letting a plausible-sounding product claim through without checking honesty rules.
- Approving an AI change without asking what context it sends and what invariants validate the output.
- Accepting a coverage number in place of the specific tests the ticket required.
- Resolving a documentation contradiction in the PR discussion instead of reporting it.
- Waving through a `TODO` with no ticket.
- Blocking on personal preference and citing no document.

## Decision framework

**Where do I start?** Security and architecture. If either fails, stop and report; the rest can wait for the next iteration.

**Is this blocking?** Consult the severity table. Authorization, RLS, encryption, restricted-data handling, AI context, honesty of claims, keyboard access, and migration integrity are blocking by default.

**Is the ticket done?** Read its acceptance criteria and testing requirements literally, and confirm each. "Looks complete" is not a determination.

**Author disagrees on a rule?** Cite the document. If the document is genuinely ambiguous or wrong, that is an open question or an ADR — not a negotiation in the PR thread.

**Small PR, do I still do all ten?** Yes, but proportionally. A copy change needs UX honesty and documentation; it does not need a performance review.

**No test for a guard?** Blocking. Ask for the failing-case-first test.

## Review checklist

`checklists.md` contains the full per-review gate plus the release checklist. Fast pass in review order:

- [ ] Architecture: layers, boundaries, ownership, typed errors
- [ ] Security: authorization, RLS, encryption, logs, AI context, secrets
- [ ] Accessibility: keyboard, focus, semantics, contrast, announcements
- [ ] Performance: caching safety, rendering, pagination, budgets
- [ ] UX: states, honesty, tone, user control, preserved work
- [ ] Maintainability: naming, types, validation, duplication, ADR citations
- [ ] Testing: ticket requirements met, guards tested, failure paths covered
- [ ] Documentation: docs, ADR, changelog, open questions updated
- [ ] Technical debt: visible, ticketed, owned; irreversible surfaces escalated
- [ ] Release: only when shipping — see the release checklist
