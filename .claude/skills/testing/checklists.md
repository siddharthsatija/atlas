# Testing Review Checklist

## Level appropriateness

- [ ] Pure logic tested as pure functions, not through the UI
- [ ] Authorization and RLS tested against a real database, not mocks
- [ ] External providers (AI, email) mocked, including their failure modes
- [ ] E2E reserved for user journeys, not unit logic
- [ ] No test duplicates coverage that a lower level already provides well

## Mandatory suites for the change

- [ ] New user-owned table → two-user tests for select, insert, update, delete
- [ ] New internal table → client-inaccessible test
- [ ] New or changed rule → table-driven cases with boundary dates and dedup stability
- [ ] Score change → golden test updated deliberately and version bumped
- [ ] New transition → exhaustive matrix updated
- [ ] New encrypted column → round-trip, AAD mismatch, post-shred unreadability
- [ ] New AI surface → schema failure, invariant violation, injection, fallback
- [ ] New job → idempotency (runs twice, one effect) and telemetry assertions
- [ ] New UI route → axe smoke and keyboard journey
- [ ] New logged field → redaction assertion

## Failure paths

- [ ] Authorization denial tested, not just success
- [ ] Invalid input rejected with the expected code
- [ ] Invalid state transition rejected
- [ ] Rate limit triggers the expected envelope
- [ ] AI outage path exercised
- [ ] Expired/consumed magic link handled
- [ ] Expired export link handled
- [ ] Consent-missing path returns `CONSENT_REQUIRED`
- [ ] Reauth-required path enforced

## Data hygiene

- [ ] No production data anywhere in fixtures, seeds, or snapshots
- [ ] Synthetic personal data is obviously synthetic (`.test` domains)
- [ ] Demo fixtures labeled `source_type = 'demo'`
- [ ] Tests create and clean up their own users
- [ ] No shared mutable fixture state between tests

## Determinism and flake

- [ ] Time injected; no `Date.now()` in logic under test
- [ ] Boundary values asserted (179/180, 364/365 days)
- [ ] No `sleep`/arbitrary timeouts; waits are state-based
- [ ] No dependence on test execution order
- [ ] Randomness seeded or avoided
- [ ] New E2E test passes 20 consecutive runs (<2% flake)

## Assertion quality

- [ ] Each new guard has a test that fails when the guard is removed
- [ ] Assertions check behavior, not implementation details
- [ ] No whole-page snapshots standing in for real assertions
- [ ] Error cases assert the specific code, not just "threw"
- [ ] Post-state verified for destructive operations (deletion sweep)

## Security-specific

- [ ] Cross-user IDOR attempted at every new endpoint
- [ ] Stored XSS attempted through user-controlled text fields
- [ ] Prompt injection attempted through asset name, notes, and categories
- [ ] Bundle asserted free of server secrets
- [ ] Security headers asserted present
- [ ] Auth responses identical for known and unknown emails

## Coverage

- [ ] Risk-tier expectations met (exhaustive for score, rules, state machine, crypto, redaction)
- [ ] Every public service method has happy path, denial, and one failure mode
- [ ] Meaningful UI states covered (empty, filtered-empty, error, loading, demo, not-yet-scored)
- [ ] Overall line coverage not regressed below the agreed floor
- [ ] Coverage gaps in security-sensitive code explicitly justified or closed
