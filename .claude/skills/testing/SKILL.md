---
name: testing
description: Atlas testing strategy covering unit, integration, end-to-end, accessibility, security, and performance testing, plus coverage expectations and what must never be tested with real data. Use when writing tests, deciding test level, or judging whether a ticket's testing requirement is satisfied.
---

# Atlas Testing

**Sources of truth:** `docs/02-technical-architecture.md` §17 (test strategy), per-ticket testing requirements in `docs/05-feature-ticket-list.md`.

## Purpose

Prove the things that would hurt most if they broke: cross-user data access, encryption, deterministic rules and score, request state transitions, deletion, and AI safety.

## Core principles

1. **Risk drives coverage.** Security and privacy paths are tested exhaustively; cosmetic code is not.
2. **Test at the lowest level that gives confidence.** Pure logic in unit tests; authorization in integration tests.
3. **Two users, always.** Every user-owned table gets cross-user denial tests.
4. **Never real production data.** Fixtures are synthetic, and demo fixtures are labeled.
5. **Determinism is testable — so test it exhaustively.** Rules and score factors have golden cases.
6. **Failure paths are first-class.** AI outage, rate limits, invalid transitions, and expired links all have tests.
7. **A test that never fails teaches nothing.** Verify each new guard actually catches the thing it guards.

## Test levels

| Level         | Tool                           | Scope                                                                   | Speed           |
| ------------- | ------------------------------ | ----------------------------------------------------------------------- | --------------- |
| Unit          | Vitest                         | Pure functions, schemas, redaction, crypto, rules, score, state machine | ms              |
| Integration   | Vitest + local Supabase        | Services, repositories, RLS, jobs, transitions, deletion                | seconds         |
| E2E           | Playwright                     | Full journeys through the browser                                       | tens of seconds |
| Accessibility | axe + Playwright               | Route smoke checks, keyboard journeys                                   | seconds         |
| Security      | Vitest/Playwright              | Cross-user, IDOR, injection, prompt injection, header, secret exposure  | seconds         |
| Performance   | Lighthouse CI + query analysis | Budgets, LCP, CLS, interaction latency, query plans                     | minutes         |

## Unit testing

Must-have unit suites (architecture §17):

- **Score calculation** — every factor independently, plus renormalization, cold start, demo isolation, and the ADR-004 worked example as a **golden test** (expected ≈56). If someone changes a weight, this test must fail.
- **Findings rules** — table-driven per rule: fires, does not fire, boundary dates (179/180/365 days), severity escalation, confidence caps, dedup key stability.
- **Request state machine** — exhaustive matrix: every allowed transition passes, every unlisted transition is rejected.
- **Crypto** — round-trip, AAD mismatch (relocated ciphertext), wrong key, post-shred unreadability.
- **Redaction** — nested payloads, restricted patterns, unknown-key dropping.
- **Validation schemas** — valid, invalid, and adversarial inputs; `.strict()` rejects extra fields.
- **AI output validation** — schema failures plus invariant violations (unapproved field, ungrounded reference, invalid action).

Write these as pure functions with no database so they run in milliseconds and can be exhaustive.

## Integration testing

Against a local Supabase instance with migrations applied:

- **Authorization and RLS** — the two-user matrix for every table and endpoint (ATL-088), generated from the schema list so a new table without tests fails CI.
- **Asset, finding, request CRUD** with ownership enforcement.
- **Findings generation and auto-resolution** — fire, fix, auto-resolve; fire, dismiss, input change, re-fire.
- **Request transitions** including system-driven ones and idempotency replay.
- **Personal fields lifecycle** — consent gate, encryption round-trip, use in draft, deletion.
- **Notifications** — creation, preference respect, unread state, purge.
- **Audit writer** — UPDATE/DELETE rejected, hash chain verification positive and negative.
- **Export generation** — content correctness, expiry, audit emission, idempotency.
- **Account deletion** — DEK destroyed, every user-owned table empty afterward, audit survivors present, no resurrection on re-registration.

## End-to-end testing

Journeys required by architecture §17 and ATL-092:

1. Sign in and onboarding (including skip paths and consent capture)
2. Add asset
3. Review finding
4. Generate and edit a request draft
5. Mark request sent
6. Receive a follow-up notification
7. Export data
8. Delete account

Plus the **AI-unavailable variant** of the draft journey — the fallback path is a product requirement, not an edge case.

Rules: E2E tests use synthetic accounts, run against a staging-like environment, avoid arbitrary sleeps (wait on state), and must hold a flake rate under 2% over 20 runs.

## Accessibility testing

- axe smoke check on every primary route (ATL-091); zero violations is the bar.
- Keyboard-only completion test for each primary journey.
- Focus management assertions: route change, dialog open/close, modal step change, error submit.
- Reduced-motion behavior verified.
- Contrast verified programmatically over the token matrix in both modes (ATL-008).
- Manual screen-reader spot check for new complex widgets — automation cannot judge announcement quality.

The `accessibility` skill's `checklists.md` is the pre-merge gate; these are its automated portion.

## Security testing

Mirrors the threat model (security §17):

- **Cross-user access and IDOR** — read, update, delete another user's record by ID at every endpoint.
- **RLS bypass** — direct inserts claiming another `user_id`; internal tables inaccessible from client roles.
- **Injection** — SQL via inputs, stored XSS via asset names and notes (attacker-controlled fields rendered widely).
- **Prompt injection** — payloads in asset names, notes, and categories cannot alter policy, expand retrieval, or produce executable actions (ATL-089).
- **Rate limiting** — limits enforced per surface and shared across instances.
- **Secret exposure** — no provider or service-role key in the client bundle (bundle analysis assertion).
- **Header verification** — CSP without unsafe-inline, HSTS, frame-ancestors, and the rest present on every response.
- **Log payload assertions** — poisoned fixture events prove redaction strips restricted values.
- **Auth enumeration** — identical responses for known and unknown emails.

## Performance testing

- Budgets enforced in CI (ATL-093): dashboard usable ≤2.5 s, interaction feedback ≤100 ms, plus bundle, LCP, and CLS thresholds.
- Query plans checked with `explain analyze` against realistic row counts, not seed-sized tables.
- Keyset pagination verified to stay flat as row counts grow.
- Job duration tracked; alert on repeated failure or growth (ATL-096).

## Coverage expectations

Coverage percentage is a weak signal; risk-tiered expectations are the standard:

| Area                                                                | Expectation                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Score calculation, findings rules, state machine, crypto, redaction | Exhaustive — every branch, every boundary                                         |
| Services and repositories                                           | Every public method, happy path plus authorization denial plus one failure mode   |
| RLS                                                                 | Every table, all four operations, two users                                       |
| AI paths                                                            | Schema failure, invariant violation, injection, fallback                          |
| Deletion and export                                                 | End-to-end with post-state verification                                           |
| UI components                                                       | States that carry meaning (empty, error, loading, demo, not-yet-scored), plus axe |
| Cosmetic styling                                                    | No dedicated tests                                                                |

Line-coverage floor of roughly 80% overall is a smoke alarm, not a goal. A PR that adds a table without RLS tests fails regardless of coverage.

## Test data rules

- **No production data in seeds, fixtures, or tests** (architecture §8). Ever.
- Synthetic personal data must be obviously synthetic (`ada@example.test`, not a plausible real address).
- Demo fixtures carry `source_type = 'demo'` so demo-isolation tests are meaningful.
- Each test creates its own users and cleans up; no shared mutable fixtures across tests.
- Time-dependent tests inject a clock rather than sleeping — staleness rules and follow-up jobs depend on controllable time.

## Common mistakes

- Testing a rule through the UI instead of as a pure function.
- One-user tests for RLS ("it works for me") — the whole risk is the second user.
- Asserting a happy path only, so the guard that matters is never exercised.
- Snapshot tests over entire rendered pages, which fail on every styling change and assert nothing meaningful.
- `sleep(2000)` instead of waiting on state, producing flake.
- Mocking the database in a test whose entire purpose is verifying RLS.
- Mocking the AI provider so thoroughly that schema-failure and invariant paths are never tested.
- Real-looking personal data in fixtures.
- Forgetting the AI-unavailable variant.
- Not testing that a new audit event is actually immutable.

## Decision framework

**What level?** Pure logic → unit. Authorization, RLS, or multi-table behavior → integration. User-visible journey → E2E. Prefer the lowest level that would catch the regression.

**Mock or real?** Real database for anything touching authorization or SQL. Mock only external providers (AI, email) — and still test their failure modes.

**Is this test worth writing?** Ask what breaks in production if it does not exist. If the answer is "a color changes", skip it. If it is "another user reads someone's data", it is mandatory.

**How do I test time-based rules?** Inject the clock. Assert at boundaries (179 vs 180 days), not at comfortable midpoints.

**Is my new guard tested?** Write the failing case first and watch it fail before you make it pass.

## Review checklist

Full version in `checklists.md`. Fast pass:

- [ ] New user-owned table has two-user tests for all four operations
- [ ] New rule or score change has golden and boundary tests
- [ ] New transition covered by the exhaustive matrix
- [ ] New AI surface has schema-failure, invariant, injection, and fallback tests
- [ ] Failure paths tested, not just happy paths
- [ ] No real or realistic personal data in fixtures
- [ ] Time-dependent behavior uses an injected clock
- [ ] axe and keyboard tests for new UI routes
- [ ] No new flake source (no sleeps, no shared mutable fixtures)
