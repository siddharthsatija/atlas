# Atlas Feature Ticket Backlog

## Conventions

- **P0:** required before MVP launch. **P1:** targeted for MVP if schedule allows.
- **S/M/L/XL:** relative complexity, not time commitments.
- Tickets are listed in **implementation order**, grouped into milestones M0–M12. A ticket's dependencies must be complete (or explicitly stubbed) before it starts.
- Security and privacy acceptance criteria apply to every ticket even when not repeated: authorization verified server-side, inputs validated with Zod, no restricted data in logs/analytics, RLS on any new user-owned table with two-user tests.
- UI tickets always cover loading, empty, error, success, keyboard, and responsive states.
- References: ADR-001…006 in `docs/adr/`, architecture (02), security (03), frontend (04).

## Definition of done

A ticket is done only when acceptance criteria pass, authorization and validation are implemented, tests cover critical behavior and security-sensitive logic, all component states are handled, accessibility is reviewed, no sensitive data reaches logs or analytics, and documentation is updated when behavior or architecture changes.

## Build order summary

| Milestone | Theme                                    | Tickets                                                                        |
| --------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| M0        | Foundation                               | 001, 002, 003, 004, 090                                                        |
| M1        | Design system and shell                  | 008, 009, 010, 095, 005, 006, 007                                              |
| M2        | Authentication and profile               | 011, 012, 013, 014, 015                                                        |
| M3        | Security infrastructure                  | 084, 085, 103, 104, 078, 086, 087, 068, 069                                    |
| M4        | Onboarding and demo data                 | 016, 017, 018, 083                                                             |
| M5        | Digital assets                           | 027, 028, 029, 030, 031, 032, 033, 035, 034, 036, 037                          |
| M6        | Findings and score                       | 038, 101, 102, 039, 040, 041, 042, 043, 044, 045, 046, 047                     |
| M7        | AI subsystem                             | 048, 050, 051, 049, 052, 055, 053, 054, 109, 089                               |
| M8        | Requests, personal fields, notifications | 105, 106, 056, 057, 058, 059, 060, 061, 062, 063, 064, 065, 067, 107, 108, 066 |
| M9        | Dashboard                                | 019, 020, 021, 022, 023, 024, 025, 026                                         |
| M10       | Activity, archive, search, settings      | 070, 071, 072, 073, 074, 075, 076, 077                                         |
| M11       | Privacy operations                       | 079, 080, 081, 082, 110                                                        |
| M12       | Quality and launch                       | 088, 091, 092, 093, 094, 096, 097, 098, 099, 100                               |

---

## M0 · Foundation

### ATL-001 · Project bootstrap

**Epic:** Platform · **Priority:** P0 · **Complexity:** S · **Depends on:** —

**Objective:** Initialize Next.js (App Router), TypeScript strict mode, ESLint, Prettier, Vitest/Playwright runners, and environment-variable validation with a typed schema.

**Acceptance criteria**

- `npm run format:check`, `lint`, `typecheck`, `test`, and `build` all pass on a clean clone.
- Environment variables are validated at boot with Zod; missing or malformed values fail the build with a clear message and no secret values echoed.
- Strict mode enabled; no `any` escapes in repo templates.
- Repository structure matches architecture §6.3.

**Testing:** unit test for the env validator (valid, missing, malformed cases).

### ATL-002 · Repository documentation

**Epic:** Platform · **Priority:** P0 · **Complexity:** S · **Depends on:** ATL-001

**Objective:** Add the documentation package (docs/, ADRs, CLAUDE.md, CHANGELOG) to the repository and wire docs updates into the definition of done.

**Acceptance criteria**

- All documents, ADRs, `open-questions.md`, and CHANGELOG are in the repository and referenced from README.
- PR template includes a "documentation updated?" checklist item.

**Testing:** none beyond CI markdown lint if configured.

### ATL-003 · Supabase environments

**Epic:** Platform · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-001

**Objective:** Create separate local, staging, and production Supabase projects with per-environment secrets and configuration.

**Acceptance criteria**

- Three isolated projects; keys never shared across environments; production keys restricted.
- Local development runs against the local project with documented setup.
- No production data path to lower environments (architecture §18).
- Migration workflow (append-only) documented and runnable per environment.

**Testing:** scripted smoke check that each environment connects with its own credentials.

### ATL-004 · CI quality gates

**Epic:** Platform · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-001, ATL-003

**Objective:** Run format, lint, typecheck, unit tests, integration tests, build, and migration validation on every pull request.

**Acceptance criteria**

- All gates from architecture §19 run on PRs and block merge on failure.
- Migration validation detects non-append-only changes.
- CI has no access to production secrets.

**Testing:** deliberately failing fixture branch demonstrates each gate blocks.

### ATL-090 · Secret and dependency scanning

**Epic:** Security · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-004

**Objective:** Add secret scanning and dependency/supply-chain scanning to CI with a documented remediation workflow.

**Acceptance criteria**

- Secret scan blocks merges on detection; test fixture verified.
- Dependency scan reports run per PR; critical findings block merge.
- Remediation and key-rotation-on-exposure workflow documented (security §9).

**Testing:** fixture secret and known-vulnerable fixture dependency both trigger blocks.

---

## M1 · Design system and shell

### ATL-008 · Design tokens

**Epic:** Design System · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-001

**Objective:** Implement semantic color (light and dark from design system §2.1 baseline palette), typography, spacing, radius, elevation, and motion tokens.

**Acceptance criteria**

- All semantic roles from design system §2 exist as CSS variables/Tailwind theme; no raw hex in components.
- Every text/background pairing passes WCAG 2.2 AA contrast (verified programmatically); deviations from the baseline palette stay within hue family and are documented.
- Dark mode switches at token level; reduced-motion token respected.

**Testing:** automated contrast check over the token matrix; visual snapshot of token sheet in both modes.

### ATL-009 · Core UI primitives

**Epic:** Design System · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-008

**Objective:** Implement buttons, inputs, cards, badges, dialog, drawer, tabs, toast, tooltip, dropdown, skeleton, empty state, and the SensitiveValue masked-reveal component.

**Acceptance criteria**

- Every component implements the states in frontend §18 and design system §9–§12.
- Dialog/drawer implement focus trap, escape, and focus return.
- SensitiveValue masks by default, reveal is explicit and temporary, and reveal emits an audit-worthy event hook.
- Severity and status badges include text, never color alone.

**Testing:** unit tests for interactive behavior; axe checks per component; keyboard traversal tests for dialog and dropdown.

### ATL-010 · Error boundaries

**Epic:** Platform · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-009

**Objective:** Route-level and component-level error boundaries with privacy-safe reporting and recovery actions.

**Acceptance criteria**

- Route errors render a calm recovery page preserving navigation; component errors degrade locally.
- Reported errors contain no personal data, request bodies, or tokens (redaction verified).
- Reset/retry restores state without full reload where safe.

**Testing:** forced-error fixtures for both boundary levels; assertion on redacted report payload.

### ATL-095 · Error monitoring

**Epic:** Observability · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-010

**Objective:** Wire error monitoring with redaction, release tagging, route, and request ID from the start of development.

**Acceptance criteria**

- Captures route, status, error code, request ID, release; never captures the architecture §16 "never capture" list.
- Redaction runs before transport; verified with a poisoned fixture event.
- Separate DSN/keys per environment.

**Testing:** integration test asserting redacted payload shape.

### ATL-005 · Application shell

**Epic:** Frontend · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-009

**Objective:** Responsive product shell: collapsible sidebar, sticky top bar, content region per frontend §2–§4.

**Acceptance criteria**

- Sidebar order matches frontend §3; content max width ~1440 px; tablet and mobile layouts per spec.
- Top bar contains title/breadcrumb, search trigger, notification control (badge wired later), Ask Atlas trigger.
- Landmarks and heading hierarchy are semantic; skip-to-content link present.

**Testing:** responsive snapshot tests at the §21 breakpoints; axe smoke; keyboard navigation across shell.

### ATL-006 · Sidebar collapse control

**Epic:** Frontend · **Priority:** P0 · **Complexity:** S · **Depends on:** ATL-005

**Objective:** Accessible collapse control beside the Atlas wordmark with per-user persisted preference.

**Acceptance criteria**

- Control sits beside the wordmark (never bottom); collapsed rail 72–80 px with tooltip labels; expanded 240–264 px.
- Preference persists per user across sessions; selected state preserved on collapse.
- Fully keyboard operable with accessible name announcing state.

**Testing:** interaction test for persistence; screen-reader name assertions.

### ATL-007 · Mobile navigation drawer

**Epic:** Frontend · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-005

**Objective:** Accessible mobile drawer replacing the sidebar below the medium breakpoint.

**Acceptance criteria**

- Drawer (not compressed rail) with focus trap, escape, scrim dismissal, and focus return.
- Primary actions reachable; route change closes drawer.

**Testing:** keyboard and touch interaction tests; axe check open/closed.

---

## M2 · Authentication and profile

### ATL-011 · Authentication setup

**Epic:** Authentication · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-003

**Objective:** Configure Supabase Auth email magic link and optional Google OAuth per security §5.

**Acceptance criteria**

- Magic-link flow works end to end; Google OAuth optional path works; both methods resolve to one identity per email (linking behavior explicit and tested).
- Responses never reveal whether an email is registered.
- Secure, HttpOnly, SameSite cookies; auth attempts rate-limit-ready (limits enforced in ATL-086).
- Login security notifications enabled where provider supports them.

**Testing:** integration tests for link issuance/consumption, expired link, OAuth linking; assertion on registration-neutral messaging.

### ATL-012 · Protected routes

**Epic:** Authentication · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-011, ATL-005

**Objective:** Protect all product routes; redirect unauthenticated users; verify session server-side.

**Acceptance criteria**

- Every `(product)` route requires a verified server-side session; client state is never authorization evidence.
- Unauthenticated access redirects to sign-in preserving the return path (no sensitive data in the URL).
- API routes and server actions authenticate before reading bodies where possible.

**Testing:** integration tests per route group; middleware unit tests.

### ATL-013 · Session management

**Epic:** Authentication · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-011

**Objective:** Sign-out, sign-out-all-devices, and defined session lifetimes within provider capabilities.

**Acceptance criteria**

- Sign-out revokes the current session; sign-out-all revokes all refresh tokens.
- Absolute and idle lifetimes chosen, documented, and enforced (custom middleware where the provider lacks native support).
- Session security events emit through the audit hook (wired fully in ATL-103).

**Testing:** integration tests for revocation; lifetime expiry simulation.

### ATL-014 · Authentication UI

**Epic:** Frontend · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-011, ATL-009

**Objective:** Sign-in, verification-sent, error, and expired-link states per frontend §16.

**Acceptance criteria**

- Calm, minimal screens; neutral error messages; loading and verification states; privacy/terms links.
- No misleading security claims in copy.
- Fully keyboard accessible; error summaries and field-level errors.

**Testing:** E2E happy path and expired-link path; axe checks.

### ATL-015 · Profile schema

**Epic:** Data · **Priority:** P0 · **Complexity:** S · **Depends on:** ATL-003

**Objective:** `profiles` table per architecture §7.1 (including `onboarding_state_json`, `selected_categories`), migration, generated types, RLS.

**Acceptance criteria**

- RLS uses `auth.uid() = id` (documented exception); insert/update/select policies tested with two users.
- Profile row created on first sign-in; timezone/locale defaults sensible.

**Testing:** two-user RLS tests; creation integration test.

---

## M3 · Security infrastructure

### ATL-084 · Application-layer encryption

**Epic:** Security · **Priority:** P0 · **Complexity:** XL · **Depends on:** ATL-003, ATL-015

**Objective:** Implement the ADR-003 envelope-encryption module: AES-256-GCM with row/column-bound AAD, per-user DEKs in `user_encryption_keys` wrapped by the environment KEK, rotation procedures, and the crypto-shredding primitive.

**Acceptance criteria**

- Single server-only crypto module; encrypt/decrypt round-trip with AAD binding (decryption fails if ciphertext is moved between rows or columns).
- `user_encryption_keys` table with RLS deny-all client policies; DEK generated lazily on first restricted write.
- KEK rotation re-wraps all DEKs without touching data rows; procedure scripted and documented.
- DEK destruction primitive is irreversible and documented as the account-deletion first step.
- KEK sourced from managed secret storage only; never logged, never bundled.

**Testing:** unit tests for round-trip, tamper, wrong-AAD, wrong-key; integration tests for KEK rotation and post-shred unreadability.

### ATL-085 · Central log redaction

**Epic:** Security · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-001

**Objective:** Allowlist-based telemetry/log redaction utility used by all logging, monitoring, and analytics paths.

**Acceptance criteria**

- Only allowlisted keys pass; unknown keys are dropped and counted; restricted patterns (emails, phone numbers, tokens) scrubbed from string values as defense in depth.
- All logger/monitoring entry points route through the utility; direct transport use fails lint.

**Testing:** table-driven unit tests including nested payloads; lint rule test.

### ATL-103 · Audit event schema and writer

**Epic:** Security · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-084, ATL-085

**Objective:** `audit_events` table and server-only audit writer per ADR-006: pseudonymous subject refs, context allowlist, hash chaining, and the shared activity+audit emitter API.

**Acceptance criteria**

- Table has RLS deny-all client policies; app role granted INSERT/SELECT only; UPDATE/DELETE attempts fail in tests.
- `subject_ref` is an HMAC of the user ID; HMAC key in secret storage.
- Hash chain computed per subject; verification job detects tampering in a fixture.
- Event inventory from security §12 emitted through one API that also writes user-facing activity where applicable.

**Testing:** immutability tests; chain verification positive/negative; allowlist enforcement.

### ATL-104 · Idempotency key storage

**Epic:** Platform · **Priority:** P0 · **Complexity:** S · **Depends on:** ATL-003

**Objective:** `idempotency_keys` table and helper wrapping transition/job handlers per architecture §7.17.

**Acceptance criteria**

- Duplicate submission with the same key returns the recorded result without re-executing.
- Keys expire after 24 hours via purge job.

**Testing:** duplicate-suppression and expiry tests; double-submit race test.

### ATL-078 · Consent schema and history

**Epic:** Privacy · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-015

**Objective:** `consents` table with defined `consent_type` values (`ai_processing`, `personal_fields_storage`, `ai_conversation_history`, `product_updates`), policy versioning, and user-visible history.

**Acceptance criteria**

- Grant/revoke writes an immutable consent row with policy version; history visible in Settings.
- Server-side consent-check helper gates AI, personal fields, and conversation history.
- Consent changes emit audit events.

**Testing:** two-user RLS tests; grant→revoke→re-grant history integrity test.

### ATL-086 · Rate limiting

**Epic:** Security · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-003, ATL-011

**Objective:** Rate-limit authentication, AI, export, and request-generation operations backed by the shared durable store (architecture §3).

**Acceptance criteria**

- Limits enforced per user and per IP where applicable; serverless-safe (no in-memory counters).
- 429 responses use the typed error envelope; UI shows a calm retry message.
- Limits configurable per environment; auth limits meet security §5.

**Testing:** integration tests hitting each limited surface; envelope assertions.

### ATL-087 · Security headers

**Epic:** Security · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-001

**Objective:** CSP (nonce-based, no unsafe-inline), HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors, secure cookie attributes.

**Acceptance criteria**

- Nonce-based CSP works with App Router streaming; no unsafe-inline in production.
- All security §18 headers present on every response; verified in CI smoke.

**Testing:** header assertions in integration tests; CSP violation report path verified.

### ATL-068 · Activity event schema

**Epic:** Activity · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-015

**Objective:** `activity_events` table per architecture §7.9 with RLS and indexes for timeline queries.

**Acceptance criteria**

- Standard RLS pattern; indexes on `(user_id, occurred_at)` and entity lookups.
- `metadata_redacted_json` schema-validated against an allowlist.

**Testing:** two-user RLS tests; index usage check on the timeline query.

### ATL-069 · Activity writer

**Epic:** Activity · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-068, ATL-103

**Objective:** Centralized safe event summaries via the shared emitter (single call site with the audit writer).

**Acceptance criteria**

- All services write activity through the emitter; summaries contain no restricted values (masked identifiers at most).
- Event types enumerated and typed; unknown types rejected.

**Testing:** summary redaction unit tests; integration test proving audit and activity are emitted together for a request transition.

---

## M4 · Onboarding and demo data

### ATL-016 · Onboarding flow

**Epic:** Onboarding · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-012, ATL-015, ATL-078

**Objective:** Purpose/limitations, privacy goal, asset categories, demo-or-add choice, and completion steps per frontend §17, including AI-processing consent capture.

**Acceptance criteria**

- Steps match frontend §17 with progress indicator, back, and safe skip; no sensitive fields requested.
- `ai_processing` consent captured with policy version before any AI feature is usable.
- Limitations copy states what Atlas does not do (no scanning, no guaranteed deletion).
- Completion sets `onboarding_completed_at` and routes to the dashboard.

**Testing:** E2E full flow and skip paths; consent row assertion; axe checks per step.

### ATL-017 · Onboarding persistence

**Epic:** Onboarding · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-016

**Objective:** Save step progress in `profiles.onboarding_state_json`; resume safely on return.

**Acceptance criteria**

- Refresh/return resumes at the saved step with prior choices intact; back and skip update state consistently.
- State contains no sensitive values; schema-validated; malformed state recovers to the nearest safe step.

**Testing:** save/resume integration test; malformed-state recovery test.

### ATL-018 · Demo data seed

**Epic:** Onboarding · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-016 (expands as M5/M6 schemas land)

**Objective:** Clearly labeled per-user demo dataset (assets, categories, permissions, findings) that exercises the product realistically.

**Acceptance criteria**

- Demo records carry `source_type = demo` everywhere and render with demo labels.
- Demo findings and scores follow architecture §11 demo isolation; no real-data mixing.
- Seed is idempotent per user and fully removable.

**Testing:** seed idempotency test; label rendering test; isolation assertion.

### ATL-083 · Demo data removal

**Epic:** Privacy · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-018

**Objective:** One-action removal of all demo records without touching real data, from Settings → Data.

**Acceptance criteria**

- Removes all demo rows (assets, categories, permissions, findings, demo snapshots) atomically; real records untouched (verified with mixed data).
- Score state transitions correctly (to real score or "Not yet scored").

**Testing:** mixed real+demo integration test; post-removal score-state assertions.

---

## M5 · Digital assets

### ATL-027 · Digital asset schema

**Epic:** Assets · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-084

**Objective:** `digital_assets` table per architecture §7.2 with encrypted `account_identifier_encrypted`, indexes, types, RLS.

**Acceptance criteria**

- Standard RLS; indexes on `(user_id, status)`, `(user_id, category)`, and FK columns.
- Account identifier encrypted via the crypto module; `metadata_json` schema-validated.
- Status and source enums match §7.2.

**Testing:** two-user RLS tests; encryption round-trip through the repository layer.

### ATL-028 · Asset data categories schema

**Epic:** Assets · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-027

**Objective:** `asset_data_categories` table per §7.3 with RLS and cross-user FK protection.

**Acceptance criteria**

- Child table includes `user_id`; FK to assets cannot cross users (constraint tested).
- Category and sensitivity enums match §7.3.

**Testing:** two-user RLS tests including cross-user FK attempt.

### ATL-029 · Asset permissions schema

**Epic:** Assets · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-027

**Objective:** `asset_permissions` table per §7.4 with RLS. (Promoted from P1: permission data feeds rules R-004/R-005 and the score's permission factor.)

**Acceptance criteria**

- Standard child-table pattern with `user_id`; scope values include a defined `broad` classification used by the rules engine.

**Testing:** two-user RLS tests; scope classification unit test.

### ATL-030 · Asset service layer

**Epic:** Assets · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-027, ATL-028, ATL-029, ATL-069

**Objective:** Authorized asset CRUD, archive, and restore operations with activity events and findings-recompute hooks.

**Acceptance criteria**

- Every operation verifies ownership in the service layer and RLS; client `user_id` ignored.
- Mutations emit activity events and enqueue findings recompute (no-op until ATL-101).
- Pagination, sorting, and filters implemented server-side; typed error envelope.

**Testing:** service-level authorization tests; pagination/filter integration tests.

### ATL-031 · Asset list page

**Epic:** Assets · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-030

**Objective:** Search, filters (category, status, risk, source, last reviewed), sorting, card grid with optional compact list, and empty state per frontend §6.

**Acceptance criteria**

- Filters and search operate on non-restricted fields only; URL-driven state without sensitive values.
- Empty state offers add-first-asset, demo data, and discovery explanation.
- Card actions (view, edit, archive, request) reachable by hover, keyboard, and touch overflow.

**Testing:** filter/search integration tests; axe and keyboard tests; empty-state render test.

### ATL-032 · Add asset flow

**Epic:** Assets · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-030

**Objective:** Validated manual asset creation (service, category, domain, optional identifier, data categories, permissions).

**Acceptance criteria**

- Zod validation client- and server-side; identifier stored encrypted and masked immediately.
- Form preserves input on recoverable errors; success routes to the asset detail.
- Created asset triggers findings recompute and score recalculation.

**Testing:** E2E create path; validation unit tests; masked-render assertion.

### ATL-033 · Edit asset flow

**Epic:** Assets · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-032

**Objective:** Edit service metadata, notes, status, data categories, permissions, and source information.

**Acceptance criteria**

- Edits validated and ownership-checked; status changes emit activity events.
- `last_reviewed` updates on explicit review action, not on every save.

**Testing:** edit integration tests including status transitions.

### ATL-035 · Mask sensitive identifiers

**Epic:** Security · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-009, ATL-027

**Objective:** Apply SensitiveValue masking to all identifier displays with deliberate, temporary reveal and audit hook.

**Acceptance criteria**

- Identifiers masked by default everywhere (lists, details, drafts); reveal requires explicit action and auto-remasks.
- Reveal actions emit audit events (via ATL-103).
- No sensitive values in URLs or query strings.

**Testing:** render assertions across surfaces; reveal-event emission test.

### ATL-034 · Asset detail page

**Epic:** Assets · **Priority:** P0 · **Complexity:** XL · **Depends on:** ATL-030, ATL-035

**Objective:** Identity header, overview, information held, permissions, findings, requests, activity, and notes sections per frontend §7.

**Acceptance criteria**

- Every factual item shows source and last-verified time where available.
- Header actions: edit, archive, request correction, request deletion, overflow menu.
- Related findings/requests/activity scoped to this asset; progressive disclosure on mobile.

**Testing:** integration tests per section; axe; cross-user access test (404, not 403 leak).

### ATL-036 · Archive and restore asset

**Epic:** Assets · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-030

**Objective:** Reversible archive/restore with undo toast and clear external-service distinction.

**Acceptance criteria**

- Archive is reversible; undo offered; archived assets appear only in Archive.
- Copy explains archiving in Atlas ≠ deletion from the external service.
- Archive/restore emit activity events and trigger findings recompute (R-006).

**Testing:** archive→restore integration test; undo behavior test.

### ATL-037 · Permanent asset deletion

**Epic:** Assets · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-036

**Objective:** Permanent deletion with explicit confirmation, authorization, and audit event.

**Acceptance criteria**

- Explicit-language confirmation (no vague "OK"); deletion cascades child records in a transaction.
- Audit event recorded; related findings auto-resolve.

**Testing:** cascade integrity test; confirmation flow test.

---

## M6 · Findings and score

### ATL-038 · Privacy finding schema

**Epic:** Findings · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-027

**Objective:** `privacy_findings` table per architecture §7.5 including rule fields (`rule_id`, `rule_version`, `dedup_key`, `evidence_refs_json`, `resolved_by`), indexes, RLS.

**Acceptance criteria**

- Unique constraint on `(user_id, dedup_key)`; indexes for status and severity queries.
- Enums match §7.5; evidence summary column documented as restricted-value-free.

**Testing:** two-user RLS tests; dedup constraint test.

### ATL-101 · Findings rule engine

**Epic:** Findings · **Priority:** P0 · **Complexity:** XL · **Depends on:** ATL-038, ATL-030

**Objective:** Implement the ADR-001 deterministic rule engine with rule catalog v1 (R-001…R-008), mutation-triggered recompute job, and nightly sweep.

**Acceptance criteria**

- All eight rules implemented as pure functions matching architecture §11.1 predicates, severities, and recommended actions.
- Confidence derived from input source and staleness per the confidence model; demo inputs produce demo-labeled findings only in demo mode.
- Evidence summaries rendered from templates with no restricted values; `evidence_refs_json` and `source_reference` (`rule_id@version`) populated.
- Recompute is idempotent; nightly sweep evaluates time-based predicates; both are observable jobs.
- Rule catalog is versioned; changing a rule requires a version bump recorded on generated findings.

**Testing:** table-driven unit tests per rule (fire, no-fire, boundary dates, severity escalation, confidence caps); idempotency test; demo isolation test.

### ATL-102 · Findings dedup and auto-resolution

**Epic:** Findings · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-101

**Objective:** Dedup-key generation, re-fire suppression for dismissed findings, and system auto-resolution when predicates clear.

**Acceptance criteria**

- Same condition never creates a duplicate open finding.
- Dismissed findings are not re-raised unless the input hash materially changes.
- Predicate clearing auto-resolves with `resolved_by = system`, emits activity, and triggers score recalculation.

**Testing:** lifecycle tests: fire → dismiss → input change → re-fire; fire → fix → auto-resolve.

### ATL-039 · Finding service

**Epic:** Findings · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-038, ATL-069

**Objective:** List, detail, resolve, dismiss operations with authorization and recommendation ordering.

**Acceptance criteria**

- Ownership verified; list supports status/severity filters and recommended ordering (severity, then confidence, then age).
- Resolve/dismiss validate current status; both emit activity and trigger score recalculation.

**Testing:** authorization tests; ordering unit test; invalid-transition tests.

### ATL-040 · Insights page

**Epic:** Findings · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-039

**Objective:** Recommended, All, Resolved, and Dismissed views per frontend §8.

**Acceptance criteria**

- Finding cards show severity, title, explanation, evidence summary, source, confidence, impacted asset, recommended action.
- Critical styling only for verified critical findings; severity never color-only.
- Empty states differ per tab and explain how findings are generated (user's own data, no scanning).

**Testing:** view filter tests; axe; empty-state copy assertions.

### ATL-041 · Finding detail panel

**Epic:** Findings · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-039

**Objective:** Evidence, source (`rule_id@version`), confidence, impact, and recommendation display with Ask Atlas hook.

**Acceptance criteria**

- Shows rule provenance, evaluated records (linked), last evaluation time, and confidence rationale.
- Recommended action deep-links to the relevant flow (asset, request, permission review).

**Testing:** render tests with each rule type; link-through tests.

### ATL-042 · Resolve finding

**Epic:** Findings · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-039

**Objective:** User resolution flow recording action taken, updating status, activity, and score.

**Acceptance criteria**

- Resolution requires selecting or confirming the action taken; status → resolved with `resolved_by = user`.
- Score recalculates; activity and audit events emitted.

**Testing:** resolve flow integration test; score-change assertion.

### ATL-043 · Dismiss finding

**Epic:** Findings · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-039

**Objective:** Dismissal with optional reason and undo.

**Acceptance criteria**

- Optional reason captured (incorrect, not relevant, accepted risk); undo restores open state.
- Dismissal does not improve the score (deduction retained until condition clears); UI explains this honestly.

**Testing:** dismiss/undo tests; score-unchanged assertion.

### ATL-044 · Score model v1

**Epic:** Privacy Score · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-101, ATL-029

**Objective:** Implement the deterministic `score-v1` model per ADR-004: six factors, fixed weights, renormalization, cold start, demo isolation.

**Acceptance criteria**

- Factor computations match ADR-004 exactly, including the worked example (≈56).
- Factors without data are excluded with weight renormalization; exclusions recorded in the breakdown.
- No score before the first non-demo asset; demo scores computed only over demo records and flagged.
- Weights and thresholds live in versioned configuration; version recorded on every calculation.

**Testing:** unit tests per factor; the ADR worked example as a golden test; renormalization, cold-start, and demo-isolation tests.

### ATL-045 · Score snapshots

**Epic:** Privacy Score · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-044, ATL-104

**Objective:** Snapshot persistence with `score_version`, `is_demo`, factor breakdown, and reason; write-on-change semantics; compaction job.

**Acceptance criteria**

- Snapshot written only when score or breakdown changes; recalculation is idempotent.
- Compaction keeps full history 90 days, then one per day; demo snapshots deleted with demo data.

**Testing:** write-on-change test; compaction job test; demo-purge test.

### ATL-046 · Score detail view

**Epic:** Privacy Score · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-045

**Objective:** Factor breakdown, coverage, contributors, history, improvement actions, and limitations per frontend §12.

**Acceptance criteria**

- Shows weights, per-factor scores, excluded factors (coverage), positive/negative contributors, and change history.
- Improvement actions deep-link to real flows; disclaimer present; demo label persistent when applicable.

**Testing:** render tests for scored/not-yet-scored/demo states; link-through tests.

### ATL-047 · Accessible score chart

**Epic:** Privacy Score · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-046

**Objective:** Score history chart with text summary and non-color cues.

**Acceptance criteria**

- Text alternative summarizes trend; markers distinguish series without color; reduced-motion respected.

**Testing:** axe; text-summary content test.

---

## M7 · AI subsystem

### ATL-048 · AI gateway

**Epic:** AI · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-001, ATL-086

**Objective:** Server-only provider adapter with timeout, retry, typed error mapping, and provider abstraction.

**Acceptance criteria**

- No provider key reachable from client code (verified by bundle analysis in CI).
- Timeouts and bounded retries; provider errors mapped to typed codes; rate limits applied.
- Provider data-retention configured to the strongest available mode.

**Testing:** adapter unit tests with mocked provider; bundle-analysis assertion.

### ATL-050 · AI output schemas

**Epic:** AI · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-048

**Objective:** Zod schemas for explanation and draft outputs per AI behavior §7, with reject/retry on malformed responses.

**Acceptance criteria**

- Explanation and draft schemas implemented exactly as specified; extra fields stripped; malformed output rejected then retried once, then fallback.
- Schema versions recorded on `ai_interactions`.

**Testing:** valid/invalid/adversarial fixture tests; retry-then-fallback test.

### ATL-051 · Prompt registry

**Epic:** AI · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-048

**Objective:** Version-controlled prompt templates; prompt and schema versions recorded per interaction; eval set wired to versions.

**Acceptance criteria**

- Prompts live in the repository with version identifiers; changing a prompt requires a version bump.
- Each interaction records prompt version; the AI behavior §13 evaluation set runs against a prompt version in CI (or a documented pre-release step) and blocks regression.

**Testing:** version recording test; eval harness smoke run.

### ATL-049 · AI policy layer

**Epic:** AI · **Priority:** P0 · **Complexity:** XL · **Depends on:** ATL-050, ATL-051, ATL-078

**Objective:** Purpose classification, minimal retrieval, redaction, per-request personal-field approval enforcement, and allowed-use policy per architecture §12 and security §10.

**Acceptance criteria**

- Purpose taxonomy defined (explain_finding, summarize_asset, explain_score, recommend_action, draft_request, product_question) with a per-purpose data-selection policy.
- Retrieval returns only records the purpose allows, capped in count and sensitivity; unrelated records never included (tested).
- Stored personal fields pass only with per-request approval; redaction runs before every provider call.
- Retrieved text is delimited as untrusted; `ai_processing` consent checked before any call.
- All interactions recorded in `ai_interactions` metadata.

**Testing:** per-purpose selection tests; over-retrieval attempt tests; unapproved-field blocking test; consent-gate test.

### ATL-052 · AI unavailable fallback

**Epic:** AI · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-049

**Objective:** Deterministic explanations and manual draft templates when AI fails or is rate-limited.

**Acceptance criteria**

- Finding explanations fall back to rule-based template text (from the rule catalog's evidence templates).
- Draft flow offers a standard editable template; user input preserved; no provider errors exposed.
- All manual workflows function with AI disabled (feature-flag test).

**Testing:** provider-outage simulation across each AI surface.

### ATL-055 · Finding explanation

**Epic:** AI · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-049, ATL-041

**Objective:** Plain-language explanation grounded in finding evidence with confidence and uncertainty disclosure.

**Acceptance criteria**

- Explanation cites evidence references from the finding only; demo data labeled; stale sources disclosed.
- Output validated against the explanation schema; no new factual claims beyond provided context.

**Testing:** grounding tests with fixture findings; hallucination probe tests.

### ATL-053 · Global assistant UI

**Epic:** AI · **Priority:** P1 · **Complexity:** L · **Depends on:** ATL-049, ATL-005

**Objective:** Assistant panel with context disclosure, suggested prompts, source references, feedback control, and clear-conversation.

**Acceptance criteria**

- Panel states what context is in use; suggestions tie to current records; sources shown per response.
- Feedback (helpful/not + categories) captured without restricted content; clear-conversation works.
- Long operations show progress and support cancellation.

**Testing:** interaction tests; feedback payload redaction test; axe.

### ATL-054 · Asset-context assistant

**Epic:** AI · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-053, ATL-034

**Objective:** Restrict assistant context to the selected asset and related records on asset/finding pages.

**Acceptance criteria**

- Context disclosure names the asset; retrieval scoped to it (policy-layer enforced, tested).

**Testing:** scope-enforcement test attempting cross-asset leakage.

### ATL-109 · AI conversation history

**Epic:** AI · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-053, ATL-084, ATL-078

**Objective:** Consent-gated `ai_conversations`/`ai_messages` storage with encrypted content per architecture §7.18.

**Acceptance criteria**

- Off by default; enabling requires `ai_conversation_history` consent; disabling hard-deletes all conversations.
- Message content encrypted; history excluded from analytics; included in export; crypto-shredded on account deletion.

**Testing:** consent-gate tests; disable-deletes test; encryption round-trip.

### ATL-089 · Prompt injection tests

**Epic:** Security · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-049

**Objective:** Adversarial test suite proving untrusted asset text cannot override policy, exfiltrate data, or trigger actions.

**Acceptance criteria**

- Injection payloads in asset names/notes/categories cannot change system behavior, expand retrieval, or produce action execution (actions are proposals only).
- Suite runs in CI against the current prompt version; failures block release.

**Testing:** the ticket is the test suite; must cover AI behavior §13 injection cases.

---

## M8 · Requests, personal fields, notifications

### ATL-105 · Personal fields schema and service

**Epic:** Requests · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-084, ATL-078

**Objective:** `user_personal_fields` table (ADR-002) with encrypted values, RLS, consent gating, and CRUD service.

**Acceptance criteria**

- Values encrypted via the crypto module; masked in all reads by default; `last_used_at` maintained.
- First save requires `personal_fields_storage` consent; every field optional and hard-deletable.
- No personal-field values in logs, analytics, search, or exports of other users (export includes own values).

**Testing:** two-user RLS tests; encryption round-trip; consent-gate test; deletion test.

### ATL-106 · Personal fields settings UI

**Epic:** Requests · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-105

**Objective:** Settings → Personal data: list, add, edit, reveal, delete fields per frontend §15.

**Acceptance criteria**

- Masked by default with explicit temporary reveal; shows last-used context; delete confirms with explicit language.
- Explains encryption honestly (server-side, not end-to-end) and per-request usage rules.

**Testing:** CRUD flow tests; reveal audit-event test; axe.

### ATL-056 · Data request schema

**Epic:** Requests · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-084, ATL-027

**Objective:** `data_requests` (with `request_type`: deletion, correction) and `request_events` tables per architecture §7.7–7.8, encrypted recipient/subject/body, RLS.

**Acceptance criteria**

- Recipient, subject, and body encrypted; `included_fields_json` stores keys only.
- Status enum matches the §13 lifecycle; `request_events` records actor type.

**Testing:** two-user RLS tests; encryption round-trip; enum coverage.

### ATL-057 · Request state machine

**Epic:** Requests · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-056, ATL-104

**Objective:** Validated lifecycle transitions per architecture §13, including system transitions, idempotency, and event recording.

**Acceptance criteria**

- Every §13 transition allowed and every non-listed transition rejected with `REQUEST_INVALID_TRANSITION` (exhaustive matrix test).
- `sent → awaiting_response` runs via system job 3 days after `sent_at` or on user response note; `rejected` behaves as nonterminal per spec.
- Transitions idempotent via idempotency keys; each writes `request_events` plus audit.

**Testing:** exhaustive transition matrix; job-driven transition test; duplicate-transition idempotency test.

### ATL-058 · Request data review (Step 1)

**Epic:** Requests · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-105, ATL-034

**Objective:** Field-review step: information believed held, personal-field checkboxes (unchecked by default), just-in-time field capture, user-entered recipient.

**Acceptance criteria**

- Stored fields render masked with per-field include checkboxes defaulting to unchecked; first-use add-field form saves to the vault with consent.
- Recipient entered/confirmed by user, validated as email, labeled unverified.
- Uncertain evidence shows the warning state; selections persist across modal steps.

**Testing:** selection persistence tests; first-use capture flow; validation tests.

### ATL-059 · AI request draft

**Epic:** Requests · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-058, ATL-049, ATL-052

**Objective:** Generate editable deletion/correction drafts using only fields approved in the current flow.

**Acceptance criteria**

- Draft contains approved fields only (verified against fixtures with unapproved fields present); labeled AI-assisted.
- Deletion and correction templates differ appropriately; no unsupported legal claims; no claim Atlas represents the user.
- Draft output validated against the draft schema; fallback template on AI failure.

**Testing:** field-inclusion property tests; template content tests; schema validation tests.

### ATL-060 · Draft editor

**Epic:** Requests · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-059

**Objective:** Recipient, subject, body editing with save, restore-previous, regeneration with tone instructions, and validation.

**Acceptance criteria**

- Editable while draft/ready; autosave prevents loss (NFR-02); restore-previous works after regeneration.
- Edits stored encrypted; no draft text in telemetry.

**Testing:** autosave/restore tests; regeneration flow test.

### ATL-061 · Copy email action

**Epic:** Requests · **Priority:** P0 · **Complexity:** S · **Depends on:** ATL-060

**Objective:** Copy formatted request (recipient, subject, body) with success confirmation.

**Acceptance criteria**

- Clipboard write succeeds with toast confirmation; failure shows manual-copy fallback; no analytics payload contains draft text.

**Testing:** clipboard interaction test with mocked API.

### ATL-062 · Open email client action

**Epic:** Requests · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-060

**Objective:** Safe mailto handoff with encoding and size checks.

**Acceptance criteria**

- Proper URL encoding of subject/body; total mailto length checked against the ~1,800-character safety threshold — above it, the action is disabled with an explanation steering to copy.
- No sensitive data persisted in browser history beyond the user-initiated mailto itself.

**Testing:** encoding unit tests; threshold boundary tests.

### ATL-063 · Mark request sent

**Epic:** Requests · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-057, ATL-060

**Objective:** User-confirmed sent transition recording timestamp, delivery method, and events.

**Acceptance criteria**

- Explicit confirmation required; records `sent_at` and `delivery_method`; suggests follow-up date (default 30 days, editable).
- Nothing implies Atlas sent the message.

**Testing:** confirmation flow test; event emission assertions.

### ATL-064 · Request list

**Epic:** Requests · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-057

**Objective:** Filterable request list (service, type, status, dates, follow-up) with responsive card fallback.

**Acceptance criteria**

- Columns per frontend §9; recipient shown masked; filters server-side; mobile cards preserve priority info.

**Testing:** filter tests; responsive snapshots; masked-recipient assertion.

### ATL-065 · Request detail

**Epic:** Requests · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-064, ATL-060

**Objective:** Status timeline, recipient, included fields, draft editing, actions, response notes, and history per frontend §9.

**Acceptance criteria**

- Timeline renders `request_events` including system transitions; included fields listed by key.
- Response note entry triggers `sent → awaiting_response` when applicable; all §13-legal actions available contextually.

**Testing:** timeline render tests; contextual action availability matrix.

### ATL-067 · Complete or cancel request

**Epic:** Requests · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-065

**Objective:** Completion (including rejected → completed acknowledgment) and cancellation flows with activity records.

**Acceptance criteria**

- Terminal transitions confirmed explicitly; rejected-close flow explains what completing means; events recorded.

**Testing:** transition flow tests including rejected paths.

### ATL-107 · Notifications schema and service

**Epic:** Notifications · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-015, ATL-069

**Objective:** `notifications` table (ADR-005), server-only creation API, preference checks, read-state operations, and purge job.

**Acceptance criteria**

- RLS standard pattern; creation is server-side only; content passes the redaction rules (no personal values or draft text).
- Preference checks respect Settings toggles; security type bypasses opt-out.
- Purge job removes notifications older than 90 days.

**Testing:** two-user RLS tests; redaction tests; preference-respect tests; purge test.

### ATL-108 · Notifications UI

**Epic:** Notifications · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-107, ATL-005

**Objective:** Top-bar unread badge and notifications panel per frontend §4.1.

**Acceptance criteria**

- Unread count accurate (caps at "9+"); panel lists notifications with entity links; open-marks-read plus explicit mark-all-read.
- Keyboard accessible; aria-live announcement for new notifications; empty state explains notification types.

**Testing:** read-state interaction tests; axe; badge-count tests.

### ATL-066 · Follow-up reminders

**Epic:** Requests · **Priority:** P0 (promoted from P1 — request tracking's value depends on it) · **Complexity:** L · **Depends on:** ATL-057, ATL-107

**Objective:** Follow-up due dates, the system jobs for `awaiting_response`/`follow_up_due` transitions, and reminder notifications.

**Acceptance criteria**

- `sent → awaiting_response` job (3 days) and `awaiting_response → follow_up_due` job (at `follow_up_at`) run idempotently and observably.
- Follow-up-due creates a notification linking to the request; completing/canceling clears pending reminders.
- Timezone handling: follow-up dates computed in the user's profile timezone.

**Testing:** time-simulation job tests; notification creation tests; timezone boundary test.

---

## M9 · Dashboard

### ATL-019 · Dashboard query service

**Epic:** Dashboard · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-030, ATL-039, ATL-044, ATL-057

**Objective:** Aggregated, authorized server-side dashboard query (score state, metrics, asset previews, top insights, recent activity).

**Acceptance criteria**

- Single authorized aggregate per load; no client-side stitching of protected data; invalidated after mutations.
- Returns explicit states: not-yet-scored, demo, empty collections.

**Testing:** authorization test; aggregate correctness test against fixtures; cache invalidation test.

### ATL-020 · Dashboard header

**Epic:** Dashboard · **Priority:** P0 · **Complexity:** S · **Depends on:** ATL-019

**Objective:** Personalized greeting, one-sentence status summary, and contextual primary CTA.

**Acceptance criteria**

- Status summary reflects actual state (open findings, due follow-ups, or calm all-clear); CTA targets the highest-value available action; never bare "Welcome back."

**Testing:** CTA selection unit tests across data states.

### ATL-021 · Privacy score card

**Epic:** Dashboard · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-019, ATL-046

**Objective:** Score card with numeric score, interpretation, change, and explanation entry point — including not-yet-scored and demo states per frontend §5.2.

**Acceptance criteria**

- Three states implemented (not-yet-scored, demo-labeled, scored with change and coverage note); links to score detail.
- Accessible description conveys score, change, and state without color.

**Testing:** render tests per state; axe.

### ATL-022 · Dashboard metric cards

**Epic:** Dashboard · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-019

**Objective:** Assets, open findings, and active requests cards completing the four-card row (change context inside cards; no separate recent-changes card).

**Acceptance criteria**

- Values accurate with change context line; click-through to filtered views; skeletons resemble final layout.

**Testing:** value accuracy tests; click-through tests.

### ATL-023 · Asset preview cards

**Epic:** Dashboard · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-019, ATL-031

**Objective:** Four to six asset cards with icon, category, data summary, status, last reviewed, and hover/focus/touch actions.

**Acceptance criteria**

- Actions (view, edit, archive, request deletion) reachable by hover, keyboard, and touch overflow equally.

**Testing:** input-modality parity tests; axe.

### ATL-024 · Dashboard insights

**Epic:** Dashboard · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-019, ATL-040

**Objective:** Prioritized findings list with severity, confidence, source, reason, and one primary action per item.

**Acceptance criteria**

- Ordering matches recommendation logic; dismissal offers optional reason; empty state encourages asset entry (explains findings need data).

**Testing:** ordering test; empty-state test.

### ATL-025 · Contextual Ask Atlas card

**Epic:** Dashboard · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-019 (panel via ATL-053)

**Objective:** Compact Ask Atlas card after primary insights, expanding to the assistant panel, with record-tied suggested prompts.

**Acceptance criteria**

- Never visually outweighs user data; suggestions reference current records; graceful state when AI unavailable.

**Testing:** placement snapshot; AI-unavailable render test.

### ATL-026 · Recent activity preview

**Epic:** Dashboard · **Priority:** P1 · **Complexity:** S · **Depends on:** ATL-019, ATL-069

**Objective:** Five recent redacted events with type icons, relative times, and link to full activity.

**Acceptance criteria**

- Summaries redacted; exact timestamp on demand; empty state for new accounts.

**Testing:** redaction assertion; render test.

---

## M10 · Activity, archive, search, settings

### ATL-070 · Activity page

**Epic:** Activity · **Priority:** P1 · **Complexity:** L · **Depends on:** ATL-069

**Objective:** Chronological, filterable, date-grouped, paginated timeline per frontend §13.

**Acceptance criteria**

- Filters by entity and action; cursor pagination; redacted summaries with entity links.

**Testing:** filter/pagination tests; redaction assertions.

### ATL-071 · Archive page

**Epic:** Archive · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-036, ATL-043

**Objective:** Archived assets and dismissed findings with restore and permanent-delete actions.

**Acceptance criteria**

- Restore returns items to active views; permanent delete confirms explicitly; copy distinguishes Atlas archive from external deletion.

**Testing:** restore/delete flow tests.

### ATL-072 · Global search

**Epic:** Search · **Priority:** P1 · **Complexity:** L · **Depends on:** ATL-030, ATL-039, ATL-057

**Objective:** Search assets, findings, requests, and actions over non-restricted fields only.

**Acceptance criteria**

- Encrypted/restricted fields never indexed or matched; results grouped by type with keyboard navigation; queries not logged with user identifiers.

**Testing:** restricted-field exclusion test; relevance smoke tests.

### ATL-073 · Command overlay

**Epic:** Search · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-072

**Objective:** Keyboard-accessible command palette for search and navigation.

**Acceptance criteria**

- Opens via shortcut and top bar; full keyboard operation; focus restored on close.

**Testing:** keyboard interaction tests; axe.

### ATL-074 · Profile settings

**Epic:** Settings · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-015

**Objective:** Edit display name, locale, timezone.

**Acceptance criteria**

- Validated updates; timezone changes affect follow-up computation (documented link to ATL-066).

**Testing:** update tests; timezone propagation test.

### ATL-075 · Security settings

**Epic:** Settings · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-013

**Objective:** Authentication methods, active sessions, sign-out-all controls.

**Acceptance criteria**

- Sessions listed where provider allows; revocation works and emits audit events; linked auth methods shown.

**Testing:** revocation integration test.

### ATL-076 · AI and privacy settings

**Epic:** Settings · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-078, ATL-109

**Objective:** AI disclosures, conversation-history preference, data-use choices, consent history.

**Acceptance criteria**

- History toggle consent-gated; disabling deletes conversations with confirmation; consent history renders policy versions.

**Testing:** toggle flow tests; consent history render test.

### ATL-077 · Notification settings

**Epic:** Settings · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-107

**Objective:** Per-type notification preferences.

**Acceptance criteria**

- Follow-up and finding notices default on; product updates default off; security cannot be disabled (control shown disabled with explanation).

**Testing:** preference persistence and enforcement tests.

---

## M11 · Privacy operations

### ATL-079 · Export job schema

**Epic:** Privacy · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-015

**Objective:** `export_jobs` table with RLS and status lifecycle.

**Acceptance criteria**

- Standard RLS; status transitions validated; `expires_at` mandatory.

**Testing:** two-user RLS tests; status validation tests.

### ATL-080 · Data export generator

**Epic:** Privacy · **Priority:** P0 · **Complexity:** XL · **Depends on:** ATL-079, ATL-084, ATL-104

**Objective:** Asynchronous machine-readable archive (JSON + field documentation) with signed access, 24-hour expiry, and audit logging.

**Acceptance criteria**

- Export includes all user-owned records with encrypted values decrypted for the owner, plus a README describing fields; excludes internal secrets, other users, and audit internals.
- Short-lived signed URL; download and expiry audited; job idempotent and resumable; expired archives deleted by job.

**Testing:** archive content golden test; expiry test; audit emission test; idempotency test.

### ATL-081 · Export UI

**Epic:** Privacy · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-080

**Objective:** Settings → Data export with reauthentication and job status states.

**Acceptance criteria**

- Reauthentication required before job creation and download; states: idle, generating, ready (with countdown to expiry), expired, failed.

**Testing:** reauth-gate test; state render tests.

### ATL-082 · Account deletion workflow

**Epic:** Privacy · **Priority:** P0 · **Complexity:** XL · **Depends on:** ATL-084, ATL-103, ATL-080

**Objective:** Full deletion per security §16: consequences, reauthentication, session revocation, job cancellation, DEK destruction, row and storage deletion, audit evidence, completion notice.

**Acceptance criteria**

- Steps execute in the §16 order; DEK destroyed before row deletion; every user-owned table verified empty post-deletion (automated sweep).
- Audit retains only the pseudonymous completion evidence; export jobs and notifications canceled.
- UI explains consequences and retention exceptions before confirmation.

**Testing:** end-to-end deletion test asserting emptiness per table, DEK destruction, and audit survivors; re-registration test confirms no data resurrection.

### ATL-110 · Optional TOTP MFA

**Epic:** Security · **Priority:** P1 · **Complexity:** L · **Depends on:** ATL-011, ATL-075

**Objective:** Optional authenticator-app MFA (scope addition documented in CHANGELOG — Atlas's aggregation makes accounts high-value; magic link alone leaves email as a single point of compromise).

**Acceptance criteria**

- Enrollment with QR + manual key and recovery codes; challenge on sign-in when enabled; removal requires reauthentication.
- Enrollment/removal emit audit events and security notifications.

**Testing:** enrollment/challenge/recovery flow tests; audit assertions.

---

## M12 · Quality and launch

### ATL-088 · Two-user authorization matrix

**Epic:** Security · **Priority:** P0 · **Complexity:** L · **Depends on:** all schema tickets

**Objective:** Verify cross-user denial for every user-owned table and endpoint (written incrementally per schema ticket; this ticket completes and audits the full matrix).

**Acceptance criteria**

- Matrix covers every user-owned table (select/insert/update/delete) and every endpoint/server action; internal tables verified deny-all from client roles.
- Matrix is generated from the schema list so a new table without tests fails CI.

**Testing:** the ticket is the test suite plus the completeness check.

### ATL-091 · Accessibility audit automation

**Epic:** Quality · **Priority:** P0 · **Complexity:** M · **Depends on:** major UI tickets

**Objective:** Axe-based smoke checks and keyboard-path tests across core routes in CI.

**Acceptance criteria**

- Every primary route passes axe smoke; keyboard-only completion of core journeys asserted; reduced-motion respected.

**Testing:** the ticket is the automation.

### ATL-092 · End-to-end core journey tests

**Epic:** Quality · **Priority:** P0 · **Complexity:** XL · **Depends on:** M4–M11

**Objective:** Automate: onboarding, add asset, review finding, generate/edit draft, mark sent, follow-up notification, export, account deletion.

**Acceptance criteria**

- All architecture §17 E2E journeys automated against staging-like environment, including AI-unavailable variant.

**Testing:** the ticket is the suite; flake rate <2% over 20 runs.

### ATL-093 · Performance budget

**Epic:** Quality · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-019

**Objective:** Bundle, LCP (dashboard usable ≤2.5 s), CLS, and interaction (≤100 ms feedback) budgets enforced in CI.

**Acceptance criteria**

- Budgets codified with failing thresholds; charts and assistant lazy-loaded; layout space reserved.

**Testing:** Lighthouse CI (or equivalent) assertions.

### ATL-094 · Privacy-safe analytics

**Epic:** Observability · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-085

**Objective:** Allowlisted product events per frontend §24 with no personal fields.

**Acceptance criteria**

- Only the enumerated events; payloads pass the redaction allowlist; analytics disabled variant works.

**Testing:** event payload schema tests; poisoned-payload rejection test.

### ATL-096 · Background job monitoring

**Epic:** Observability · **Priority:** P0 · **Complexity:** M · **Depends on:** job-bearing tickets

**Objective:** Track success, failure, retries, and duration for every §14 job with alerting on repeated failure.

**Acceptance criteria**

- All jobs report status; stuck/failing jobs alert; job telemetry passes redaction.

**Testing:** simulated-failure alert test.

### ATL-097 · Staging deployment

**Epic:** Deployment · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-003, ATL-004

**Objective:** Isolated staging app, database, auth, storage, and secrets with production-like configuration.

**Acceptance criteria**

- Full stack deployed; E2E suite runs against staging; no production data or keys present.

**Testing:** deployment smoke suite.

### ATL-098 · Production deployment

**Epic:** Deployment · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-097

**Objective:** Production domains, secrets, migration process, monitoring, and rollback procedure.

**Acceptance criteria**

- Documented, rehearsed rollback; migration gate in deploy pipeline; monitoring live; security headers verified in production.

**Testing:** rollback rehearsal; post-deploy smoke.

### ATL-099 · Launch security review

**Epic:** Launch · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-088, ATL-089, ATL-090, ATL-098

**Objective:** Complete the security §21 checklist, threat-model review, and unresolved-risk sign-off.

**Acceptance criteria**

- Every checklist item verified with evidence links; T1–T8 controls confirmed implemented; residual risks documented and signed off.

**Testing:** checklist evidence review.

### ATL-100 · Launch readiness review

**Epic:** Launch · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-099, ATL-092, ATL-091

**Objective:** Verify P0 completion, accessibility audit, legal/privacy copy, demo labeling, monitoring, exports, deletion, and AI fallbacks.

**Acceptance criteria**

- PRD §14 launch criteria all pass with evidence; open-questions.md reviewed — no unresolved launch-blocking decisions.

**Testing:** criteria evidence review.
