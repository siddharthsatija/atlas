# Atlas Feature Ticket Backlog

## Conventions

- **P0:** required before MVP launch. **P1:** targeted for MVP if schedule allows.
- **S/M/L/XL:** relative complexity, not time commitments.
- Tickets are listed in **implementation order**, grouped into milestones M0–M13. A ticket's dependencies must be complete (or explicitly stubbed) before it starts.
- Security and privacy acceptance criteria apply to every ticket even when not repeated: authorization verified server-side, inputs validated with Zod, no restricted data in logs/analytics, RLS on any new user-owned table with two-user tests.
- UI tickets always cover loading, empty, error, success, keyboard, and responsive states.
- References: ADR-001…008 in `docs/adr/`, architecture (02), security (03), frontend (04).

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
| M6        | Findings and score                       | 038, 101, 102, 039, 040, 041, 042, 043, 213, 044, 045, 046, 047                |
| M7        | AI subsystem                             | 048, 050, 051, 049, 052, 055, 053, 054, 109, 089                               |
| M8        | Requests, personal fields, notifications | 105, 106, 056, 057, 058, 059, 060, 061, 062, 063, 064, 065, 067, 107, 108, 066 |
| M9        | Dashboard                                | 019, 020, 021, 022, 023, 024, 025, 026                                         |
| M10       | Activity, archive, search, settings      | 070, 071, 072, 073, 074, 075, 076, 077                                         |
| M11       | Privacy operations                       | 079, 080, 081, 082, 110                                                        |
| M12       | Quality and launch                       | 088, 091, 092, 093, 094, 096, 097, 098, 099, 100                               |
| M13       | Discovery                                | 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 214          |

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

**Objective:** Build the onboarding shell and implement the discovery-independent steps per PRD §9.1: purpose/limitations disclosure (step 2) and privacy goal selection (step 3), including AI-processing consent capture. The shell provides the step container, progress indicator, back/skip controls, and routing infrastructure; it is designed as an extensible framework so that M13 tickets (ATL-209 Identity Profile, ATL-210 discovery consent, ATL-211 candidate adjudication) install additional steps without restructuring the shell. The full discovery-first onboarding journey (PRD §9.1 steps 1–9) becomes operational once ATL-211 completes. The demo path (ATL-018) is routed from this shell; the consent step that triggers the branch is ATL-210's responsibility.

**Acceptance criteria**

- Shell renders the pre-discovery steps (purpose/limitations, privacy goal) with a progress indicator, back navigation, and safe skip; step order is defined in the shell so M13 tickets can extend it.
- `ai_processing` consent captured with policy version before any AI feature is usable.
- Limitations copy states what Atlas does not do (no scanning, no guaranteed deletion).
- The shell defines a routing slot at the discovery-consent step: users who decline are routed to demo mode (ATL-018, which must be complete before this ticket can be E2E-tested for that branch); users who proceed advance into the discovery steps installed by ATL-210/ATL-211.
- Manual asset addition is not offered as an onboarding path; it is available as a fallback throughout the product for discovery misses after onboarding completes.
- `onboarding_completed_at` is set by the shell after the user has completed all installed onboarding steps at the time of completion. This is an incremental-development convenience: at M4 only the pre-discovery steps are installed, so the flag may be set without discovery completion. Once ATL-209–ATL-211 are deployed (M13), the shell routing logic must evaluate outstanding steps against all installed steps — not only against this flag — so that any user who lacks a complete Identity Profile (at least one field with `include_in_discovery = true`) or has no active discovery consent is routed through those steps before reaching the Dashboard, regardless of whether the flag is already set. The flag alone is never a sufficient bypass condition once discovery steps are installed.

**Testing:** Shell renders pre-discovery steps with correct navigation controls; `ai_processing` consent row asserted; demo-branch routing slot verified; axe checks per step.

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

- Optional reason captured (`not_relevant` or `accepted_risk`); undo restores open state. `incorrect` is not a dismissal reason — it routes the user to the underlying record for data correction (see ATL-213).
- Dismissal does not improve the score (deduction retained until condition clears); UI explains this honestly.

**Testing:** dismiss/undo tests; score-unchanged assertion; confirm `incorrect` is not offered as a dismiss option.

### ATL-213 · Incorrect-finding correction path

**Epic:** Findings · **Priority:** P1 · **Complexity:** M · **Depends on:** ATL-043, ATL-041, ATL-102

**Objective:** Implement the `incorrect` correction flow per OQ-04: when a user disputes a finding as incorrect, navigate them to the underlying record that generated the finding, let them correct the data, and allow ATL-102 auto-resolution to clear the finding if the corrected data satisfies the predicate.

**Acceptance criteria**

- A distinct "Incorrect — correct the underlying data" affordance is present on the finding card or detail panel (separate from the Dismiss action, which offers only `not_relevant` and `accepted_risk`).
- Selecting it navigates the user to the relevant underlying record (digital asset detail, personal field, or permission record — whichever the finding's `rule_id` evaluates against).
- No deduction is removed by this action alone; the score changes only if the corrected data causes ATL-102 to auto-resolve the finding with `resolved_by = system`.
- Until the user corrects the data, the finding remains open and the deduction stands (option (a) behavior per OQ-04).
- The correction affordance is distinct in labeling from `accepted_risk` and `not_relevant`; copy makes clear that only fixing the data will clear the finding.

**Testing:** correction affordance navigates to correct record; no score change from navigation alone; score changes after data correction that clears the predicate; finding stays open when corrected data does not clear the predicate.

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

### ATL-114 · Timeline keyset pagination as a true index seek

**Epic:** Activity · **Priority:** P2 · **Complexity:** M · **Depends on:** ATL-068, ATL-070

**Objective:** Replace the disjunctive cursor predicate in `ActivityEventRepository.timeline` with a row comparison, so the cursor becomes an index seek instead of a filter. Requires a SQL function, because PostgREST cannot express a row comparison.

**Why this is not a one-line query change**

`activity-event-repository.ts:146` sends the cursor as `or(occurred_at.lt.X, and(occurred_at.eq.X, id.lt.Y))`. That is a disjunction, and `A OR B` is not a range, so PostgreSQL cannot use it as a btree boundary. Two consequences, both measured on PostgreSQL 17.10 against `activity_events_timeline_idx (user_id, occurred_at desc, id desc)`:

1. **The plan shape is cost-dependent, not determined.** PostgreSQL may pick an ordered Index Scan with `Index Cond: (user_id = $1)` and the disjunction as a `Filter`, or a `BitmapOr` of the two disjuncts followed by `Bitmap Heap Scan` and an explicit `Sort` — the bitmap returns rows in heap order, so the ordering has to be recomputed. Identical 12,000-row tables chose the ordered scan at 12 users x 1000 rows and the bitmap at 40 users x 300 rows. The flip is driven by the planner's estimate of how many rows the filter rejects, and that estimate is wrong by construction: a cursor is perfectly correlated with the sort order, and PostgreSQL has no way to represent that correlation.
2. **Even the good plan is O(offset).** With the cursor as a `Filter` rather than an `Index Cond`, the scan starts at the newest row every time and discards everything above the cursor. At page 1,000 that walks ~50,000 index entries to return 50.

**The fix**

`(occurred_at, id) < ($2, $3)` is lexicographic and exactly equivalent to the disjunction. Both columns are `NOT NULL`, so row-comparison NULL semantics do not diverge, and both index columns are already `desc`, so the comparison is seekable as written. PostgreSQL compiles it to:

```
Index Cond: ((user_id = $1) AND (ROW(occurred_at, id) < ROW($2, $3)))
```

A single range qual — no disjunction, therefore no `BitmapOr` candidate, therefore no `Sort` possible, and the scan starts at the cursor. **The index needs no change; only the query does.**

**Acceptance criteria**

- New migration adds `public.activity_timeline(...)` as `SECURITY INVOKER`, so the RLS posture is unchanged; ownership stays filtered explicitly inside the function, matching today's service-role read path.
- `timeline()` calls it via `.rpc()` and preserves the existing `ActivityPage` contract, including the limit+1 probe and `nextCursor`.
- The `EXPLAIN` assertion in `tests/integration/activity-events-rls.test.ts` is restored to forbid `Sort` and tightened to require the row comparison inside `Index Cond` — a structural guarantee rather than a cost-dependent one.
- Decide whether `forEntity` and the `eventType`-filtered path move behind the same function; they have the same shape.

**Two comments this ticket must correct, which currently overstate the guarantee**

- `activity-event-repository.ts:119` — "The ordering matches `activity_events_timeline_idx` exactly, so this reads the index rather than sorting." True without a cursor; not guaranteed with one.
- `supabase/migrations/20260805090000_create_activity_events.sql:101` — "Including `id` makes a filtered timeline a pure index scan." True of the `event_type` equality filter it describes; not true of the cursor.

**Interim state on the current branch:** the keyset test asserts that the timeline index is the access path (structural under either shape) plus that the keyset page equals the offset-addressed page it stands in for (behavioural, deterministic). It does not assert the absence of `Sort`, because the current SQL cannot guarantee it. The two non-cursor cases still forbid `Sort` and are unchanged.

**Testing:** plan assertion on `Index Cond`; keyset/offset page-equality across a page boundary with tied `occurred_at`; two-user RLS unchanged.

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

**Objective:** Automate the core E2E journeys available through M11: onboarding shell (pre-discovery steps and demo path), digital asset management (manual entry as the fallback path available at this stage), review finding, generate/edit request draft, mark sent, follow-up notification, data export, and account deletion. The discovery-first primary onboarding journey (Identity Profile, consent, discovery run, adjudication) requires M13 capabilities and is covered by ATL-214 after ATL-211 completes.

**Acceptance criteria**

- All M4–M11 E2E journeys automated against a staging-like environment; includes AI-unavailable variant and demo path.

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
---

## M13 · Discovery

### ATL-200 · Discovery schema foundation

**Epic:** Discovery · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-027, ATL-038, ATL-078, ATL-085, ATL-105

**Objective:** Prepare existing tables for the discovery feature set. This is the only migration that touches tables owned by prior milestones; all new discovery tables are added by ATL-201 and ATL-202.

Changes:
- `digital_assets`: add `'discovery'` to `source_type` check constraint; add nullable `candidate_id uuid` column with a forward-reference FK to `discovery_candidates (id)` (deferred foreign key, or added after ATL-202 via a separate ALTER); add `deleted_at timestamptz` for soft-deletion in the de-confirmation flow (ADR-007 §9); add conditional pairing check constraint — `(source_type = 'discovery' AND candidate_id IS NOT NULL) OR (source_type != 'discovery' AND candidate_id IS NULL)`.
- `privacy_findings`: add `'discovery'` to `source_type` check constraint; add the C1-D enforcement constraint: `CHECK (source_type != 'discovery' OR asset_id IS NOT NULL)` — a discovery-source finding without a confirmed asset is rejected at the DB layer (ADR-007 §7); add a check constraint on `evidence_refs_json` enforcing the typed-entry closed vocabulary for discovery-source findings only (source-type-scoped; non-discovery rows are unconstrained and retain their existing `'{}'` default). For `source_type = 'discovery'`: `evidence_refs_json` must be a JSONB array (`jsonb_typeof = 'array'`) with at least one element (`jsonb_array_length >= 1`); every element must have a non-null `type` within the closed ADR-007 vocabulary (`discovery_evidence`, `digital_asset`) and a non-null `id`. The check expression uses a CASE guard that short-circuits on non-discovery rows, non-array values, and empty arrays before the element scan; the ELSE branch uses `NOT jsonb_path_exists(evidence_refs_json, '$[*] ? (!exists(@.type) || @.type == null || (@.type != "discovery_evidence" && @.type != "digital_asset") || !exists(@.id) || @.id == null)')` (a scalar expression; PostgreSQL CHECK constraints do not permit subqueries, so `NOT EXISTS ... jsonb_array_elements` cannot be used here).
- `user_encryption_keys`: add `key_purpose text NOT NULL DEFAULT 'content'`; update the partial unique index from `(user_id) WHERE status = 'active'` to `(user_id, key_purpose) WHERE status = 'active'`, allowing one active key per `(user_id, key_purpose)` pair.
- `user_personal_fields`: rename `use_for_discovery` column to `include_in_discovery` (or add it as a new `boolean NOT NULL DEFAULT false` column if ATL-105 did not add the discovery column); update the column comment to reflect preference semantics.
- `consents`: add `'discovery_hashed_query'`, `'discovery_identifying'`, and `'discovery_connected_sources'` to the `consent_type` check constraint (ADR-007 schema adaptations; ADR-008 §12).

**Acceptance criteria**

- All five table changes applied; existing rows unaffected (append-only ALTERs, no destructive changes).
- `digital_assets`: `source_type = 'discovery'` accepted; conditional pairing constraint rejects a discovery row with `candidate_id IS NULL` and a non-discovery row with `candidate_id IS NOT NULL`; `deleted_at` column present and nullable.
- `privacy_findings`: `source_type = 'discovery'` accepted; C1-D constraint rejects `(source_type = 'discovery', asset_id = NULL)`; non-discovery rows with `asset_id = NULL` continue to be accepted; `evidence_refs_json` constraint: valid populated discovery array accepted; empty discovery array `'[]'` rejected; `'{}'` (object) on a discovery finding rejected; unsupported reference type rejected; element with null `type` rejected; element with null `id` rejected; non-discovery row with existing `'{}'` default accepted.
- `user_encryption_keys`: two active rows with `key_purpose = 'content'` and `key_purpose = 'rejection'` coexist for the same user; two active rows with the same `key_purpose` are rejected.
- `user_personal_fields`: `include_in_discovery` column present with default `false`.
- `consents`: all three new `consent_type` values accepted; existing `consent_type` values unaffected.
- Migration applies cleanly on a local Supabase instance with existing demo data.
- Two-user RLS behavior on `digital_assets`, `privacy_findings`, `user_personal_fields`, and `consents` is unchanged by this migration.

**Testing:** Constraint acceptance/rejection tests for every new constraint; `user_encryption_keys` uniqueness matrix; `source_type` and `consent_type` enum extension; existing-row safety check on a seeded dataset.

---

### ATL-201 · Discovery runs and invocations schema

**Epic:** Discovery · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-200, ATL-078

**Objective:** Create the tables that track the lifecycle of a discovery run and the outbound provider calls it generates: `discovery_runs`, `discovery_provider_invocations`, and `discovery_provider_invocation_fields` (ADR-007 §5, ADR-008 §5).

**Acceptance criteria**

- `discovery_runs`: `id uuid PK`, `user_id` (→ `auth.users`), `run_status text NOT NULL DEFAULT 'pending'` check `('pending', 'running', 'completed', 'partial', 'blocked', 'failed')`, `triggered_by text NOT NULL` check `('user', 'scheduled', 'profile_change')`, `started_at timestamptz`, `completed_at timestamptz`, `created_at timestamptz NOT NULL DEFAULT now()`. `UNIQUE (user_id, id)` required for the composite FK used by `discovery_provider_invocations`.
- `discovery_provider_invocations`: `id uuid PK`, `run_id uuid NOT NULL`, `user_id uuid NOT NULL`, `provider_class text NOT NULL`, `invocation_status text` (nullable; terminal values only: `success`, `blocked`, `error`, `rate_limited`; ADR-008 §10), `consent_proof_issued_at timestamptz` (from the ConsentProof for this invocation; ADR-008 §10), `started_at timestamptz`, `completed_at timestamptz`, `error_code text`, `created_at timestamptz NOT NULL DEFAULT now()`. Composite FK `FOREIGN KEY (user_id, run_id) REFERENCES discovery_runs (user_id, id)`. Three lifecycle check constraints: (1) terminal `invocation_status` requires non-null `completed_at`; (2) non-null `completed_at` requires terminal `invocation_status`; (3) non-null `completed_at` requires non-null `started_at`. `UNIQUE (user_id, id)` for downstream composite FKs.
- `discovery_provider_invocation_fields`: `id uuid PK`, `user_id uuid NOT NULL`, `invocation_id uuid NOT NULL`, `field_id uuid NOT NULL` (→ `user_personal_fields`), `field_type text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`. Cross-user composite ownership constraints: `FOREIGN KEY (user_id, invocation_id) REFERENCES discovery_provider_invocations (user_id, id)` and `FOREIGN KEY (user_id, field_id) REFERENCES user_personal_fields (user_id, id)` (ADR-008 §10). The `user_personal_fields` FK requires `UNIQUE (user_id, id)` on `user_personal_fields`. The current `user_personal_fields` schema (ATL-105 migration) does not contain this constraint; ATL-201 owns adding it as a prerequisite step before creating the `discovery_provider_invocation_fields` composite FK. To keep the migration safe if a subsequent migration introduces the constraint before ATL-201 executes, add it conditionally (e.g. a `DO $$ BEGIN IF NOT EXISTS ... END IF; END $$` guard or equivalent `ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS` form if the target PostgreSQL version supports it). Field-set uniqueness: `UNIQUE (user_id, invocation_id, field_id)`. This is the mapping table that decouples the number of authorized fields from the number of invocations (ADR-008 §5.1). Zero rows for an invocation is a valid pre-dispatch state; the dispatch engine treats it as the empty-mapping fail-closed condition.
- RLS on all three tables: `authenticated` may select own rows; no client insert, update, or delete policies. `service_role` granted all privileges.
- Partial index on `discovery_runs (user_id, created_at DESC)` for run history queries.

**Testing:** `UNIQUE (user_id, id)` on both `discovery_runs` and `discovery_provider_invocations`; all three lifecycle check constraints reject the three prohibited states; `discovery_provider_invocation_fields` uniqueness; two-user RLS on all three tables.

---

### ATL-202 · Discovery evidence, candidates, and rejections schema

**Epic:** Discovery · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-201, ATL-027

**Objective:** Create the tables that hold discovery results and permanent suppression records: `discovery_evidence`, `discovery_candidates`, and `discovery_rejections` (ADR-007 §6, §7, §8).

**Acceptance criteria**

- `discovery_evidence`: `id uuid PK`, `user_id`, `invocation_id` (→ `discovery_provider_invocations`), `provider_class text NOT NULL`, `is_aggregator_attributed boolean NOT NULL DEFAULT false`, `evidence_type text NOT NULL`, `evidence_summary text NOT NULL`, `provider_evidence_json text` (AES-256-GCM, per-user DEK, AAD = `discovery_evidence.provider_evidence_json:<record_uuid>`; ADR-003, ADR-008 §7; nullable if no raw payload applies), `created_at timestamptz NOT NULL DEFAULT now()`. `UNIQUE (user_id, id)` for downstream composite FKs.
- `discovery_candidates`: `id uuid PK`, `user_id`, `evidence_id` (→ `discovery_evidence`), `status text NOT NULL DEFAULT 'pending'` check `('pending', 'confirmed', 'rejected', 'dismissed', 'not_sure')`, `asset_id uuid` (nullable; populated on confirm; composite FK `FOREIGN KEY (user_id, asset_id) REFERENCES digital_assets (user_id, id)` via the existing `UNIQUE (user_id, id)` on `digital_assets` from ATL-028), `adjudicated_at timestamptz`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`. No `service_name` or `service_domain` columns — those are derived at read time from the linked `digital_asset` (on confirm) or from `discovery_evidence` (before confirm). Partial unique index on `(user_id, evidence_id) WHERE status = 'pending'` — one pending candidate per evidence record per user.
- `discovery_rejections`: `id uuid PK`, `user_id`, `fingerprint text NOT NULL` (HMAC format: `{"v":1,"alg":"hmac-sha256","value":"<base64url>"}`, ADR-008 §8; stored as text, not AES-encrypted), `provider_class text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`. Unique on `(user_id, fingerprint)`. Rejection fingerprints are permanent until account deletion.
- RLS on all three tables: `authenticated` may select own rows; no client write policies. `service_role` all privileges.
- `digital_assets.candidate_id` FK (added by ATL-200) is now satisfiable: add a real FK constraint `digital_assets.candidate_id REFERENCES discovery_candidates (id)` (deferred or in a new migration after this ticket).

**Testing:** `discovery_candidates` composite FK to `digital_assets`; pending-candidate partial unique index; `discovery_rejections` fingerprint uniqueness; `is_aggregator_attributed` flag accepted; two-user RLS on all three tables.

---

### ATL-203 · Rejection key service

**Epic:** Discovery · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-200, ATL-103

**Objective:** Extend the key management infrastructure to create and retrieve a per-user rejection key, stored in `user_encryption_keys` under `key_purpose = 'rejection'` (ATL-200). The rejection key is used exclusively for HMAC-SHA256 operations on rejection fingerprints (ADR-008 §8). It must never be used as an AES-GCM key.

**Acceptance criteria**

- `RejectionKeyService.getOrCreate(userId)` creates the rejection key on first call (lazy, race-safe using the same upsert pattern as the content DEK). Stores in `user_encryption_keys` with `key_purpose = 'rejection'`; the wrapped key material uses the atlas envelope format (`atlas.v1.<nonce_b64url>.<ciphertext+tag_b64url>`) with AAD `user_encryption_keys.wrapped_key:<row_id>` (ADR-003).
- `getRejectionKey(userId)` unwraps and returns key material for HMAC operations. Return type is a branded TypeScript type (`RejectionKey`) that is not assignable to the AES content-key type — prevents misuse at the type layer.
- Race-safe: concurrent first-write resolves to one winner via upsert `ON CONFLICT DO NOTHING` + re-select.
- Account deletion (ATL-082): `destroyAllForUser` covers the rejection key. Add ATL-082 as a dependency for this ticket to ensure the deletion path is updated.
- The rejection key value never appears in logs, structured or otherwise.
- **Purpose-aware key lookup prerequisite (must be resolved before any `key_purpose = 'rejection'` row is persisted):** ATL-200 changes `user_encryption_keys` active-key uniqueness from `(user_id) WHERE status = 'active'` to `(user_id, key_purpose) WHERE status = 'active'`. The existing content-encryption path (`EncryptionService`, `EncryptionKeyRepository`) selects the active key with a purpose-blind `rows.find(r => r.status === 'active')` — safe only while every user has at most one active key. This ticket's introduction of `key_purpose = 'rejection'` rows ends that assumption. Before any `key_purpose = 'rejection'` row is persisted: (1) content encryption and decryption must filter the active-key query to `key_purpose = 'content'`; (2) rejection-key retrieval must filter to `key_purpose = 'rejection'`; (3) no repository or service method may use a purpose-blind active-key lookup once multiple key purposes exist for a user. Account deletion (`destroyAllForUser`) is deliberately purpose-agnostic and must remain so — it must destroy all `user_encryption_keys` rows for the user regardless of `key_purpose`.

**Testing:** lazy creation (first call creates, second returns same key); concurrent-creation race produces exactly one row; round-trip HMAC verify; branded-type compile-time rejection of AES misuse; rejection key destroyed on account deletion; purpose-isolation regression — when a user holds both an active `key_purpose = 'content'` row and an active `key_purpose = 'rejection'` row, content encrypt/decrypt uses only the content key and rejection-fingerprint operations use only the rejection key, with neither selection depending on database row insertion order.

---

### ATL-204 · Identity Profile service layer

**Epic:** Discovery · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-200, ATL-105, ATL-103

**Objective:** Extend the existing personal fields service to expose `include_in_discovery` management: the preference that gates whether a stored field is eligible to be offered to discovery providers. The underlying table is `user_personal_fields` (ATL-105). This ticket adds the discovery-aware methods without duplicating the existing CRUD operations.

**Acceptance criteria**

- `PersonalFieldService.setIncludeInDiscovery(userId, fieldId, enabled)`: toggles the `include_in_discovery` preference; verifies ownership (non-oracle pattern); emits an activity event. Does not modify the encrypted field value.
- `PersonalFieldService.getDiscoveryEligibleFields(userId)`: returns the decrypted field values and types for all `user_personal_fields` rows where `include_in_discovery = true`; used by the consent service and dispatch engine. Returns only own fields; cross-user call returns empty (non-oracle).
- `PersonalFieldService.removeField(userId, fieldId)`: hard delete (the field must not contribute to future discovery runs); if any in-progress `discovery_provider_invocation_fields` rows reference the field, the method must block the delete and return a structured error directing the caller to wait for the run to complete. Document this behavior in the service JSDoc.
- All existing `PersonalFieldService` operations (add, get, list, update) are unchanged and their tests continue to pass.

**Testing:** `setIncludeInDiscovery` toggle; `getDiscoveryEligibleFields` returns only `include_in_discovery = true` rows; cross-user denial on all new methods; `removeField` with active invocation reference blocks; activity events emitted.

---

### ATL-205 · Discovery consent service and ConsentProof

**Epic:** Discovery · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-201, ATL-204, ATL-078

**Objective:** Implement `DiscoveryConsentService` to grant and revoke consent per provider class, record and query first-disclosure acknowledgments, and produce a `ConsentProof` token that authorizes a single provider invocation (ADR-008 §2, §3, §4).

**Acceptance criteria**

- `grantConsent(userId, providerClass, consentType)`: writes to `discovery_runs`-adjacent consent tracking (a `discovery_consents` table, created as part of ATL-201 or this ticket — see note below); emits `discovery.consent.granted` audit event to `activity_events`.
- `revokeConsent(userId, providerClass)`: records revocation; emits `discovery.consent.revoked` audit event. Does not retroactively block in-flight invocations that already passed the dispatch check.
- `recordFirstDisclosureAcknowledgment(userId, fieldId, providerClass, contractVersion)`: writes the acknowledgment record; emits `discovery.disclosure.acknowledged` audit event. Idempotent on same `(userId, fieldId, providerClass, contractVersion)`.
- `hasActiveConsent(userId, providerClass)`: live query (not cached); used as dispatch check 5 in ATL-206.
- `issueConsentProof(userId, runId, invocationId, providerClass, authorizedFieldIds)`: returns a `ConsentProof` value. `ConsentProof` has an unexported constructor — only `DiscoveryConsentService` may instantiate it. Fields: `user_id`, `consent_type`, `provider_class`, `authorized_field_ids`, `issued_at`, `discovery_run_id`, `invocation_id` (7 fields, ADR-008 §4). `ConsentProof` is an in-process value; it does not cross a network boundary.
- **Note on `discovery_consents` table:** If not included in ATL-201, add it here: `id`, `user_id`, `provider_class`, `consent_type`, `granted_at`, `revoked_at` (nullable); `UNIQUE (user_id, provider_class) WHERE revoked_at IS NULL`.
- All six discovery audit event classes (ADR-008 §11) must be wired: `discovery.consent.granted`, `discovery.consent.revoked`, `discovery.disclosure.acknowledged`, `discovery.provider.invoked` (ATL-206), `discovery.candidate.adjudicated` (ATL-208), `discovery.candidate.deconfirmed` (ATL-208). This ticket wires the first three; ATL-206 and ATL-208 wire the remaining three.

**Testing:** `ConsentProof` unexported-constructor enforcement at compile time; all 7 ConsentProof fields present; consent grant/revoke lifecycle; duplicate acknowledgment is idempotent; `hasActiveConsent` returns false after revoke; audit events for all three consent-related classes.

---

### ATL-206 · Provider dispatch engine

**Epic:** Discovery · **Priority:** P0 · **Complexity:** XL · **Depends on:** ATL-201, ATL-205

**Objective:** Implement the provider dispatch engine: the 8-check `ConsentProof` validation sequence (ADR-008 §4), invocation lifecycle management, and the empty-mapping fail-closed rule. This ticket is the enforcement point for the outbound disclosure boundary.

**Acceptance criteria**

- `DispatchEngine.dispatch(consentProof, invocationId, providerAdapter)` runs all 8 checks before any provider is called:
  1. `consentProof.discovery_run_id` matches the `run_id` on the `discovery_provider_invocations` row.
  2. `consentProof.invocation_id` matches `invocationId`.
  3. `consentProof.provider_class` matches the invocation row's `provider_class`.
  4. `consentProof.consent_type` matches the active consent for that provider class.
  5. Live consent query: `hasActiveConsent(userId, providerClass)` returns true at dispatch time.
  6. Load `discovery_provider_invocation_fields` rows for `invocationId`: (a) if zero rows, set `invocation_status = 'blocked'` and return immediately — no provider call; (b) assert every `field_id` in the mapping is present in `consentProof.authorized_field_ids`.
  7. Per-field eligibility: each mapped field must have `include_in_discovery = true` on its `user_personal_fields` row, and the field's `field_type` must be eligible for the invocation's `provider_class`.
  8. First-disclosure acknowledgment: for identifying providers, a `discovery_first_disclosure_acknowledgments` row must exist for each `(user_id, field_id, provider_class)`. The `discovery_hashed_query` provider class (HIBP) is exempt from this check (ADR-008 §3).
- Any failed check (1–8) sets `invocation_status = 'blocked'` and records the blocking reason in a structured log field. No provider HTTP call is made on a block.
- On all 8 checks passing: call `providerAdapter.query(...)`, write results, and set `invocation_status` to the appropriate terminal value in a single write. `invocation_status` is set exactly once; it is not overwritten after being set.
- Structured log fields use operation names matching `^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$` (no underscores). No restricted field values (plaintext email, field values) appear in log output.
- Emits `discovery.provider.invoked` audit event on terminal status (success or blocked or error).

**Testing:** each of the 8 checks, individually, blocks and logs correctly when violated; empty-mapping blocks before provider call; HIBP exempt from check 8; successful dispatch reaches the provider adapter; `invocation_status` set exactly once and not overwritten; log fields contain no restricted values.

---

### ATL-207 · HIBP discovery provider adapter

**Epic:** Discovery · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-202, ATL-203, ATL-206

**Objective:** Implement the HIBP Have I Been Pwned adapter for the `discovery_hashed_query` provider class (ADR-008 §1). The adapter transmits a 6-character hex SHA-1 prefix — never the plaintext email — and processes the k-anonymity response to produce evidence and candidate records.

**Acceptance criteria**

- `HibpAdapter.query(userId, emailField)`: computes `SHA-1(email.trim().toLowerCase()).slice(0, 6)` (6 hex characters; ADR-008 §1 and ADR-007 Consequences — note: the HIBP Pwned Passwords API uses 5 characters; this is the breached-account range endpoint, which uses 6), calls the HIBP range endpoint, and parses the breach list from the response.
- For each breach in the response:
  - If `IsSpamList = true`: create a `discovery_evidence` row with `is_aggregator_attributed = false`; do **not** create a `discovery_candidates` row and do **not** check the rejection fingerprint (ADR-007 §12, non-service-corpus gate).
  - If `IsSpamList = false`: create a `discovery_evidence` row with `is_aggregator_attributed = false`; check the rejection fingerprint before creating a candidate (see next point).
- Rejection fingerprint check (before any non-aggregator candidate creation): compute `HMAC-SHA256(rejectionKey, 'discovery_hashed_query' + "\x00" + breachName.trim().toLowerCase())`; encode as `{"v":1,"alg":"hmac-sha256","value":"<base64url>"}` (ADR-008 §8); query `discovery_rejections` for `(user_id, fingerprint)`. If found, skip candidate creation. The rejection key comes from `RejectionKeyService` (ATL-203).
- The plaintext email address must not appear in `evidence_summary`, `source_reference`, any log field, or any column other than the encrypted `provider_evidence_json` (if populated; AAD = `discovery_evidence.provider_evidence_json:<record_uuid>`, ADR-008 §7) and the in-memory computation.
- Rate-limit response from HIBP: set `invocation_status = 'rate_limited'`. Network or parse error: set `invocation_status = 'error'`. Both paths skip candidate and evidence creation for the failed request.
- Emits `discovery.provider.invoked` audit event (via the dispatch engine, ATL-206).

**Testing:** SHA-1 prefix is exactly 6 hex characters; spam-list breach (IsSpamList=true) creates evidence only; service-corpus breach (IsSpamList=false) creates evidence + candidate; rejection fingerprint match suppresses candidate; plaintext email absent from all non-encrypted outputs; rate-limit and network-error paths set the correct terminal status.

---

### ATL-208 · Candidate adjudication service

**Epic:** Discovery · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-202, ATL-203, ATL-207

**Objective:** Implement `CandidateAdjudicationService` for the four adjudication outcomes (Confirm, Reject, Dismiss, Not sure) and the atomic de-confirmation operation (ADR-007 §7, §9).

**Acceptance criteria**

- `confirm(userId, candidateId)`: sets `discovery_candidates.status = 'confirmed'`; creates a `digital_assets` row with `source_type = 'discovery'` and `candidate_id` back-linked; sets `discovery_candidates.asset_id`; emits `discovery.candidate.adjudicated` (outcome: `confirmed`) audit event. The findings pipeline may run against the new asset immediately after commit.
- `reject(userId, candidateId)`: sets `discovery_candidates.status = 'rejected'`; computes the HMAC rejection fingerprint using `RejectionKeyService` (ATL-203) and writes to `discovery_rejections`; emits `discovery.candidate.adjudicated` (outcome: `rejected`) audit event.
- `dismiss(userId, candidateId)`: sets `discovery_candidates.status = 'dismissed'`; no fingerprint written; emits `discovery.candidate.adjudicated` (outcome: `dismissed`) audit event.
- `markNotSure(userId, candidateId)`: sets `discovery_candidates.status = 'not_sure'`; no fingerprint written; emits `discovery.candidate.adjudicated` (outcome: `not_sure`) audit event. `not_sure` rate is a provider-quality signal and should be surfaced in monitoring (ADR-007 §7).
- `deconfirm(userId, assetId)`: atomic transaction executing steps in ADR-007 §9 order: (1) resolve all open `privacy_findings` against the asset with `resolved_by = 'system'` and a structured `source_reference` of `asset_deconfirmed`; (2) soft-delete the `digital_assets` row by setting `deleted_at = now()` (the row is retained for audit; it does not cascade-delete the candidate or evidence); (3) move the originating `discovery_candidates` row to `status = 'rejected'`; (4) write a rejection fingerprint to `discovery_rejections`. Emits `discovery.candidate.deconfirmed` audit event. Not available on manually-added assets (`source_type != 'discovery'` returns a structured NOT_FOUND error).
- All operations verify ownership using the non-oracle pattern (cross-user call returns NOT_FOUND, indistinguishable from a missing record).

**Testing:** all four adjudication outcomes; `confirm` creates a `digital_assets` row with correct columns; `reject` writes fingerprint; `deconfirm` executes steps in ADR-007 §9 order (assert transaction atomicity); `deconfirm` on a manual asset returns NOT_FOUND; cross-user denial on all operations; C1-D DB constraint does not fire on a valid `confirm` call.

---

### ATL-209 · Identity Profile UI and settings

**Epic:** Discovery · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-204, ATL-016, ATL-075

**Objective:** Expose `user_personal_fields` as the Identity Profile in onboarding and in Settings > Identity Profile (FR-15): add/view/delete identity fields, toggle `include_in_discovery` per field, display masked values by default.

**Acceptance criteria**

- Onboarding step: user can add at least one email address; name, phone, location, and usernames are optional. Each field shows its current `include_in_discovery` state. User can enable or disable discovery per field. At least one email with `include_in_discovery = true` is required before the discovery run step (soft enforcement with a visible prompt, not a hard block).
- Settings > Identity Profile: same add/edit/delete capabilities as onboarding, plus bulk view and per-field deletion with a confirmation step. Fields masked by default; reveal is an explicit action.
- `include_in_discovery` toggle is labeled clearly (e.g. "Use for discovery") and accompanied by a one-line explanation of what it enables.
- Deleting a field that is currently in an active discovery invocation shows a warning explaining why the delete is blocked (from `PersonalFieldService.removeField`, ATL-204).
- No plaintext field value appears in a page title, URL, breadcrumb, log, or analytics event.
- All states handled: loading, empty (no fields yet), error, keyboard-only, responsive.
- Upgrade-onboarding path: if a user arrives at the Identity Profile step with `onboarding_completed_at` already set (completed onboarding before M13 deployed), the Identity Profile step is presented as an upgrade flow and not skipped. The ATL-016 shell routing enforces completion of this step and the downstream ATL-210/ATL-211 steps before the user is admitted to the Dashboard on that session; the presence of `onboarding_completed_at` alone does not bypass this requirement.

**Testing:** add/toggle/delete field end to end; `include_in_discovery` toggle reflected in service layer; mask/reveal; field-in-use delete blocked; keyboard-only flow; no sensitive value in URLs or page titles; upgrade-onboarding path routes a pre-M13 user through Identity Profile before Dashboard.

---

### ATL-210 · Discovery consent and disclosure UI

**Epic:** Discovery · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-205, ATL-209

**Objective:** Build the consent grant and first-disclosure acknowledgment flows in onboarding and in Settings > Discovery (FR-16, FR-02): display the three distinct disclosure-type notices, gate discovery start on active consent, and surface consent management in settings.

**Acceptance criteria**

- Onboarding — hashed-query consent (HIBP): the notice explains that a partial hash derived from the email address (not the plaintext email) is transmitted; no per-field acknowledgment dialog is presented for this provider class (ADR-008 §3); a single consent-grant confirmation is required before the discovery run.
- Onboarding — identifying provider: a first-disclosure acknowledgment dialog shows the exact handle value and named provider before the first transmission of each `(field, provider)` pair. Cancelling blocks only that invocation; it does not modify the field value, `include_in_discovery`, or standing consent.
- Broker-search queries are not part of the initial onboarding discovery run and are not surfaced here.
- Settings > Discovery: list active consents with provider class and grant date; revoke consent per provider class behind a confirmation modal that explains consequences; view first-disclosure acknowledgment history per field and provider.
- Revoking consent in Settings does not cancel in-progress runs that have already passed dispatch; the UI explains this.
- All consent grant and revoke actions are confirmed in a modal before the service call.
- States: loading, no-consents-yet, active-consent-list, revoke-confirmation, acknowledgment-history.

**Testing:** hashed-query notice shown without per-field dialog; identifying-provider dialog shown for each field; cancel blocks invocation only (field value and consent unchanged); revoke consent reflected in Settings; keyboard-only flow through both consent paths.

---

### ATL-211 · Candidate adjudication UI

**Epic:** Discovery · **Priority:** P0 · **Complexity:** L · **Depends on:** ATL-208, ATL-210

**Objective:** Build the candidate adjudication surface used in onboarding and in the Discover section (FR-16): a structured list of pending candidates with evidence, four adjudication actions, and a separate display path for aggregator-attributed exposure evidence.

**Acceptance criteria**

- Pending candidate card: proposed service name (derived from evidence; labeled as a proposal, never as a confirmed account), evidence source, provider class, confidence, and the data categories or signals surfaced.
- Four adjudication actions presented clearly on each candidate card: Confirm, Reject, Dismiss, Not sure. No action is buried in a secondary menu on the initial card view.
- Aggregator-attributed evidence (`is_aggregator_attributed = true`): displayed as an evidence notice in a separate section. No Confirm/Reject/Dismiss/Not sure actions — there is no account candidate to adjudicate.
- Adjudication is optional at onboarding; the user may proceed to the Dashboard with all candidates deferred. A "Skip for now" path is unambiguous.
- Post-adjudication behavior: rejected candidate disappears immediately; dismissed candidate moves to a lower-urgency section; not-sure candidate stays in the list with a visual indicator; confirmed candidate transitions to an inline success state and links to the new digital asset.
- De-confirmation on a confirmed asset (within the Digital Assets detail view) calls `CandidateAdjudicationService.deconfirm`; shows consequences and requires confirmation.
- No candidate card or evidence notice contains the plaintext email address used in the query.
- All states handled: loading, empty (no pending candidates), single candidate, multi-candidate, error, keyboard-only.

**Testing:** four actions functional and mapped to correct service calls; aggregator evidence section with no adjudication actions; deferred candidates remain in Discover; rejected candidate removed from list; de-confirmation flow; keyboard-only completion; sensitive values absent from rendered output.

---

### ATL-212 · Discover surface and navigation

**Epic:** Discovery · **Priority:** P0 · **Complexity:** M · **Depends on:** ATL-211, ATL-019

**Objective:** Add the Discover section to primary navigation (§12 IA): aggregates pending candidates, aggregator-attributed evidence, and discovery run status in one surface; integrates discovery status into the Dashboard where appropriate.

**Acceptance criteria**

- Discover appears in primary navigation. Navigation label and exact position are design decisions; this ticket implements the capability grouping defined in §12 IA (Identity Profile, discovery run status, candidate adjudication, exposure evidence).
- The Discover surface entry point shows a pending-candidate count badge when candidates are awaiting adjudication. The badge updates after an adjudication action without a full page reload.
- Discovery run status is shown inside the Discover surface: pending, running (with progress indication), and terminal states (completed, partial, blocked, failed) with an appropriate status description.
- Confirmed candidates that have become digital assets do not appear in the Discover surface.
- The Dashboard reflects an active discovery run (e.g., a status indicator or metric card note) when a run is in progress; the exact treatment is a design decision.
- Discovery run status is updated on navigation or explicit user refresh. Automatic polling is out of scope for MVP; automated re-run scheduling (periodic evidence refresh) is a Phase 3 capability (PRD §15) and is not implemented or stubbed by this ticket.
- Entry points to Identity Profile and consent settings are accessible from the Discover surface.
- All states: loading, no-pending-candidates empty state, pending-candidates list, run-in-progress, run-completed.

**Testing:** pending count badge updates after adjudication; confirmed candidates absent from surface; run-in-progress state shown; keyboard navigation through Discover; empty state correct; Dashboard run-status indicator shown during active run.

---

### ATL-214 · Discovery-first end-to-end core journey tests

**Epic:** Quality · **Priority:** P0 · **Complexity:** XL · **Depends on:** ATL-211, ATL-092

**Objective:** Extend the ATL-092 suite with the discovery-first primary onboarding journey (PRD §9.1 steps 1–9): Identity Profile construction, field-for-discovery selection, discovery consent (hashed-query and identifying-provider paths), initial discovery run, and optional candidate adjudication. Also covers the upgrade-onboarding path for users who completed pre-M13 onboarding. This ticket makes the canonical discovery-first journey exercisable end-to-end in CI.

**Acceptance criteria**

- Discovery-first onboarding path automated end to end: Identity Profile field entry, `include_in_discovery` toggle, consent grant (hashed-query and identifying-provider notices), discovery run completion, and candidate adjudication with at least Confirm and Dismiss actions exercised.
- Deferred-adjudication path: user skips adjudication at onboarding; Dashboard shows no findings for deferred candidates; Discover surface shows pending candidates.
- Upgrade-onboarding path: a user with `onboarding_completed_at` set but no Identity Profile fields is routed through the Identity Profile, consent, and discovery steps before reaching the Dashboard.
- Confirmed candidate appears in the digital asset inventory and is eligible for the findings pipeline.
- No discovery-originated plaintext email address or field value appears in a URL, page title, or log during any automated journey.
- Flake rate <2% over 20 runs.

**Testing:** the ticket is the suite; all journeys run against a staging-like environment with seeded HIBP stub responses.
