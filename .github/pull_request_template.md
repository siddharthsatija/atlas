<!-- GENERATED FILE — do not edit.
     Source of truth: .claude/pull-request-template.md
     Regenerate with: pnpm sync:pr-template -->

# Pull Request

<!--
Complete every section honestly. "N/A" is a valid answer with a one-line reason.
An empty review section is an incomplete submission.
Reference documents and ADRs rather than restating them.
-->

## Summary

<!-- What changed and why, in two or three sentences. Describe behavior, not file names. -->

## Related tickets

- Ticket: <!-- ATL-000 -->
- Milestone: <!-- M0–M12 -->
- Dependencies complete: <!-- yes / stubbed (explain) -->

**Specifications and ADRs consulted:**

<!-- e.g. docs/02-technical-architecture.md §11.1, ADR-001, docs/04-frontend-specification.md §5.2 -->

## Acceptance criteria

<!-- Copy each criterion from the ticket and state how it is demonstrated. -->

| Criterion | How it is demonstrated |
| --------- | ---------------------- |
|           |                        |

## Testing

**Suites added or updated:**

- [ ] Unit
- [ ] Integration
- [ ] End-to-end
- [ ] Accessibility
- [ ] Security
- [ ] Performance
- [ ] N/A because: <!-- reason -->

**Mandatory suites for this change type** (delete rows that do not apply):

| Change               | Required tests                         | Present |
| -------------------- | -------------------------------------- | ------- |
| New user-owned table | Two-user RLS, all four operations      | [ ]     |
| New or changed rule  | Boundary, severity, confidence, dedup  | [ ]     |
| Score change         | Golden test updated + version bumped   | [ ]     |
| New transition       | Exhaustive matrix                      | [ ]     |
| New encrypted column | Round-trip, AAD mismatch, post-shred   | [ ]     |
| New AI surface       | Schema, invariant, injection, fallback | [ ]     |
| New job              | Idempotency, telemetry                 | [ ]     |
| New UI route         | axe smoke, keyboard journey            | [ ]     |

**Failure paths covered:** <!-- denial, invalid input, invalid transition, rate limit, AI outage, missing consent -->

- [ ] Every new guard has a test that fails when the guard is removed
- [ ] Time injected where behavior is time-dependent; no `sleep()` added
- [ ] No production or realistic personal data in fixtures

**Commands run:**

- [ ] `format:check` · [ ] `lint` · [ ] `typecheck` · [ ] `test` · [ ] `test:integration` · [ ] `build`

## Security review

Reviewer: `security-engineer` <!-- required if this touches auth, data access, personal data, AI context, or infrastructure -->

- [ ] Identity derived server-side; no client-provided ownership field trusted
- [ ] Ownership verified in the service, independent of RLS
- [ ] New tables: RLS enabled, all four policies, two-user tests
- [ ] Restricted fields encrypted per security §8 with bound AAD
- [ ] No query, filter, sort, or index on an encrypted column; no plaintext searchable copy
- [ ] No restricted data in logs, analytics, URLs, error reports, or notification bodies
- [ ] Consent checked server-side before gated behavior
- [ ] AI context purpose-scoped, capped, redacted, per-request approved
- [ ] AI output schema-validated with invariant checks (evidence refs, approved-field subset, action allowlist)
- [ ] Audit and activity emitted together; audit context allowlisted
- [ ] Rate limits applied where required
- [ ] No secret in code, tests, fixtures, or client bundle
- [ ] Nothing sends externally without explicit user review

**Data classification touched:** <!-- public / internal / confidential / restricted -->

**New personal data collected:** <!-- none, or what and why, with the user-requested function it serves -->

## Accessibility review

Reviewer: `accessibility-reviewer` <!-- required for any UI change -->

- [ ] Every action completable by keyboard alone
- [ ] Hover actions have keyboard and touch equivalents
- [ ] Semantic elements throughout; no clickable `div`
- [ ] Visible focus at 3:1; focus managed on route, dialog, modal step, error submit
- [ ] Landmarks present; one H1; no skipped heading levels
- [ ] Icon-only controls named; decorative icons hidden
- [ ] Forms: labels, descriptions, `aria-invalid`, error summary
- [ ] Contrast verified programmatically in light and dark; no color-only meaning
- [ ] `aria-live` for async status; long AI operations cancellable
- [ ] Reduced motion respected; charts have text alternatives
- [ ] Masked values not announced in full
- [ ] Usable at 320 px and 200% zoom; axe smoke passing

**Manual screen-reader check performed:** <!-- yes (what was checked) / not applicable -->

## Performance review

Reviewer: `performance-engineer` <!-- required for data-heavy views, caching changes, or new queries -->

- [ ] No authenticated response in a shared cache; `private, no-store` where applicable
- [ ] No decrypted value cached across requests or in client storage
- [ ] Protected reads server-side; client boundary at the leaves
- [ ] Keyset pagination with supporting indexes; no N+1
- [ ] Decryption limited to displayed values
- [ ] Heavy components lazy-loaded; layout space reserved; skeletons match structure
- [ ] Query plans checked with `explain analyze` at realistic row counts
- [ ] Budgets met (dashboard 2.5 s, interaction 100 ms, LCP, CLS, bundle)

**Measurements:** <!-- numbers, not impressions -->

## Product and UX review

Reviewer: `product-manager` <!-- required for behavior or user-facing copy -->

- [ ] All nine component states plus not-yet-scored, demo score, AI-unavailable, filtered-empty
- [ ] No claim of scanning, guaranteed deletion, autonomous sending, or end-to-end encryption
- [ ] Nothing implies Atlas sent something it did not send
- [ ] Demo and unverified data labeled; low confidence and staleness disclosed
- [ ] Calm, nonjudgmental tone; danger styling reserved; severity carries text
- [ ] Destructive actions explicit; archive and dismissal offer undo
- [ ] Personal fields optional, masked, unchecked by default
- [ ] User input and drafts preserved on recoverable error
- [ ] Analytics limited to the allowlist with no personal values

## Architecture review

Reviewer: `architect` <!-- required for structural change or anything hard to reverse -->

- [ ] Code sits in the correct layer; dependencies point downward only
- [ ] No cross-feature imports; server-only modules unreachable from client code
- [ ] Service owns authorization and events; repository owns I/O and encryption
- [ ] Derived values written only by their owning service
- [ ] Deterministic logic pure and separated; AI confined to explanation and drafting
- [ ] Irreversible decisions covered by an ADR

## Database review

Reviewer: `database-engineer` <!-- required for any schema change -->

- [ ] Migration append-only and backward-compatible with the deployed app version
- [ ] `user_id` present (or documented exception); RLS and all four policies in this migration
- [ ] Composite foreign keys where cross-user safety matters; FK columns indexed
- [ ] Indexes justified by named queries; none on encrypted columns
- [ ] `timestamptz`, integer score, enum constraints matching the TypeScript union
- [ ] Backfill idempotent, resumable, bounded
- [ ] Table names final — no rename will be possible

## Documentation updates

- [ ] `docs/` updated for behavior or architecture change
- [ ] ADR added or updated: <!-- ADR-00X, or none needed because... -->
- [ ] `CHANGELOG.md` entry for scope change: <!-- or none -->
- [ ] `docs/open-questions.md` updated with any new unresolved decision
- [ ] Ticket notes updated with assumptions and deferrals
- [ ] No documentation contradiction discovered <!-- or: reported here and escalated to ... -->
- [ ] No open question answered by an implementation choice

## Risks

**What could go wrong:**

**Blast radius if it does:**

**Reversibility:** <!-- fully reversible / reversible with a forward migration / irreversible (explain and cite the ADR) -->

**Deferred work:** <!-- ticket IDs and owners, or none -->

**Residual risk accepted:** <!-- what, why, and who agreed -->

## Final checklist

- [ ] Self-reviewed against `code-review/checklists.md` in order
- [ ] Definition of Done satisfied at ticket level (`.claude/definition-of-done.md`)
- [ ] All CI gates green; none bypassed or suppressed
- [ ] No `.env`, secret, key, or credential in the diff
- [ ] No personal data in fixtures, logs, screenshots, or this PR description
- [ ] Every `TODO` links to a ticket
- [ ] Required reviewers requested
- [ ] I did not invent product behavior; ambiguities were escalated per `.claude/decision-tree.md`
