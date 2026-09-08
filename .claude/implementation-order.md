# Atlas Implementation Order

The recommended sequence from empty repository to production release. Ticket-level detail, dependencies, and acceptance criteria live in `docs/05-feature-ticket-list.md`; this document explains the _reasoning_ behind the order so it can be adapted safely.

## Sequencing principles

1. **Security infrastructure before the features that depend on it.** Encryption, redaction, audit, and consent land before any table stores restricted data. Retrofitting encryption onto existing rows is expensive and error-prone.
2. **Schema before service before UI.** Migrations are append-only, so a table's shape must be settled before code depends on it.
3. **Deterministic engines before the surfaces that display them.** Findings and score must exist before the dashboard can show anything real.
4. **AI after the deterministic core.** The assistant explains findings and drafts requests; both need something to explain and draft from.
5. **Vertical slices within a milestone.** Each ticket should work end to end rather than leaving a half-wired layer.
6. **Quality automation early enough to matter.** CI gates, error monitoring, and the RLS test harness arrive in the first three milestones so every later ticket inherits them.

## Milestones

| #   | Theme                                    | Tickets                                                                        | Why here                                                                         |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| M0  | Foundation                               | 001, 002, 003, 004, 090                                                        | Nothing is verifiable without CI, environments, and scanning                     |
| M1  | Design system and shell                  | 008, 009, 010, 095, 005, 006, 007                                              | Tokens and primitives before any surface; monitoring from day one                |
| M2  | Authentication and profile               | 011, 012, 013, 014, 015                                                        | Every subsequent feature needs a verified session                                |
| M3  | Security infrastructure                  | 084, 085, 103, 104, 078, 086, 087, 068, 069                                    | Encryption, redaction, audit, idempotency, consent before restricted data exists |
| M4  | Onboarding and demo data                 | 016, 017, 018, 083                                                             | Consent capture lives here; demo data enables everything downstream              |
| M5  | Digital assets                           | 027, 028, 029, 030, 031, 032, 033, 035, 034, 036, 037                          | The core entity; findings and score have no inputs without it                    |
| M6  | Findings and score                       | 038, 101, 102, 039, 040, 041, 042, 043, 044, 045, 046, 047                     | The deterministic engines that give the product its value                        |
| M7  | AI subsystem                             | 048, 050, 051, 049, 052, 055, 053, 054, 109, 089                               | Explanations need findings; injection tests gate the surface                     |
| M8  | Requests, personal fields, notifications | 105, 106, 056, 057, 058, 059, 060, 061, 062, 063, 064, 065, 067, 107, 108, 066 | The action loop; personal fields must precede drafting                           |
| M9  | Dashboard                                | 019, 020, 021, 022, 023, 024, 025, 026                                         | Aggregates everything above; building it earlier means mocking it                |
| M10 | Activity, archive, search, settings      | 070, 071, 072, 073, 074, 075, 076, 077                                         | Depends on the entities and events already emitting                              |
| M11 | Privacy operations                       | 079, 080, 081, 082, 110                                                        | Export and deletion must cover every table, so they come after the tables exist  |
| M12 | Quality and launch                       | 088, 091, 092, 093, 094, 096, 097, 098, 099, 100                               | Completion and audit of the matrices built incrementally throughout              |
| M13 | Discovery                                | 200, 201, 202, 203, 204, 205, 206, 207, 216, 215, 208, 209, 210, 211, 212, 217, 214 | Discovery-first pipeline; GitHub active, HIBP parked (ATL-216)  |

## Why the non-obvious orderings matter

**M3 before M5.** `digital_assets` stores an encrypted account identifier. If the crypto module (ATL-084) does not exist first, either the column ships plaintext — requiring a migration and a backfill under an append-only rule — or the ticket stalls. The same logic applies to the audit writer: services should emit audit events from their first version, not have them added later.

**ATL-029 (asset permissions) promoted to P0 and placed in M5.** Rules R-004 and R-005 and the score's permission-exposure factor both need permission data. Deferring it would ship a score with a permanently excluded factor.

**ATL-101 (rule engine) before the insights UI.** Building Insights against seeded findings hides the engine's real behavior — dedup, auto-resolution, confidence derivation. The engine first means the UI is built against truth.

**ATL-044 (score) after ATL-101 and ATL-029.** The score consumes findings and permissions. Building it earlier means inventing inputs, and the golden test would not reflect reality.

**M7 (AI) after M6.** ATL-055 explains findings; there must be findings to explain. ATL-089 (prompt injection) sits at the end of M7 so it tests the finished policy layer rather than a partial one.

**ATL-105/106 (personal fields) at the start of M8.** ATL-058 and ATL-059 cannot be built honestly without the vault — the alternative is inventing where draft fields come from, which is exactly the gap the documentation review closed.

**ATL-107 (notifications) before ATL-066 (follow-ups).** Follow-up reminders are a notification consumer. ATL-066 was promoted to P0 because request tracking's value depends on the user actually being told.

**M9 (dashboard) late.** The dashboard aggregates score, assets, findings, requests, and activity. Built early, every card is a placeholder and the aggregated query (ATL-019) gets written twice.

**M11 (export and deletion) near the end.** Both must cover every user-owned table. Built earlier, they need revisiting after each new table — and an incomplete deletion is a privacy defect, not a missing feature.

**M12 completes rather than starts the matrices.** ATL-088 (two-user authorization) and ATL-091 (accessibility) are written incrementally with each ticket; these tickets complete and audit them. Do not defer the underlying tests to M12.

**M13 (Discovery) after M12.** The full security, quality, and launch preparation
infrastructure must exist before the discovery pipeline ships. Discovery touches
consent, outbound data disclosure, encryption, and personal fields — all of which
require M3 and M8 to be complete. M12 quality gates (accessibility, two-user RLS
coverage, launch checklist) apply to the discovery surfaces as well.

**ATL-216 (HIBP optional) in M13.** HIBP configuration is parked by ATL-216, which
makes the provider optional rather than required. The GitHub adapter (ATL-217) is the
only active provider in ACTIVE_DISCOVERY_PROVIDERS at Phase 1. HIBP infrastructure
(including the `discovery_hashed_query` consent type) is retained and valid; activation
is deferred, not abandoned.

**ATL-214 (E2E coverage) closes M13.** Discovery-first onboarding E2E tests validate the onboarding journey and downstream candidate experience — Identity Profile construction, discovery consent, candidate adjudication — using controlled test fixtures and seeded candidates rather than triggering a real production discovery run. The tests confirm functional correctness of the discovery UI and service layers but do NOT validate real product initiation → real discovery run creation → production orchestration → provider dispatch, because that production trigger path remains unwired. HIBP is parked; the tests include no HIBP stub or consent assertions.

**Known gap post-M13.** The DispatchEngine is implemented but not wired to any
application route that triggers a real discovery run in production. This is a Phase 1
engineering gap tracked separately; it does not invalidate M13 completion, but it must
be resolved before Phase 1 product acceptance.

**Engineering complete ≠ Phase 1 product acceptance.** M13 engineering completion means
all tickets pass their acceptance criteria. Phase 1 product acceptance is a separate
review conducted by the product owner and requires the production run trigger gap to be
addressed and the full onboarding journey to be validated end to end.

**Phase 2 guard.** M14 and later milestones must not begin until Phase 1 passes product
acceptance.

## Parallelization

Once M3 is complete, work can proceed in parallel with care:

- **Safe to parallelize:** UI surfaces for different entities; independent schema tickets; documentation and test tooling.
- **Serialize:** anything touching the same migration sequence (append-only means merge order matters); anything touching the shared emitter, crypto module, or policy layer.
- **Never parallelize:** two tickets that both alter the same table's shape.

Coordinate through ticket dependencies and the Database Engineer for migration sequencing.

## Definition of a milestone being complete

Beyond the per-ticket Definition of Done (`definition-of-done.md`):

- Every P0 ticket in the milestone meets its acceptance criteria and testing requirements
- The RLS two-user matrix covers every table added in the milestone
- Accessibility checks pass for every UI surface added
- Documentation reflects any behavior or architecture change
- No blocking open question was answered by implementation
- Deferred work is ticketed with an owner

## Adapting the order

The order may change; the _constraints_ may not:

- Security infrastructure precedes restricted-data storage
- Schema precedes dependent code
- Deterministic engines precede their display surfaces
- AI follows the deterministic core
- Export and deletion follow the tables they must cover
- Tests are written with their ticket, not deferred to M12

Any reordering that violates one of these needs the Architect's sign-off and an entry in `CHANGELOG.md`.
