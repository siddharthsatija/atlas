# Atlas Technical Architecture

## 1. Purpose

This document defines the MVP architecture for Atlas. The architecture prioritizes security, explainability, maintainability, and fast iteration by a small team using Claude Code.

## 2. Architectural principles

1. Server-side authorization for every protected operation.
2. Row-level security as defense in depth, not the only authorization layer.
3. Personal data is minimized, classified, and masked.
4. AI is an assistive subsystem, never the source of truth.
5. Business rules are deterministic where possible.
6. External effects require explicit user approval.
7. Every score change and request transition is auditable.
8. The product must function in a limited form when AI is unavailable.

## 3. Recommended stack

### Application

- Next.js with App Router
- TypeScript in strict mode
- React Server Components by default
- Tailwind CSS
- shadcn/ui primitives
- Radix UI behavior primitives
- Lucide icons
- Recharts for simple charts
- Zod for validation
- React Hook Form for complex forms

### Data and authentication

- Supabase Auth
- PostgreSQL
- Supabase Storage for user exports and approved attachments
- Row Level Security on all user-owned tables
- Supabase Edge Functions or server-side Next.js jobs for controlled background work

### AI

- Anthropic API through a server-only adapter
- Structured outputs validated with Zod
- Retrieval limited to user-authorized Atlas records and curated product guidance
- Provider abstraction to support future replacement

### Hosting and operations

- Vercel for the web application
- Supabase managed database and authentication
- GitHub repository and Actions
- Error monitoring and privacy-safe product analytics
- Transactional email provider for authentication and system notices
- Durable shared store for rate limiting (Vercel KV, Upstash Redis, or equivalent; provider selection is an open decision, but a shared durable counter store is required — serverless instances cannot rate-limit in memory)

Provider versions should be pinned at implementation time. Do not place version numbers in product requirements unless tested.

## 4. System context

```mermaid
flowchart LR
    U[User Browser] --> W[Next.js Web App]
    W --> A[Supabase Auth]
    W --> API[Server Actions / Route Handlers]
    API --> DB[(PostgreSQL)]
    API --> ST[Object Storage]
    API --> AI[AI Gateway]
    AI --> AP[Anthropic API]
    API --> EM[Transactional Email]
    API --> OBS[Monitoring]
```

## 5. Trust boundaries

- Browser is untrusted.
- Client state is not authorization evidence.
- Next.js server layer is trusted only after authentication and input validation.
- Database enforces RLS for user-owned records.
- AI provider is an external processor and receives the minimum necessary context.
- Analytics and monitoring must never receive raw personal-data fields.
- Email handoff is user-approved and must not be initiated from background automation in MVP.

## 6. Application architecture

### 6.1 Route groups

```text
app/
  (public)/
    page.tsx
    privacy/
    terms/
  (auth)/
    sign-in/
    verify/
  (product)/
    layout.tsx
    overview/
    assets/
    assets/[assetId]/
    insights/
    requests/
    requests/[requestId]/
    activity/
    archive/
    settings/
  api/
    ai/
    exports/
    webhooks/
```

### 6.2 Layering

```text
UI components
  ↓
Feature modules
  ↓
Application services
  ↓
Repositories / external adapters
  ↓
Database and external providers
```

UI code must not call the database or AI provider directly.

### 6.3 Suggested repository structure

```text
src/
  app/
  components/
    ui/
    layout/
  features/
    auth/
    onboarding/
    dashboard/
    assets/
    findings/
    requests/
    activity/
    assistant/
    settings/
  server/
    auth/
    services/
    repositories/
    ai/
    jobs/
    audit/
  lib/
    validation/
    formatting/
    permissions/
    telemetry/
  types/
  test/
supabase/
  migrations/
  seed.sql
  tests/
docs/
```

## 7. Data model

All identifiers use UUIDs. All tables include `created_at` and `updated_at` unless noted.

### 7.1 profiles

- `id`: UUID, references authenticated user (primary key doubles as owner column; RLS uses `auth.uid() = id` — this is the one permitted exception to the `user_id` rule in §8)
- `display_name`
- `timezone`
- `locale`
- `onboarding_completed_at`
- `onboarding_state_json`: saved step progress for resumable onboarding (step, choices; no sensitive values). ATL-017 defines the shape in `src/lib/onboarding/onboarding-state.ts` — exactly `step`, `privacyGoal`, `categories`, `startingPoint`, every one an id from a closed vocabulary. Read through `parseOnboardingState`, never raw: the column's only database constraint is `jsonb_typeof(...) = 'object'`, so a malformed or tampered value must degrade to a usable flow rather than break it. Recovery is field-by-field, and an unreadable step falls back to the first one. AI-processing consent is deliberately **not** stored here — restoring a ticked box would produce agreement the user never gave on that visit (ATL-016, ATL-078). Cleared when onboarding completes, since every answer is then held in its own column.
- `privacy_goal`
- `selected_categories`: asset categories chosen during onboarding
- `demo_data_enabled`

### 7.2 digital_assets

- `id`
- `user_id`
- `service_name`
- `service_domain`
- `category`: the **kind of service** — `social`, `shopping`, `finance`, `email`, `entertainment`, `health`, `work`, `travel`, `other`. Defined in `src/lib/assets/categories.ts` (ATL-016, which needed it first for onboarding step 3) and inherited by ATL-027. Distinct from §7.3's data categories: `social` is what a service **is**, `contact` is what it **stores**
- `account_identifier_encrypted`
- `status`: active, inactive, archived, removed
- `source_type`: manual, demo, connector, import
- `source_label`
- `confidence`
- `last_verified_at`
- `notes`
- `metadata_json`

ATL-035 implementation note. `AssetService` exposes exactly two ways to read `account_identifier_encrypted`: `readMaskedAccountIdentifier`, which cannot return plaintext at all, and `revealAccountIdentifier`, which resolves ownership, writes a `personal_field.revealed` audit event, and returns the value **only after that append has succeeded** — so an unaudited reveal is unreachable rather than merely discouraged (security §12, ADR-006). The audit context carries the entity reference and a reason, never the value or its mask. The browser receives the plaintext solely as the return of a Server Action invoked by an explicit click, so it is absent from the RSC payload, the HTML, and every URL; `SensitiveValue` (ATL-009) re-masks it on a timer. A reveal writes no activity event: §12 lists it as an audited action, and putting it on the user's timeline would log them looking at their own data.

ATL-027 implementation notes. `status`, `source_type`, and `confidence` are check-constrained in SQL **and** listed in `src/lib/assets/asset-fields.ts` — deliberate duplication, because §11's rules read these values and a drifted one would silently change what a rule means. `category` is constrained by shape only; its vocabulary stays in `src/lib/assets/categories.ts` so an append-only migration never has to race an application constant. `metadata_json` is allowlisted in `src/lib/assets/asset-metadata.ts`, built on the ATL-085 redaction utility rather than a parallel validator; the column is not in the §8 encrypted inventory, so anything restricted reaching it would be stored in plaintext. Clients get `select`, `insert`, and `update` scoped to `auth.uid() = user_id`, and no `delete`: removal is a status transition (ATL-036), and hard deletion is server-side only — demo removal (ATL-083) and the account cascade.

### 7.3 asset_data_categories

- `id`
- `user_id`
- `asset_id`
- `category`: identity, contact, location, financial, behavioral, biometric, content, device, professional, health, other
- `description`
- `sensitivity`
- `source`
- `confidence`

ATL-028 implementation notes. **Cross-user protection is structural**: the foreign key is composite — `(user_id, asset_id)` references `digital_assets (user_id, id)` — so a row claiming one owner while pointing at another's asset cannot exist, even for service-role writes that bypass RLS. A single-column reference would have satisfied referential integrity while leaving such a row invisible to both users and still countable by the rules engine. The composite target required adding `unique (user_id, id)` to `digital_assets`, done additively in ATL-028's own migration rather than by editing ATL-027's.

**`sensitivity` is a generated column, not a stored choice.** ADR-004 fixes the high-sensitivity set at financial, health, biometric, and location, and the score's data-sensitivity factor counts active-asset × high-sensitivity-category pairs from that list — so sensitivity is a property of the category, not of the row. Postgres generates it (`high` for the ADR-004 set, `standard` otherwise) and rejects any attempt to supply or update it. The same mapping is mirrored in `src/lib/assets/data-categories.ts` for the application, and the schema test asserts the two agree. A writable column would let a user downgrade a `financial` category to keep it out of their own score.

`unique (user_id, asset_id, category)` prevents one fact being recorded twice, which would deduct twice in ADR-004's factor and inflate R-008's count. Clients get `delete` here, unlike `digital_assets`: removing a category is ordinary editing (ATL-033), not the destruction of a record carrying its own history.

### 7.4 asset_permissions

- `id`
- `user_id`
- `asset_id`
- `permission_type`
- `scope`
- `status`
- `last_verified_at`

ATL-029 implementation notes. §7.4 enumerates none of these, and only two values appear anywhere in the documentation — `broad` (R-004, ADR-004) and `active` (R-004, R-005) — so each vocabulary below was settled as a product decision and sized to the smallest set its consumers need.

**`scope` is `broad | limited`** — a classification, not the raw grant. ADR-004's factor is `100 × (1 − broad-scope active ÷ total recorded)` and R-004 asks only "is this broad?", so both consumers read a binary. A richer scope list can be added later without changing what the score reads. **`status` is `active | revoked | unknown`**: only `active` raises R-004/R-005, but *every* status counts in ADR-004's "total recorded" denominator — that asymmetry is deliberate, so revoking a permission improves the factor rather than erasing the evidence it existed. `unknown` exists because the honesty rules do not permit forcing a user to assert a state they cannot verify. **`permission_type` is shape-constrained in SQL and vocabulary-constrained in the application** — the same split `digital_assets.category` uses. The list, settled as a product decision in ATL-033 because no document enumerated one, is `account_access | data_sharing | marketing | device_access | other`, grouped by what the permission lets a service do to the user rather than by any provider's naming. It lives in `src/lib/assets/permissions.ts`, is enforced by `AssetService.addPermission`, and is offered as a fixed choice in the UI: free text would let one grant be recorded under two names, and both would count in ADR-004's "total recorded" denominator. Widening the list later is additive and needs no migration, which is why it is not a SQL enum.

**There is no expiry column.** §7.4 lists none and no rule or factor reads one; R-005 measures staleness from `last_verified_at`, where null (never verified) is included in the stale population rather than skipped. Cross-user protection reuses ATL-028's composite foreign key against `digital_assets (user_id, id)`, so ATL-029 needed no additive constraint of its own. `unique (user_id, asset_id, permission_type)` keeps a duplicate from moving ADR-004's denominator.

### 7.5 privacy_findings

- `id`
- `user_id`
- `asset_id`, nullable
- `finding_type`
- `rule_id`: identifier of the generating rule (see §11), null for demo-seeded findings
- `rule_version`: rule catalog version at generation time
- `dedup_key`: deterministic hash of rule ID and entity scope; unique per user, prevents duplicate findings for the same condition
- `title`
- `description`
- `severity`: low, medium, high, critical
- `confidence`
- `source_type`
- `source_reference`
- `evidence_summary`: human-readable, contains no restricted values
- `evidence_refs_json`: IDs of the records the rule evaluated
- `recommended_action`
- `status`: open, in_progress, resolved, dismissed
- `resolved_by`: user, system (system when auto-resolved because the rule predicate no longer holds)
- `resolved_at`
- `input_hash`: SHA-256 of the material field values of the records the rule evaluated (ATL-102). Nullable — findings written before ATL-102 have none, and there is no honest backfill, because the hash summarises a snapshot that no longer exists

ATL-038 implementation notes. `finding_type` holds §11.1's four **rule categories** (`hygiene | exposure | permissions | requests`), not the rule's own name: `rule_id` is null for demo-seeded findings, so a rule-named type would leave those typed after a rule that never ran, and would duplicate `rule_id` everywhere else. It is shape-constrained in SQL with the vocabulary in `src/lib/findings/findings.ts` — the same split `digital_assets.category` uses. `severity`, `status`, `confidence`, `source_type` and `resolved_by` are check-constrained in SQL *and* listed in that module, the deliberate duplication §7.2 describes, because §11.1's rules and ADR-004's factors read them. `confidence` and `source_type` reuse `digital_assets`' scales rather than defining second ones for the same concepts.

Three check constraints encode arithmetic rather than taste. A closed finding must carry both `resolved_by` and `resolved_at`, and an open one neither — ADR-004 counts resolutions inside a trailing 180-day window, which a resolution with no timestamp cannot enter. `resolved_at` may not be in the future, for the same reason. And `rule_id` and `rule_version` are null or non-null together, because ADR-001 requires a rule change to be recorded on the findings it generated, so an unversioned rule id is unexplainable. `unique (user_id, dedup_key)` is what makes §11.1's "a rule fires once per condition" true in the database when the engine is wrong; ATL-102 owns the re-fire and dismissal-suppression rules above it. Cross-user protection reuses ATL-028's composite foreign key against `digital_assets (user_id, id)`; `asset_id` is nullable (`match simple`) because R-008 is a statement about the whole footprint rather than one service, and the key cascades because a finding whose subject no longer exists cannot be explained, only displayed.

**Clients may only read this table.** `authenticated` gets `select` and no other policy or privilege — the only user-owned table in Atlas where that is true. Findings are not user-authored: NFR-06 requires every finding to be traceable to a rule, source, or model output, and §11.1 requires resolution and dismissal to write an activity event and feed score recalculation, which `FindingService` (ATL-040) does and a direct client update would skip. `resolved_by = 'system'` is an assertion only the engine makes about itself. No column here is in security §8's encrypted-column inventory — findings are Confidential, not Restricted — so ADR-003 does not apply; what keeps restricted values out of `evidence_summary` is §11.1's evidence model, applied by the engine (ATL-101) when it renders the template.

### 7.6 privacy_score_snapshots

- `id`
- `user_id`
- `score`
- `score_version`: e.g. `score-v1`; snapshots are never recomputed under later versions
- `is_demo`: true when computed exclusively over demo records; demo snapshots are deleted with demo data
- `factor_breakdown_json`: factor scores, inputs, weights, and which factors were excluded for missing data
- `reason`
- `recorded_at`

**ATL-045 implementation notes.** The table is **append-only, enforced by privilege**: `authenticated` gets `select` on its own rows and nothing else, and `service_role` gets `select, insert, delete` — **no `update`, for any role**. ADR-004 says historical snapshots are never recomputed, so a snapshot cannot be rewritten by a mistake at any layer; `PrivacyScoreSnapshotRepository` offers no update method, but a missing method is not a guarantee, which is why the privilege is withheld too. The two destructive paths are retention compaction and the demo purge, plus the `auth.users` cascade. There is deliberately no `updated_at` column and no `set_updated_at` trigger — a column that can never change would be a promise this table does not make.

`recorded_at` is **database-owned**: `default now()`, never supplied by the application (ATL-113), with a not-future check that cannot fight the default because `now()` is `transaction_timestamp()` — the value and the predicate share one clock in one transaction. Backdating remains legal, which is what compaction fixtures depend on.

`score_version` and `reason` are **shape-checked rather than `IN` lists**, with the vocabularies owned by `src/lib/score/score-config.ts` and `ScoreRecalculationRequest.reason` — the ATL-038 `finding_type` split, so a new trigger at M8 is an application change rather than a forward migration racing a constant. `factor_breakdown_json` is constrained to a JSON *object*, because an array or scalar would be unreadable to ATL-046 and would surface only at render time. Indexes: `(user_id, recorded_at desc, id desc)` for "latest" and history, `(recorded_at)` for compaction, and a partial `(user_id) where is_demo` for the demo purge.

### 7.7 data_requests

Named `data_requests` (not `deletion_requests`) because the MVP supports both deletion and correction requests (PRD FR-08, asset detail actions). Migrations are append-only after shared deployment, so the name must be right from the first migration.

- `id`
- `user_id`
- `asset_id`
- `request_type`: deletion, correction
- `status`
- `recipient_encrypted`: recipient addresses are Restricted data (email addresses) and are encrypted like the body; list views show the associated service name and a masked recipient
- `subject_encrypted`: subjects frequently contain personal identifiers and receive the same protection
- `body_encrypted`
- `included_fields_json`: approved personal-field keys only, never values
- `delivery_method`: copy, mailto, manual
- `sent_at`
- `follow_up_at`
- `completed_at`
- `external_reference`
- `last_status_note`

**ATL-056 implementation notes.**

**Four encrypted columns, not three.** `last_status_note` joins the recipient, subject and body in security §8's inventory — it holds what the service replied, which routinely carries case references and identifiers. Each of the four is sealed against its own AAD (`data_requests.<column>:<row id>`), so a ciphertext cannot move between rows **or** between columns; the row id is generated by the application before any value is sealed, the pattern `digital_assets.account_identifier_encrypted` established. `DataRequestRecord` carries no restricted value at all — not plaintext, not a mask — and exposes `hasRecipient`/`hasSubject`/`hasBody` booleans so a surface can tell whether a draft is complete without being handed its contents. `readContent` is the only path to the full draft and `readMaskedRecipient` is the list view's read, masking inside the method as `AssetService.readMaskedAccountIdentifier` does.

**The status column stores state; it does not enforce the lifecycle.** A check constraint sees one row's new value and not the value it replaced, so `draft → completed` is indistinguishable from a legitimate write at that layer, and §13 requires transitions to be validated server-side, protected by idempotency keys, and recorded in two logs — four obligations a constraint cannot discharge. ATL-056 declares the graph in `src/lib/requests/requests.ts` (`ALLOWED_REQUEST_TRANSITIONS`, a table rather than a `switch`, so ATL-057's exhaustive matrix can compare pairs against §13 directly); **ATL-057 owns execution**. `DataRequestRepository.updateStatus` is the write seam it will call, and it takes an `expectedStatus` so two concurrent transitions cannot both succeed.

**Two arithmetic constraints, and no defaults that would invent product rules.** A `completed` request must carry `completed_at` and a non-completed one must not, because ADR-004 credits completions inside a trailing 180-day window and a completion with no timestamp cannot enter it — the same reasoning `privacy_findings.resolved_at` encodes. `follow_up_at` is nullable with **no default**: ATL-066 owns the follow-up interval, no document states one, and a default here would be a product rule expressed where nobody would look for it. `included_fields_json` is constrained to a JSON array and validated against `PERSONAL_FIELD_KEYS` at the repository boundary; it holds approved **keys only**, never values (ADR-002, FR-08).

**Privileges are least-privilege, not anticipatory.** The client policy is `select` only — the encrypted columns cannot be written by a client at all, since the client has no access to the user's DEK, so a client write path could only produce a row whose recipient, subject and body were absent or unencrypted. `service_role` gets `select, insert, update`: three verbs, three methods, and **no DELETE**, because ATL-056 has no delete operation and no caller. The product's answer to an abandoned request is `canceled`, a state a person can still read, rather than removal; the `auth.users` cascade needs no grant, so account deletion is unaffected (the same arrangement `ai_messages` uses). A later ticket that needs request deletion adds the privilege alongside the authorization rules that govern it.

**`external_reference` is bounded metadata** — a service's own case number, capped at 120 characters and validated at the repository boundary. Security §3 does not classify it, so it is stored in plaintext under RLS; that assumption is recorded here rather than left implicit, it is not indexed or searchable, and the value stays out of logs.

**No demo marker.** §7.7 specifies no `source_type` and nothing seeds demo requests today, so adding one would be speculative schema design. If demo requests are ever introduced, the ticket that introduces them adds the column and extends ATL-083's purge and §11.2's isolation at the same time.

**No consumer is wired.** R-007 remains unregistered and R-006 still evaluates only its first conjunct (both wait on ATL-057's lifecycle semantics); the score's `completedRequests` parameter still defaults to 0; `anchorFor` still maps `draft_request` to `global`; and the asset detail Requests section still says the capability is not built. Each has an owning ticket.

### 7.8 request_events

- `id`
- `user_id`
- `request_id`
- `event_type`
- `from_status`
- `to_status`
- `summary`
- `actor_type`: user, system
- `occurred_at`

**ATL-056 implementation notes.**

**Why three logs, and who reads each.** A transition is recorded in all of `request_events`, `activity_events` and `audit_events`, and they answer to different consumers: `request_events` is the **request-scoped, user-facing timeline** frontend §9 renders in the request detail view; `activity_events` is the **global feed** (ATL-069, frontend §12) that mixes assets, findings, requests and consent chronologically; `audit_events` is the **security and compliance record** (ADR-006) — pseudonymous, hash-chained, 90-day retention, no client access — which security §12 requires to hold request state transitions. Deriving the first from the second was considered and rejected: a request timeline built by filtering the global feed would inherit that feed's retention, metadata allowlist and ordering, none of which are chosen for this purpose.

**`summary` is composed from templates, never accepted as free text.** `REQUEST_EVENT_TEMPLATES` (`src/lib/requests/request-events.ts`) builds the sentence from an event type and at most two statuses; there is no free-text parameter anywhere in the write path, and `RequestEventParams` deliberately has no equivalent of `ActivityParams.maskedIdentifier`. This matters more here than on any other table: a `request_events` row is written at the moment the caller holds the recipient, the subject and the draft body, so a `summary` argument would make "no restricted value lands here" a rule every future caller has to remember, and an address in a timeline reads perfectly normally. Composition lives in the repository rather than a service above it because ATL-056 creates no request service — ATL-057 owns `RequestService` — which keeps the guarantee attached to the only code that can write the column.

**Append-only, enforced by privilege.** `service_role` gets `select, insert` and nothing else; there is no update or delete for any role, and no `updated_at`. An event that could be edited is not a record of what happened (ATL-068's reasoning for `activity_events`, applied here). Rows leave only by cascade from their request or from `auth.users`. `event_type` is shape-checked rather than enumerated — the vocabulary grows as ATL-058–067 each add a step — while `from_status`, `to_status` and `actor_type` are enumerated, and a transition must name both statuses or neither.

### 7.9 activity_events

The user-facing product timeline (PRD FR-09, frontend §13). RLS enabled: the owner may SELECT their own rows. There is **no INSERT, UPDATE, or DELETE policy** — events are written by services through the shared emitter (ATL-069), and rows leave with the account cascade.

- `id`
- `user_id`
- `event_type`: shape-constrained here, enumerated and typed in the application (ATL-069)
- `entity_type`, `entity_id`: both or neither, enforced by a check constraint
- `summary`: the line the user reads. No restricted values — masked identifiers at most (ATL-069)
- `metadata_redacted_json`: allowlisted structured context, validated in the application by the ATL-085 redaction utility (`src/lib/activity/activity-metadata.ts`)
- `occurred_at`, `created_at`

**Client write access (ATL-068).** Undocumented before this ticket, so recorded here. A user cannot insert, edit, or delete individual events: a selectively-erasable timeline is a weaker record, including for the user who later wants to know when a change actually happened. ADR-006's "deleted with the account" is satisfied by the cascade. A future "clear history" action would be additive.

**Metadata allowlist scope.** Only non-identifying categories are permitted today — statuses and transitions, counts, scores, classification labels, versions, and the demo flag. No free text and no identifiers beyond the `entity_id` column the table already models. The list grows with each feature milestone that emits new events, exactly as the ADR-006 audit inventory does.

**Indexes.** `(user_id, occurred_at desc, id desc)` for the timeline, a partial index on `(user_id, entity_type, entity_id)` for entity links, and `(user_id, event_type, occurred_at desc)` for action filters. The `id` tiebreak is load-bearing: `occurred_at` is millisecond-resolution, so without it the sort is ambiguous and the cursor pagination ATL-070 requires can repeat or skip a row at a page boundary.

### 7.10 consents

Append-only consent history. RLS enabled: the owner may SELECT their own rows (Settings renders the history, ATL-076); there is **no client INSERT policy**, because recording consent must stamp the server's policy version and emit an audit event.

- `id`
- `user_id`
- `consent_type`: one of `ai_processing`, `personal_fields_storage`, `ai_conversation_history`, `product_updates`
- `policy_version`: the version in force when the decision was recorded. Never back-filled — consent is to the terms as they stood
- `granted`: true for a grant, false for a revocation. Both are rows
- `recorded_at`

**Schema change (ATL-078).** This section previously also listed `revoked_at`. That column and ATL-078's requirement that "grant/revoke writes an immutable consent row" cannot both hold: populating `revoked_at` means mutating a row that is meant to be evidence of what was agreed at a point in time. An append-only log also makes grant → revoke → re-grant reconstructible, which a single mutable row cannot represent at all. `revoked_at` is therefore dropped; current state is the newest row per `(user_id, consent_type)`.

**Immutability.** UPDATE is refused by trigger for every role including the owner. DELETE is *not* trigger-blocked, unlike `audit_events`: this table cascades from `auth.users`, and a raising BEFORE DELETE trigger would make account deletion impossible. DELETE is withheld by grant instead, which the cascade does not consult.

**Policy version source.** `CONSENT_POLICY_VERSION` in `src/config/app.ts` — a reviewed constant rather than an environment variable, so every change to the terms is a code change with an author, a date, and a diff. Bump it when the policy text changes in a way that requires re-consent; the consent gate denies a grant recorded against a superseded version.

### 7.11 ai_interactions

Store metadata only unless conversation history is explicitly enabled.

- `id`
- `user_id`
- `purpose`
- `model`
- `prompt_version`
- `input_classification`
- `records_referenced`: entity IDs included in AI context. This is an authorized, RLS-protected database table used for user-visible disclosure and audit — not a log. The §16 rule against identifiers applies to telemetry/log sinks, not to this table.
- `output_schema_version`
- `status`
- `latency_ms`
- `user_feedback`
- `created_at`

**Implemented by task #95.** `user_feedback` is stored as two nullable columns — `helpful boolean` and `feedback_category text` — so "no feedback yet" stays distinguishable from "marked unhelpful with no category", a distinction a single blob loses. Categories come from AI behavior §12.

**`policy_version` is a documented extension to this list.** Atlas versions the shared system policy separately from task templates (§12.2), so `prompt_version` alone does not identify the instructions that ran; the pair does, and reproducibility is the reason this column exists at all.

**`input_classification` is nullable and nothing writes it.** The column exists because this section requires it, but no document in the repository defines its vocabulary — sensitivity tier, purpose and demo state are all plausible readings and they contradict each other. Guessing would bake one in. The ticket that owns classification defines the values.

**Append-only except feedback, enforced by trigger.** Feedback arrives after the interaction, so `service_role` holds UPDATE — and a bare grant would let any server bug rewrite `status`, `records_referenced` or `created_at`. `ai_interactions_feedback_only_update` permits an update only when `helpful`/`feedback_category` changed and every other column is untouched; anything else raises `insufficient_privilege`. Clients have `select` only: a user who could insert could fabricate an interaction that never happened.

**Retention is "retain while the account exists"** (security §14 lists no rule for this table). Deletion flows through the `auth.users` cascade, so there is no purge job, no DELETE grant, and deliberately no `created_at`-only index — an index with no query is cost without benefit.

**`records_referenced` is not a foreign key**, because the ids span findings, assets and permissions. That is a real deviation from §8's "foreign keys must prevent cross-user relationships"; cross-user leakage is prevented upstream by ATL-049's retrieval, which selects only the caller's records.

**Status vocabulary lives in code** (`src/lib/ai/interaction-vocabulary.ts`): `validated`, `fallback`, `unavailable`, `provider_error`, `rate_limited`, `consent_denied`. SQL shape-checks only — the same split `finding_type` and `score_version` use. None of these is ever a provider message; `AiGatewayError` has no field capable of carrying one.

**Nothing writes content, because there is nowhere to put it.** No column can hold a prompt, a completion, user text or a provider message, and `RecordInteractionInput` has no such field either — a caller holding a completion cannot pass it in by mistake. A database test reads the column list back and asserts exactly the fourteen expected names.

### 7.12 export_jobs

- `id`
- `user_id`
- `status`
- `storage_path`
- `expires_at`
- `completed_at`

### 7.13 user_personal_fields

Reusable, user-managed identity fields for request drafting (see ADR-002). Collected just-in-time, never at onboarding. Every field optional and individually deletable.

- `id`
- `user_id`
- `field_key`: full_name, email, phone, address, username, other
- `label`: user-facing name, e.g. "Personal Gmail"
- `value_encrypted`: AES-256-GCM under the per-user DEK (see §8 and ADR-003)
- `last_used_at`
- Consent to store is recorded in `consents` (`consent_type = personal_fields_storage`) on first save.

### 7.14 notifications

In-app notifications (see ADR-005). Created server-side only.

- `id`
- `user_id`
- `type`: follow_up_due, request_status, security, finding_new, system
- `title`
- `body`: redacted — service names and statuses allowed, no personal values or draft text
- `entity_type`
- `entity_id`
- `read_at`: null means unread
- `created_at` (no `updated_at`)
- Purged after 90 days by background job; deleted with the account.

Implemented by ATL-107. `title` and `body` are composed server-side from the per-type templates in `src/lib/notifications/notification-types.ts` and are never accepted as caller-supplied strings — `NotificationService` is the only writer, and it scans the composed text for restricted patterns and refuses the write if any survive. `entity_type` and `entity_id` are paired by a check constraint: both or neither. The client policy is `select` only; creation, read-state changes, and the purge are server-side.

### 7.14a notification_preferences

Per-type notification overrides (see ADR-005). Added by ATL-107; §7 previously specified no preference storage, and none existed — `profiles` has no such column, and `consents` is an append-only history of user agreements rather than a mutable toggle.

- `id`
- `user_id`
- `notification_type`: the §7.14 vocabulary, constrained; `security` is additionally forbidden by its own check constraint
- `enabled`: the person's explicit choice
- `created_at`, `updated_at` (shared `set_updated_at` trigger)
- Unique on `(user_id, notification_type)`; deleted with the account.

**A row is an override, not a setting.** Absence means "use the default declared beside the type in `src/lib/notifications/notification-types.ts`". Defaults and configurability live in code because they describe the type rather than any user, because Settings (ATL-077) and the service both need them and features may not import `src/server`, and because a default written into a table would require a backfill and would leave accounts created before a change permanently disagreeing with accounts created after. Clearing an override therefore returns a type to whatever the default then is, which storing the default's current value would not.

**`security` has no row, by two independent gates.** It is declared `configurable: false`, so `NotificationService` refuses to persist a preference for it and never consults one when creating; and the table refuses such a row outright, so "security notifications cannot be disabled" (FR-14) does not depend on the service being the only writer. Product-update consent is deliberately **not** mirrored here — `consents` (`consent_type = product_updates`) remains its single source of truth.

### 7.15 audit_events

Internal security audit log (see ADR-006). RLS enabled with **no client policies** (deny all); written only by the server-side audit writer. Application role has INSERT and SELECT only — no UPDATE or DELETE.

- `id`
- `occurred_at`
- `event_type`
- `subject_ref`: HMAC-keyed pseudonymous hash of the user ID (no `user_id` column by design — see ADR-006)
- `entity_type`, `entity_id`
- `actor_type`: user, system, operator
- `context_json`: allowlisted keys only (versions, request IDs, statuses, counts)
- `prev_hash`, `event_hash`: per-subject hash chain for tamper evidence
- Retention 90 days rolling; only deletion-completion evidence survives account deletion.

### 7.16 user_encryption_keys

Per-user wrapped data-encryption keys (see ADR-003). Service-role access only; no client policies.

- `id`
- `user_id`
- `wrapped_dek`
- `kek_version`
- `status`: active, retired, destroyed
- `destroyed_at`: set by crypto-shredding during account deletion

### 7.17 idempotency_keys

Backing store for idempotent transitions and jobs (§14). RLS enabled with **no client policies** (deny all); written only by the server-side idempotency service. Application role has SELECT, INSERT, UPDATE, and DELETE.

- `id`
- `user_id`
- `scope`: e.g. request_transition, export_job
- `idempotency_key`: unique with scope and user
- `result_encrypted`: the recorded result, envelope-encrypted per ADR-003 and AAD-bound to this table, column, and row. **NULL means the operation is claimed but still in flight.**
- `result_hash`: SHA-256 of the canonical plaintext result, verified after decryption
- `expires_at`: purged after 24 hours
- `completed_at`, `created_at`
- Set together or not at all: `result_encrypted`, `result_hash`, and `completed_at` are constrained all-or-nothing

**Schema change (ATL-104).** This section previously listed `result_hash` alone. A hash can verify a result but cannot return one, so it could not satisfy the ATL-104 criterion that a duplicate submission "returns the recorded result". The payload is therefore stored — and stored encrypted, because copying results into a second table would otherwise create a lower-scrutiny duplicate of data that already lives somewhere better guarded. `result_hash` is retained: AES-GCM detects tampering with the ciphertext, while the hash detects a result that decrypts cleanly but is not what was recorded.

**Claim before execute.** The row is inserted before the handler runs, so the unique index on `(user_id, scope, idempotency_key)` is what arbitrates concurrent submissions — exactly one caller wins the insert, and the loser is told the operation is in progress rather than duplicating its side effects. A claim whose handler fails is released so a retry can proceed. An expired claim is reclaimed in place under a guarded update rather than waiting for the purge job, so the TTL means 24 hours rather than "until a job happens to run".

### 7.18 ai_conversations and ai_messages

Exist only when the user enables conversation history (Settings → Privacy and AI). Feature is consent-gated (`consent_type = ai_conversation_history`).

`ai_conversations`: `id`, `user_id`, `context_type` (global, asset, finding, request), `entity_id`, `created_at`.
`ai_messages`: `id`, `user_id`, `conversation_id`, `role` (user, assistant), `content_encrypted`, `created_at`.

Disabling history hard-deletes all conversations and messages. Deleted with the account via crypto-shredding plus row deletion.

## 8. Database rules

- Every user-owned table includes `user_id`. Exceptions: `profiles` (primary key `id` is the owner, RLS uses `auth.uid() = id`) and internal tables with no client access (`audit_events`, `user_encryption_keys`).
- RLS must enforce `auth.uid() = user_id` (or `auth.uid() = id` for `profiles`). Internal tables enable RLS with no client policies.
- Foreign keys must prevent cross-user relationships.
- Sensitive values are encrypted at the application layer when database operators do not need plaintext.
- Soft deletion is allowed only where required for user recovery or audit; otherwise delete.
- Audit data must not duplicate sensitive content.
- Demo records must be clearly marked and separable from real data.

## 9. Service interfaces

### AssetService

- listAssets
- getAsset
- createAsset
- updateAsset
- archiveAsset
- restoreAsset
- deleteAsset

ATL-030 implementation notes (`src/server/assets/asset-service.ts`). Methods return a discriminated `AssetResult<T>` carrying an `ApiErrorCode`, **not** an `ApiEnvelope`: `requestId` is request-scoped, so the route handler or Server Action adds it and builds the envelope at the boundary. Failure modes stay visible in each signature, which throwing would hide.

Every method takes the user id as its first argument, supplied from a verified session and never from a payload (§10). A missing or foreign asset both answer `NOT_FOUND` — deliberately indistinguishable, because `FORBIDDEN` on a record you do not own confirms it exists, which is the leak ATL-034's "404, not 403" criterion exists to prevent. `NOT_FOUND` was added to `API_ERROR_CODES` for this; the union had no variant for it.

Archive and restore are conditional transitions (`expectedStatus` in SQL), so a repeat archive answers `NOT_FOUND` rather than writing a second activity event for something that did not change. `deleteAsset` performs the authorized deletion and emits `asset.deleted`, but writes **no audit event** — ATL-037 owns permanent deletion's confirmation flow, its audit record, and finding auto-resolution.

Activity emission and findings recompute are both best effort and neither can undo the mutation: the write already succeeded and is the user's. Recompute goes through an injected `FindingsRecomputeQueue` whose default is a no-op (`src/server/findings/recompute-queue.ts`) — §14 names the job but no queue transport is specified anywhere, and ATL-101 owns the job itself. Shipping the seam now means the *call sites* are already correct.

List queries are keyset-paginated on `(created_at desc, id desc)`, matching ATL-027's indexes so a filtered page is an index scan rather than a scan plus sort. Filters are category, status, source, and last-reviewed. Frontend §6's **risk** filter is absent: it derives from findings, which do not exist until M6, and accepting a parameter that does nothing would leave a caller unable to tell an inert filter from one that matched nothing.

### FindingService

- listFindings
- getFinding
- resolveFinding
- dismissFinding
- calculateRecommendations
- getFindingDetail _(ATL-041; a read)_
- undismissFinding _(ATL-043; undo, required by that ticket's acceptance criteria)_

**ATL-039 implementation notes.** `FindingService` (`src/server/findings/finding-service.ts`) is the *user* half of the finding lifecycle and writes `resolved_by = 'user'` only. Auto-resolution stays with `FindingsEngine`, which writes `'system'` — ADR-004's protective-actions factor credits resolutions, so conflating them would pay a user for a condition that expired on its own. Neither module imports the other.

Resolve and dismiss validate the current status against §11.1's lifecycle: only `open` and `in_progress` may be closed, and an already-closed finding is refused with `INVALID_REQUEST` rather than treated as a no-op — a silent success would let a double submission rewrite `resolved_at`, move the finding inside ADR-004's trailing 180-day window, and post a second timeline entry for one event. A refusal writes nothing at all. Missing and foreign findings both answer `NOT_FOUND`, the non-oracle rule §9 applies everywhere.

**`in_progress` has no setter.** §11.1 includes it in the lifecycle and §9 names no operation that sets it, so ATL-039 does not invent one; the status is reachable only by whichever later ticket owns "start working on this". Both closing methods accept it as a starting state, so nothing breaks when that ticket lands.

Recommendation ordering — severity, then confidence, then age, then id — lives in `src/lib/findings/recommendation.ts` rather than in the service, so ATL-044/045 render the same order instead of reimplementing it. Age sorts **oldest first**: between two equally serious, equally certain findings, the one open longest is the more neglected. `id` is a final tiebreaker that makes the order total, so a list cannot reshuffle between requests. `calculateRecommendations` is that ordering over open findings only — frontend §8's Recommended view answers "what next", which a finished finding does not.

**ATL-040 implementation notes.** The Insights route (`src/app/(product)/insights/page.tsx`) is a Server Component calling `FindingService` directly, the pattern ATL-031 set for the asset list: no route handler, so no `ApiEnvelope`. Frontend §8's four views are URL state (`?view=`) parsed by `src/lib/findings/finding-views.ts`, and the switcher is plain links with `aria-current` rather than a tablist — switching view is a different read (Recommended is `calculateRecommendations`, not a status filter), and links do not promise arrow-key semantics they lack. The page does not sort: ordering stays in `recommendation.ts`.

`listFindings`, `getFinding` and `calculateRecommendations` return a `FindingView` — the stored record plus `impactedAsset`, the service name resolved in the service layer via `DigitalAssetRepository.listAllForUser` (one query per page, and none at all when no finding names an asset). Persistence is unchanged and nothing writes the field; the mutation methods still return the plain record, because a resolve returns what changed rather than what to draw. Findings with `asset_id = null` — footprint-wide conditions such as R-008 — carry the label `Entire digital footprint`, applied in the service so no surface has to special-case a null asset.

**Critical styling waits for a verification model.** Frontend §8 reserves it for "genuinely critical, verified findings" and the design system reserves danger for "verified critical risk", but nothing records whether a finding is verified. Confidence and `source_type` are deliberately *not* overloaded to mean it (see OQ-11), so the card applies the shared `SeverityBadge` mapping only until the model exists.

**ATL-113 — lifecycle timestamps come from the database clock.** `digital_assets.last_verified_at` and `privacy_findings.resolved_at` were written from the application clock and checked by their own not-future constraints against the database clock. Two clocks, one comparison: `now()` is `transaction_timestamp()`, so the transaction need only begin a few microseconds before the client's already-truncated millisecond for the check to reject. A local E2E run logged eleven such rejections across both tables, and the application reported them as `asset.store_unavailable`.

`20260811090000` moves all of it into the database. `set_updated_at` — shipped with `profiles` and commented as shared by user-owned tables — is attached to both tables at last, so no caller supplies `updated_at`. `set_finding_resolution_time` stamps `resolved_at` on the transition into `resolved`/`dismissed`, and leaves `resolved_by` entirely alone: §11.1's user-versus-engine distinction and ADR-004's crediting depend on it. `set_asset_review_time` resolves the `REVIEWED_NOW` sentinel (`infinity`) that `markReviewed` now sends in place of a timestamp — a review has no status transition to key on, and keying on "the column changed" would miss the first review of a never-reviewed asset, where both old and new are null. The sentinel also fails closed: without the trigger, the not-future constraint rejects `infinity` loudly rather than persisting a bogus review date for R-001 and ADR-004 to reason from. Only the sentinel is resolved, so INSERT-time backdating for demo data and rule fixtures is untouched.

No constraint was weakened, and no tolerance, skew window or retry was added: the value and the predicate judging it are now produced by one `now()` in one transaction.

**ATL-112 — a Server Action may not discard a service result.** The edit page's button-only actions (`setAssetStatusAction`, `markReviewedAction`, `editAssetChildrenAction`) awaited an `AssetResult`, dropped it, and revalidated regardless, so a failed write redrew the page unchanged and told the user nothing. `last_verified_at` feeds R-001 and ADR-004's freshness factor, which means a silent failure left the engine and the score reasoning about a date the user believed they had updated.

They now return an `AssetActionState` (`failure: "not_found" | "unavailable" | "rejected" | null`), rendered by `AssetActionForm` as the same inline `role="alert"` panel the metadata form uses — durable status in the page rather than a toast (frontend §19). **Revalidation happens only on success:** invalidating the cache for a write that did not occur is what made the failure look like a completed round trip. An unrecognised status or intent is `rejected` rather than a silent `return`, so no path through these actions can end in silence.

**ATL-042 — resolving a finding records what the user did.** §11.1 says who (`resolved_by`) and ATL-113's trigger says when (`resolved_at`); neither says *what*. `resolveFinding` now takes a required action drawn from a closed vocabulary in `src/lib/findings/resolution-actions.ts` — `reviewed`, `permission_revoked`, `data_removed`, `account_closed`, `other` — and `20260812090000` adds the nullable `privacy_findings.resolution_action` column with two check constraints: the value must be in the vocabulary, and it may exist only on a `resolved` finding. Null therefore keeps a precise meaning — the engine's auto-resolution records no action because nobody took one, and a dismissal is not a resolution.

The vocabulary is closed rather than free text for three reasons: free text on a finding is somewhere personal data would eventually land, ADR-006's `reason` key admits only identifier-shaped values, and a fixed set can be counted later without parsing. `other` exists so a user is never forced to misdescribe what they did.

Validation happens at the Server Action boundary (`src/app/(product)/insights/actions.ts`), not by letting the database refuse it — the constraint is the second gate. The action takes the user id from `requireVerifiedUser` and never from the form, maps `NOT_FOUND`/`INVALID_REQUEST`/anything else to four distinct user-readable failures, preserves the user's selection on every failure path (frontend §19), and revalidates `/insights` **only** on success, per ATL-112.

The confirmation is inline, inside ATL-041's drawer, and deliberately not a nested dialog: frontend §19 reserves modals for focused contained tasks, resolving is not destructive, and two nested focus traps is where keyboard bugs live. Confirm stays disabled until an action is selected — ATL-042 requires it to be *selected*, so nothing is pre-checked.

The audit event (`finding.resolved`) is written **after** the status change commits, under the post-commit audit failure policy recorded in ADR-006: the resolution stands if the audit write fails, the failure is logged at error level, and nothing is reverted. ADR-006's MVP event inventory is amended to include the event; dismissal is not audited and stays ATL-043's decision.

**ATL-043 — dismissal, and undo.** Dismissal takes an **optional** reason from a closed vocabulary in `src/lib/findings/dismissal-reasons.ts`: `not_relevant` and `accepted_risk`. `incorrect` is deliberately absent — the OQ-04 sign-off resolved disputed findings as *correction, not compensation*, so a user who believes a finding is wrong corrects the underlying record and the engine re-evaluates. Offering it as a dismissal reason would let someone declare the finding wrong while the data that produced it stood unchanged.

**The reason has no column, by design.** Nothing reads it: ATL-102's re-fire suppression turns on the input hash alone, and per ADR-004's OQ-04 amendment no reason moves the score. It is recorded in `activity_events.metadata_redacted_json.reason`, a key ATL-069's allowlist already permits and whose identifier pattern the ids satisfy by construction — so ATL-043 adds no migration, no constraint and no policy change. Undo therefore has nothing to erase, and the timeline keeps the honest sequence: dismissed for this reason, then restored.

**Undo is `restore()`, not `reopen()`.** `reopen` belongs to ATL-102, where the engine has just recomputed severity, confidence and an input hash from records that changed. Undo has none of those, because nothing about the user's data moved. `restore` therefore sets `status = 'open'`, clears `resolved_by` and `resolved_at` together — the resolution-complete constraint refuses an open finding that still names a resolver — and touches nothing else. `input_hash` in particular is left exactly as it was: §11.1 says a null hash means *unknown*, not unchanged, so writing one would tell ATL-102 something false about a finding nobody re-evaluated. The write is scoped to `status = 'dismissed'`, so a concurrent change cannot turn it into a silent reopen of something the user actually finished.

**Only a dismissal is undone.** `undismissFinding` answers `INVALID_REQUEST` for a resolved finding: resolution asserts the problem was dealt with and ADR-004's protective-actions factor has already credited it. Undo is unbounded — no window, no expiry job — because these are the user's own records and a timer would be timing-dependent to test and hostile to anyone slower than it.

**Dismissal is not audited.** ADR-006's inventory covers resolution only; the ATL-042 amendment says so explicitly. The panel states the score consequence before the user confirms rather than after — ADR-004 keeps the full deduction until the underlying condition clears, and a user who dismisses expecting an improvement has been misled by silence.

### PrivacyScoreService

- calculateScore _(ATL-044)_
- explainScore _(ATL-046)_
- createSnapshot _(ATL-045)_
- compareSnapshots _(not built; nothing in ATL-044–046 needs it)_
- compactSnapshots, deleteDemoSnapshots _(ATL-045; retention and the ATL-083 demo purge)_

**ATL-046 implementation notes.** `explainScore` is the score detail view's single read, and it is read-only — the route has no Server Action, no mutation, and writes no snapshot. It returns three things kept deliberately separate: the **current** score, calculated now; the **history**, which is what was recorded before; and the **delta**.

**The current score is never read from a snapshot.** ATL-045 writes nothing at cold start and no marker when a scored user returns to it, so the newest snapshot can outlive the records it described. Presenting it as the current score would be a number about services that no longer exist, which is why the type separates the two and the route renders the cold-start state as authoritative with history below it.

**The delta compares the two most recent snapshots**, not the current score against the latest one. Write-on-change means the latest snapshot is normally identical to the current score, so `current − latest` would be an arithmetic identity permanently reading "no change". `latestScoreChange` (`src/lib/score/score-history.ts`) therefore compares `history[0]` with `history[1]` and withholds the delta entirely in two cases: fewer than two recorded scores, and two entries carrying different `score_version`s — subtracting across model versions would present two different measurements as one movement, which ADR-004's "never recomputed" rule forbids. The copy names the day (*"Changed from 52 to 56 on 12 August"*) rather than saying "previous period", because snapshots are event-driven and no period exists.

**The route is `/overview/score`**, nested rather than a seventh navigation destination: PRD §12 and frontend §3 fix the seven items, and `findActiveNavItem` matches on `pathname.startsWith`, so Overview stays selected with no navigation change. ATL-021 owns the entry point and depends on ATL-046, so until it lands the route is reachable by URL — a temporary link would be a second thing to remove.

**Honesty rules the UI enforces**, each backed by copy in `src/lib/score/score-copy.ts` and by a test: the open-findings row says the count includes dismissed findings, because the deducting population is `open + in_progress + dismissed`; the protective-actions row says "findings **you** resolved" and states that findings which cleared automatically are not counted; an excluded factor renders "Not enough information" and **no digit at all**, never 100; every history row carries its own `score_version`; and the demo label appears in the summary, the breakdown and each demo history row. Improvement actions come from a fixed factor → route map (`improvement-actions.ts`) reused by ATL-021 and ATL-047 — no impact ranking, which would compete with ATL-039's recommendation order, and no link to requests, which do not exist.

### FindingsEngine (see §11)

- evaluateRules
- generateFindings
- autoResolveFindings
- runNightlySweep

### PersonalFieldService

- listMasked _(ATL-105; the default read)_
- save _(ATL-105)_
- edit _(ATL-105)_
- remove _(ATL-105)_
- reveal _(ATL-105; the only plaintext path)_
- markUsed _(ATL-105; no production caller until ATL-058)_
- isStoragePermitted _(ATL-105; the consent gate, readable by callers)_
- getApprovedFieldsForDraft _(not built; deferred to ATL-058 with the approval step it depends on)_

Renamed from `PersonalFieldsService` and re-specified against what ATL-105 implemented. The previous list named `listFields`, `upsertField` and `deleteField`, omitted `reveal` — which frontend §15 and ATL-106 both require — and included `getApprovedFieldsForDraft`, which ATL-105 must not build. The names below encode the properties that matter at the call site rather than leaving them to a reader's assumption.

**`listMasked` is the default read path and never returns plaintext.** Masking happens inside the method, so there is no way to obtain a full value through it at all — the same construction as `AssetService.readMaskedAccountIdentifier`, and the reason that method is not called `readAccountIdentifier`. A useful mask requires the plaintext (`a•••@example.com` cannot be derived from ciphertext), so the method decrypts, masks, and discards. It is deliberately **not** consent-gated: reading back what is already stored is not a new act of storage, and gating it would hide a person's own data from them the moment they revoked.

**`reveal` is the deliberate plaintext path and is audited.** The only method here that returns a stored value in full. It emits `personal_field.revealed` (security §8, ADR-006) — the event `asset-service.ts` already uses for the equivalent action on an account identifier — after the value is obtained, so the record never claims a disclosure that failed. The context carries `reason` and `method` only.

**`save` and `edit` are gated; `remove` and the reads are not.** Both writes require an existing `personal_fields_storage` consent and answer `CONSENT_REQUIRED` without it. The service **never records consent**: consent is a user action, not a side effect of persistence, so `ConsentService` stays the single source of truth and the consent flow (ATL-106) owns the recording. `remove` is ungated on purpose — deletion is the safe direction, and a gate there would stop a person removing the very values their revocation was about (ADR-002, security §14).

**`markUsed` exists now, but ATL-058 is its first production caller.** It stamps `last_used_at` from the database clock (ATL-113) on the fields an approved draft included. Nothing calls it today, because the only thing that *uses* a field is a request draft; the seam is implemented and tested rather than deferred so the column has a maintainer the moment drafting lands, and no write is manufactured to make it look busy.

**Personal-field retrieval for AI and request drafting remains gated by explicit per-request approval.** ATL-105 created the storage; it did not make any value eligible to send. ADR-002 makes approval — not storage — the thing that permits a value to leave, and the approval step is ATL-058. `policy-map.ts` still supplies no stored values to `draft_request`, `includedPersonalFieldKeys` is still `[]`, and ATL-050's subset check already fails closed on anything a model claims beyond what was approved.

`CONSENT_REQUIRED` was added to `API_ERROR_CODES` for this (ATL-105); the union had no variant for it, and `FORBIDDEN` means "not yours" — a condition no user action resolves — where this means "not yet agreed", which a consent prompt does.

### NotificationService

- createNotification (server-only)
- listNotifications
- markRead
- markAllRead

### RequestService

- createDraft
- updateDraft
- transitionStatus
- markSent
- scheduleFollowUp
- completeRequest
- cancelRequest

### AssistantService

- answerQuestion
- explainFinding
- suggestNextAction
- draftRequest (deletion or correction)

### AuditWriter (server-only, see ADR-006)

- record
- verifyChain

## 10. API and server-action conventions

- Authenticate before reading body data when possible.
- Validate every input with Zod.
- Return typed error codes, not raw provider errors.
- Use idempotency keys for transitions and export jobs.
- Paginate collections.
- Enforce entity ownership in service layer and RLS.
- Never accept `user_id` from the client as authority.
- Avoid exposing internal record identifiers in logs.

Example response envelope:

```json
{
  "data": {},
  "error": null,
  "requestId": "uuid"
}
```

Implemented in `src/lib/api/response-envelope.ts` (ATL-086). It lives in `lib/` rather than `server/` so the client can narrow on `code` when rendering a failure — a duplicated copy of the codes for the UI is how a client ends up branching on a code the server stopped sending. `ApiErrorCode` is a closed union: a free-string code cannot be exhaustively handled, and architecture §10's "typed error codes, not raw provider errors" leaves no variant to smuggle a provider message into. `message` is calm, human-readable, and safe to display; callers branch on `code`.

Error example:

```json
{
  "data": null,
  "error": {
    "code": "REQUEST_INVALID_TRANSITION",
    "message": "This request cannot move from completed to sent."
  },
  "requestId": "uuid"
}
```

## 11. Findings engine and privacy score

### 11.1 Findings rule engine (ADR-001)

Findings are generated by a deterministic, versioned rule engine that evaluates the user's own records. No internet scanning, no external integrations, no AI generation. AI may explain findings but cannot create, modify, or resolve them.

**Architecture**

- Rules are pure server-side functions in a versioned catalog (`rules-v1`). Each rule declares: `rule_id`, category, input record types, predicate, severity mapping, confidence mapping, evidence template, and recommended action.
- **Triggers:** mutations to assets, permissions, data categories, or requests enqueue a per-user recompute job; a nightly sweep evaluates time-based predicates (staleness). Evaluation is idempotent.
- **Deduplication:** `dedup_key = hash(rule_id + sorted entity IDs in scope)`, unique per user. A rule fires once per condition.
- **Auto-resolution:** when a predicate no longer holds, the engine resolves the finding with `resolved_by = system` and records an activity event.
- **Dismissals:** a dismissed finding is not re-raised for the same `dedup_key` unless the rule inputs materially change (input hash changes).
- **Demo data:** rules run over demo records only in demo mode; resulting findings carry `source_type = demo` and are removed with demo data.

**Rule catalog v1 (finding categories)**

| Rule                              | Category    | Predicate (summary)                                                    | Severity                                             |
| --------------------------------- | ----------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| R-001 stale_review                | hygiene     | Active asset not reviewed in 180 days                                  | low (medium after 365 days)                          |
| R-002 inactive_account_with_data  | hygiene     | Asset status inactive with ≥1 data category                            | medium (high if a high-sensitivity category)         |
| R-003 sensitive_data_active       | exposure    | Active asset holds financial, health, biometric, or location data      | low (medium at 3+ sensitive categories on one asset) |
| R-004 broad_permission            | permissions | Active permission with broad scope                                     | medium                                               |
| R-005 stale_permission            | permissions | Active permission not verified in 365 days                             | low                                                  |
| R-006 archived_asset_data_remains | exposure    | Archived asset still lists data categories and has no deletion request | medium                                               |
| R-007 rejected_request_unresolved | requests    | Request rejected with no follow-up action for 30 days                  | low                                                  |
| R-008 category_concentration      | exposure    | Same high-sensitivity category held by 5+ active assets                | medium                                               |

**Confidence model:** confidence is derived, not asserted. Base confidence comes from input source (`manual` recent = high, `demo` = labeled demo). Staleness degrades it: inputs older than 180 days cap confidence at medium; older than 365 days cap it at low. A rule's finding confidence is the minimum across its inputs.

**Evidence model:** `evidence_refs_json` stores the evaluated record IDs; `evidence_summary` is rendered from the rule's template using only non-restricted values (service name, category, dates, counts). `source_reference` records `rule_id@rule_version`.

**Lifecycle:** open → in_progress → resolved (by user or system) or dismissed. Resolution and dismissal write activity events; state changes feed score recalculation.

**ATL-101 implementation notes.** The catalog lives in `src/lib/findings/rules/` and is **pure**: each rule receives a snapshot (`RuleInputs`, including an injected `now`) and returns candidates. No rule reads a database, a clock, or another rule's output, which is what makes ADR-001's table-driven tests possible and keeps query logic out of rule logic. The engine (`src/server/findings/findings-engine.ts`) owns everything else — loading the snapshot, hashing dedup keys, deciding what is new, writing rows, auto-resolving, and emitting activity and score recalculation.

**Seven rules ship, not eight.** R-007 (`rejected_request_unresolved`) reads `data_requests`, which §7.7 specifies but no migration creates; a rule registered against a table that does not exist could never fire, and a rule that cannot fire is indistinguishable from a broken one. It lands with the M8 ticket that creates the table. R-006 ships evaluating the conjunct it can see: "archived asset still lists data categories". Its second conjunct, "and has no deletion request", is satisfied for every asset while no request can exist, so the conclusion is what §11.1 describes rather than a simplification — the conjunct and a `rules-v1` → `rules-v2` bump arrive with the table, which ADR-001 already requires to be recorded on generated findings.

**Recompute runs in-process.** `EngineFindingsRecomputeQueue` replaces ATL-030's no-op behind the same seam, so mutations evaluate synchronously and no call site changed. No queue table, runner, or transport is introduced: none is specified anywhere, and inventing durable infrastructure is the decision ATL-030 deliberately declined to make. This is safe here because the engine is idempotent by construction — every evaluation reconciles the full candidate set against stored findings by dedup key, so running twice changes nothing the first run did not. `runNightlySweep` is a callable server-only entry point for a scheduling ticket to invoke, not a scheduler.

**Demo isolation happens in the engine, not the rules.** The snapshot is partitioned before evaluation: if the user has demo assets, those are what the catalog sees and the resulting findings carry `source_type = demo`. A rule therefore cannot mix demo and real records even by accident, and never has to know demo mode exists (§11.1, §11.2). `ScoreRecalculationQueue`'s reason vocabulary gained `finding.changed`, which §11.2 already named as a trigger and which predated findings existing.

**ATL-102 implementation notes.** Re-fire suppression compares an `input_hash` stored on the finding against one recomputed from the current snapshot. What is hashed is the **material field values of the records the candidate cited** — an asset's `status`, `last_verified_at` and `source_type`; a permission's `scope`, `status` and `last_verified_at`; a category's `category` and `sensitivity` — projected by the engine from the snapshot it already holds. §11.1 says *inputs*, so outputs are excluded: hashing severity would stay silent about a broad permission revoked and re-granted, which changes the inputs while leaving the conclusion identical. The ATL-101 rule contract is unchanged; rules still report only which records they read.

**Time is deliberately not in the hash.** A user who dismisses a finding and then lets the record age further does not get it back — the passage of time is not a change to their records. It returns when a value they own actually moves. Dismissal is the one place Atlas overrides an explicit "I have dealt with this", and it should take a real change to their data to do so. Service names, category labels and creation dates are excluded for the same reason: renaming a service is not a change in exposure.

**A null hash means unknown, not unchanged.** Findings predating the column are left in whatever state the user put them, and the engine records a hash without touching the status, so the ambiguity resolves once per finding and never resurrects a deliberate dismissal.

**A returning condition reopens the existing row.** ATL-038's `unique (user_id, dedup_key)` makes a second row impossible, which is the right shape: ADR-004 counts open findings, so a condition that returns restores one deduction rather than accumulating two. Reopening clears `resolved_by` and `resolved_at` — the check constraint refuses an open finding that still names a resolver — and refreshes severity and confidence, both of which are derived from the inputs that just changed.

### 11.2 Privacy score design (ADR-004)

The score is deterministic, versioned (`score-v1`), and 0–100. AI may explain it but cannot set it.

**Factors and weights**

| Factor                     | Weight | Input                                                                                                                       |
| -------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| Account hygiene            | 25     | 60%: share of active assets reviewed within 180 days; 40%: share of inactive assets addressed (archived or request started) |
| Open findings              | 25     | 100 − (critical 40 + high 25 + medium 10 + low 4 per open finding), floor 0                                                 |
| Data sensitivity footprint | 20     | 100 − 10 per active-asset × high-sensitivity-category pair, floor 40                                                        |
| Permission exposure        | 15     | 100 × (1 − broad active permissions ÷ total recorded permissions)                                                           |
| Protective actions         | 10     | +10 per resolved finding, +20 per completed request, trailing 180 days, cap 100                                             |
| Verification freshness     | 5      | Share of assets verified within 365 days                                                                                    |

**Rules**

- Factors with no underlying records are excluded and weights renormalized; the factor breakdown records exclusions and the UI shows score coverage.
- **Cold start:** no score until the user has at least one non-demo asset; the UI shows a "Not yet scored" state and no snapshot is written.
- **Demo mode:** score computed exclusively over demo records, always labeled "Demo score," snapshot flagged `is_demo`, deleted with demo data. Demo and real records never mix in one calculation.
- Dismissed findings retain their full deduction until the underlying condition clears (auto-resolve). Dismissal alone never improves the score.
- Weights, deductions, and thresholds are versioned configuration; any change requires a new `score_version`. Snapshots store the version and factor-level inputs and are never recomputed.
- Recalculation triggers: asset/permission/category mutations, finding state changes, request completion, demo-data changes, nightly sweep. A snapshot is written only when score or breakdown changes.
- Snapshot retention: full history for 90 days, then compacted to one snapshot per day.

- **Factor edge cases** — which population each factor counts, what zero records means for each of them, rounding, demo isolation and cold start — are fixed by ADR-004's "factor edge cases" amendment, signed off before ATL-044. No weight, deduction or threshold changed, so `score-v1` did not move.

**ATL-045 — write-on-change, compaction, and the recalculation seam.**

`PrivacyScoreService.createSnapshot(userId, reason)` calculates, compares against the latest stored snapshot, and writes only on a difference. **The comparison uses no floating-point value.** A factor's `value` and `normalisedWeight` are floats, and comparing them would make two calculations over identical records differ on floating-point noise and write a snapshot on every mutation — defeating the rule. Rounding them to N places would be a tolerance. Instead the fingerprint (`src/lib/score/fingerprint.ts`) compares `score` (an integer, already rounded once), `scoreVersion`, `isDemo`, and per factor its `id`, `excluded` flag and integer `inputs`. Every factor value is a pure function of those inputs, the `score-v1` constants and the version, so identical inputs imply identical values: equality is exact by construction rather than by approximation. A stored breakdown that cannot be parsed answers "different", so the service writes — a redundant snapshot is noise compaction removes, while a skipped one is a hole in the history.

**Cold start and failed calculations write nothing**, and no synthetic terminal marker is created when a scored user returns to cold start. Consumers must therefore read *current state* rather than assume the latest snapshot is current.

**Compaction** (`compactSnapshots(now, batchSize)`) keeps full history for 90 days, then one snapshot per UTC day, keeping the **latest** in each day — the state the user ended it in. It is application-side rather than a SQL function: "keep the last per day" needs a window function PostgREST cannot express, and keeping the rule in TypeScript keeps it in one testable place instead of splitting it between the application and a function only real Postgres can exercise. Batched and resumable, and idempotent — a second pass finds nothing left to drop. `deleteDemoSnapshots(userId)` is the persistence capability ATL-083 wires into demo removal.

**The seam is now real.** `SnapshotScoreRecalculationQueue` replaces `NoopScoreRecalculationQueue` in `AssetService.create()`, `FindingService.create()` and `FindingsEngine.create()`, recalculating **in-process** inside the mutating request — ATL-101's precedent, and safe for the stronger reason that the calculation is a pure function of the user's records, so a duplicate call is turned into a no-op by write-on-change. `AssetService.create()` passes the *same instance* into the `FindingsEngine` it constructs inline, so that engine does not fall back to the no-op default. Every call site already wraps `enqueue` in its own try/catch, and the queue itself never throws: a failure degrades to a stale score rather than a failed mutation, and is logged as `score.recalculation_failed`.

**ATL-104 was evaluated and deliberately not used.** ATL-045 declares a dependency on the idempotency helper, and it does not fit. `runIdempotent` needs a key that is stable across retries of one invocation and distinct between separate ones. The score fingerprint fails the second test — keying on it would suppress a legitimate return to a previous score (56 → 60 → 56) inside the 24-hour TTL, losing a real event from the user's history. Nothing at these call sites carries a request or mutation id to key on instead: `ScoreRecalculationRequest` holds only `{userId, reason}`, and `requestId` is explicitly a request-scoped concern the service layer does not know. There is also no retry path to protect — each caller invokes the seam once, logs a failure and moves on. **Write-on-change is the idempotency mechanism**, and it satisfies ADR-004's "recalculation is idempotent" directly: recalculating without a change writes nothing. The residual is that two concurrent mutations can each see a change and write adjacent identical snapshots; compaction removes them and no user-visible number is wrong.

**ATL-047 — the score history chart.** Hand-written inline SVG in a server component, not a charting library: one series of at most twenty points does not justify a dependency, a bundle and a hydration step to draw a polyline. `recharts` remains installed and unused. `ChartContainer` (`src/components/ui/chart-container.tsx`) is design system §16's primitive, kept deliberately minimal — heading, text alternative, `aria-describedby` wiring, layout — with no data, scales or geometry, so a second chart decides what is genuinely shared rather than inheriting a guess.

**The graphic is `aria-hidden`, and the summary is the representation.** ATL-046's history list and the trend summary already state every value as text, so exposing the SVG too would mean a second, worse accessibility model for identical data. That places the whole burden on `summariseTrend` (`src/lib/score/score-trend.ts`), which is why it carries direction, score range, time span, how many scores were recorded, demo status, and — across versions — an explicit non-comparability statement.

**Three rules keep the picture honest**, all decided in `lib/` rather than in the component: points are positioned by their **actual `recorded_at`**, never evenly spaced, because snapshots are written on change and equal spacing would assert equal intervals; the y axis is fixed to **0–100** rather than the observed range, so a two-point movement is not drawn as a dramatic one; and the series is **split into a segment at every `score_version` change**, so no polyline can span two models — the break is structural, not a rule the component must remember, and it is explained in words beneath the chart. Degenerate cases resolve explicitly: a single point or a set sharing one instant sits at the midpoint, and an unparseable timestamp never produces `NaN` geometry.

**No motion at all.** ATL-047 requires reduced motion to be respected and the chart introduces none, so the global `prefers-reduced-motion` rule has nothing to suppress. Tests assert the *absence* of animation elements, animation classes and inline transitions rather than the presence of a suppression rule — adding an entrance animation in order to disable it would be motion invented for the sake of turning it off.

**Worked example:** see ADR-004 for a fully computed example (result ≈ 56).

## 12. AI architecture

```mermaid
sequenceDiagram
    participant U as User
    participant UI as Atlas UI
    participant S as Assistant Service
    participant R as Data Retriever
    participant P as Policy Layer
    participant M as AI Provider

    U->>UI: Ask question or request draft
    UI->>S: Structured request
    S->>P: Classify purpose and allowed data
    P->>R: Request minimal authorized records
    R-->>P: Redacted context
    P->>M: Prompt plus schema
    M-->>P: Structured output
    P->>P: Validate, filter, confidence checks
    P-->>S: Approved result
    S-->>UI: Explanation or editable draft
```

### AI requirements

- Server-side calls only.
- No secret keys in browser code.
- Prompt templates are version-controlled.
- Outputs must match a schema.
- Reject or retry malformed responses.
- High-impact claims require evidence references.
- Sensitive values are omitted unless essential and user-approved.
- Provider failures return a non-AI fallback.

### 12.1 The gateway (ATL-048)

Implemented as three modules in `src/server/ai/`, split by what each is allowed to know.

**`gateway.ts` imports no SDK.** The provider sits behind `AiProviderClient`, and `anthropic-client.ts` is the only module in the repository that names a vendor. That split is what lets the retry, timeout and classification logic be unit-tested against a stub with no key, no network and no vendor error class — and it makes a second provider a new file rather than an edit to logic every AI surface depends on. The lint boundary already forbids `src/features` from importing `src/server/ai` at all.

**The SDK's own retries are switched off.** `@anthropic-ai/sdk` defaults to `maxRetries: 2` and a ten-minute timeout. Left alone those *compose* with the gateway's policy rather than replacing it — two gateway attempts, each internally retried twice, is up to six provider calls per request, arriving precisely during the outage that caused the failure. The client is therefore constructed with `maxRetries: 0`, and the deadline is the gateway's own `AbortSignal`: two competing timers would make whichever fired first arbitrary.

**Timeout 30s per attempt, 2 attempts total, retrying only timeout, 429 and 5xx.** The retryable set is a `ReadonlySet` rather than a `switch`, so a kind added without a retryability decision is not retried by default. A non-429 4xx is never retried — it will fail identically and only spends money and latency to prove it.

**Backoff is exponential with full jitter.** Without jitter every client that failed against one provider incident retries at the same instant, and the storm lands when the provider is least able to absorb it. `sleep` and `random` are injected so the wait is asserted rather than waited for.

**Two error vocabularies, deliberately.** `AiFailureKind` is internal and distinguishes a timeout from an outage from an Atlas-side defect; `ApiErrorCode` stays closed and receives only `RATE_LIMITED` or `UNAVAILABLE`. `AiGatewayError` has no field capable of holding provider prose — the status is kept because it is a number. The internal code is what reaches the log sink, because an operator needs the distinction the caller must not get.

**Rate limiting is inside the gateway**, keyed on the user only. Every AI call happens in an authenticated session, so a user key always exists; an IP key would throttle a shared office as though it were one person. The limit is `aiRequest` in `RATE_LIMIT_POLICIES` (20 per 5 minutes — chosen, not derived, and overridable per environment). It **fails open** when the counter store is unreachable, matching every other surface, and logs the degradation so it is visible rather than silent.

**An empty completion is a failure, not an empty success**, and is not retried.

**Data retention is an operational prerequisite, not code.** Security §10 requires the strongest available retention mode. SDK 0.115.0 exposes no request-level retention parameter — verified by inspection — so there is nothing honest to send per call, and a field invented for the purpose would be a control that looks enforced and is not. **Anthropic organisation settings must be configured to the strongest available retention mode before production traffic**, and that step belongs to deployment rather than to the adapter.

Not in the gateway, by ticket: output schemas (ATL-050), prompt templates and versions (ATL-051), purpose classification, retrieval, redaction and the `ai_processing` consent gate (ATL-049), fallback copy (ATL-052). `ai_interactions` (§7.11) is specified but no ticket creates it; that gap is tracked as a follow-up and will block ATL-049/050.

### 12.2 The prompt registry (ATL-051)

A prompt is assembled server-side from three parts: **system policy**, **task template**, **context block**. ATL-051 owns the first two. The context block is ATL-049's — the registry returns a prompt with a place for context, never a prompt containing context.

**Nothing in the registry interpolates.** There is no function that takes a user value and returns a prompt string, because that function is how an asset note becomes an instruction. A test asserts every registered prompt is free of placeholder syntax and that the callable surface is exactly `resolvePrompt`, `registeredPrompts`, `hasPrompt` and two error classes — which makes "user data cannot reach the system policy" a property of the module rather than a rule each call site must remember.

**The system policy is versioned separately from the prompts that pin it.** It is a different contract: it carries the refusal list, the tone rules and the untrusted-data framing shared by every purpose. Inlining it per prompt would duplicate safety rules once per purpose and guarantee they drift. So `system-policy-v1.ts` is its own append-only artefact, each prompt version pins a `policyVersion`, and a prompt adopts a newer policy only by publishing a new prompt version. The pair `(promptVersion, policyVersion)` reconstructs the exact instructions behind any recorded interaction.

**Published versions are append-only, enforced mechanically.** `scripts/verify-prompts.mts` compares `src/server/ai/prompts/versions/` against a committed baseline and fails on modification or deletion; adding `slug-vN+1.ts` is the only supported change. This is the same invariant as migrations (§8) enforced the same way, for the same reason: a two-word edit to a task template reads as a typo fix, ships an unevaluated prompt, and leaves `ai_interactions` recording a version number against output that version never produced. Comparison is byte-level rather than parsed, so a reformat or a moved constant cannot slip through, and a missing git baseline is reported as a skip rather than counted as a pass.

**Only `explain_finding` has a prompt.** The other five purposes exist in the taxonomy and resolve to an error, not a default — a fallback prompt would send *something* to the provider for a purpose nobody wrote instructions for. Each remaining purpose gets its prompt from the ticket that first consumes it: `draft_request` from ATL-059, which needs ATL-058's field-approval flow before its wording can be honest.

**Versions travel with the text.** `resolvePrompt` returns `promptVersion`, `policyVersion`, `schemaId` and `schemaVersion` alongside the assembled system string. ATL-051 owns no persistence; carrying the metadata is what lets the ticket owning `ai_interactions` record what actually produced an output, without a second lookup that would eventually record one prompt's version against another prompt's output. The schema-identifier vocabulary lives in the registry so ATL-050 imports it rather than re-declaring it — the check that catches a prompt describing a field its validator does not expect.

**Evaluation is split by what can run without a provider.** Assertion-based cases — prohibited phrases, scanning and deletion claims, legal guarantees, fear language, unverified-recipient claims — are graded against recorded outputs by a pure harness in CI, which holds only a placeholder API key. Live-model evaluation is a documented pre-release step. Cases are tagged with the prompt version they grade and a published prompt with no cases fails, so a prompt nobody graded cannot ship quietly. The suite deliberately contains probe cases that *must* fail: a suite of only clean cases passes even when every rule is broken.

### 12.3 Output schemas and validation (ATL-050, partial)

Two schemas per AI behavior §7 — `explanation` and `draft` — keyed by the identifiers ATL-051 declares, imported rather than re-declared. A test asserts every `SCHEMA_IDS` entry has an implementation, which is the drift guard between the two tickets: a prompt naming a schema nobody wrote would fail validation on every call, retry once and fall back, presenting as a total outage.

**Unknown fields are stripped, not rejected.** Zod's default object behaviour. `.strict()` would spend a retry on a model that added one harmless key — a worse trade than dropping something nothing reads.

**Three failure kinds, and the difference decides what happens next.** Unparseable or wrongly shaped output is `schema_invalid` and earns exactly one repaired retry. A grounding or privacy failure is `invariant_violated` and **fails closed immediately with no retry** — a hallucinated reference or an unapproved field key is not a formatting slip, and asking again does not make it acceptable. Nothing renderable leaves the validator on failure: no raw completion, no Zod issue path, no offending value; invariant violations carry a code and a count only.

**The invariant checks are the privacy controls, not the schema.** A schema proves shape; it cannot know what was sent. `evidenceReferences` must all appear in the context block, `includedFieldKeys` must be a subset of the fields approved *in this flow* (ADR-002: storage is not permission), and every `recommendedActions[].entityId` must be owned and in context. `actionType` is enforced by the schema enum and re-asserted at the invariant layer — unreachable while the enum holds, and deliberately kept, because the schema layer retries where the invariant layer fails closed.

`entityId` uses Zod's `guid` rather than `uuid`: `uuid()` enforces RFC-4122 version and variant nibbles that Postgres's own `uuid` type does not, so it would reject identifiers the database stores and returns happily. The version nibble carries no authorisation meaning — ownership is decided by the context check.

**Fenced JSON is treated as malformed.** The system policy already says "no markdown fences"; silently stripping them would mean the policy is not a control, and the bounded repair path exists for exactly this.

**Two retries, owned by two layers.** ATL-048 retries *transport* failures inside one logical attempt; ATL-050 retries *schema-invalid content*, which is a successful call whose output was wrong. They compose, and ATL-050's own bound is exactly two provider attempts.

**The second attempt is not identical.** Temperature is 0, so re-sending byte-identical input to a deterministic model would very likely reproduce the same invalid output — a retry real in code and hollow in practice, spending a second call and a second unit of rate budget to reach the same failure. The second attempt appends the prompt's **registered** repair instruction (`PromptDefinition.repairInstruction`, ATL-051), which is fixed, version-controlled and evaluated like any other prompt text. It carries no user data, no echo of the invalid completion, and no validation-error detail — feeding the model's own output back would let text it emitted re-enter the prompt as instruction, the injection path AI behavior §10 closes. It is appended as a user turn, so the system policy stays untouched.

**The fallback seam defaults to unavailable**, in the shape ATL-045 established with `NoopScoreRecalculationQueue`: wired now, filled by ATL-052. ATL-050 authors no fallback prose.

**The recording clause is now satisfied.** `StructuredCompletionService` writes one `ai_interactions` row per interaction through an injected recorder (§7.11, task #95), carrying `output_schema_version` from the schema that actually validated the output — not from the prompt's declaration, so a drift between the two records the version that did the work. A test asserts the two agree. Exactly one row is written per interaction regardless of how many provider attempts it took, and the failure paths — fallback, unavailable, invariant violation, provider error, rate limit — are recorded too: a ledger holding only successes would misrepresent what happened. The recorder defaults to inert, so the validation pipeline stays testable without a database, and a storage failure is logged rather than failing the user's request.

### 12.4 The policy layer (ATL-049, partial)

`AiPolicyService` is **the only path from user data to the provider**. Consent, retrieval limits, redaction and fencing all live behind it, so a second entry point would be a way around all four at once — which is why `src/server/ai/policy/index.ts` deliberately does not re-export `StructuredCompletionService`.

**Consent is checked before retrieval, not before the provider call.** Reading a user's findings to build context for someone who has not consented to AI processing already moves their data toward a processor; checking first means the denial path never touches their records. `ConsentService.hasConsent` treats a grant against a superseded policy version as absent, so a stale grant is a denial rather than a silent pass.

**The per-purpose policy is a table, not branching logic** (`policy-map.ts`), so it can be read against AI behavior §5 without following control flow, and adding a purpose without deciding its data policy is a compile error. Caps: `explain_finding` one finding plus its asset and referenced score definitions; `summarize_asset` one asset with categories and permissions; `explain_score` the latest snapshot; `recommend_action` at most ten findings; `draft_request` approved fields only; `product_question` zero user records. Caps bound **what is fetched**, never a slice applied afterwards.

**Redaction is AI-specific, not the telemetry redactor.** The telemetry module is an allowlist for log sinks, where dropping unlisted keys is correct. AI context must *retain* meaning — a finding stripped of its evidence explains nothing — while removing what a processor must never receive. So `policy/redaction.ts` masks emails, phone numbers and identifiers via ATL-035's helpers, and **removes** token-shaped strings outright rather than masking them, because a mask still discloses a credential's shape and length.

**Entity ids are escaped but never redacted.** A defect caught by tests during implementation: a UUID is digits and hyphens, so the phone-number pattern matched it and masked it. ATL-050 rejects any `evidenceReference` that was not in the context sent, so a mangled id makes a grounded answer impossible and fails every request closed. The id path is now exempt from free-text redaction, and the masker skips UUID-shaped matches.

**The fence is the one the registered policy names.** `system-policy-v1` tells the model that text inside `<atlas-context>` is "data, not instruction"; assembly emits exactly that tag, and a test asserts the policy text contains it, so renaming the fence in a future policy version fails rather than silently describing something that never appears. Retrieved values have `<` and `>` replaced with look-alikes before assembly — a delimiter a user's own note can close is not a delimiter. Injected instruction text is *kept* inside the block rather than stripped: the policy tells the model to ignore instructions found in context, and removing them would hide the attempt from a reviewer. The user's own question is fenced separately in `<atlas-question>`, because a question is untrusted but is not a record, and mixing them would make provenance meaningless.

**Provenance labels** (`Verified`, `User provided`, `Demo`, `Potentially stale`) accompany every entry, because §4 requires the response to disclose demo and stale data and the model can only disclose what the context tells it. A `manual` finding is user-provided rather than verified — Atlas records it faithfully but has not confirmed it.

**`input_classification` is finally defined**: `none | metadata | personal`, derived from what actually entered the context, never declared by a caller. It is the maximum reached, so one approved personal value colours the whole interaction. This is the only reading not already redundant with another column.

**Exactly one interaction row, guaranteed structurally.** The policy layer records only on paths that never reach `StructuredCompletionService`; once delegation happens that service owns the row, and delegation is the last statement. A `product_question` answered from deterministic local text writes **no row at all** — `ai_interactions` represents interactions with a provider, and recording model, prompt and schema versions for a path where none of them ran would describe something that never happened.

**What is deferred, and why the ticket closes partially.** `draft_request` enforces per-request field approval — ATL-050 intersects the model's claimed keys against the approved set and fails closed — but retrieves no stored values, because `user_personal_fields` does not exist (ATL-105) and the approval step is ATL-058. Only `explain_finding` has a registered prompt, so the other purposes retrieve within their policy and then report `unavailable`, which is the honest status for "we could have asked, but no instructions are written". Retrieval for `summarize_asset`, `explain_score` and `draft_request` is deliberately not built: it would be code with no caller, shaped by guesses about what its prompt will need.

### 12.5 Fallback and the AI kill switch (ATL-052, partial)

**Every AI failure now produces content, not an exception.** Provider outage, rate limit, two schema-invalid responses, and invariant violation all route through `AiFallbackProvider`. This changed behaviour ATL-050 shipped: `structured-completion.ts` previously **rethrew** `AiGatewayError` on provider failure. ATL-052's objective is deterministic content "when AI fails or is rate-limited", and AI behavior §11 forbids blocking manual workflows or exposing provider errors — an escaping exception does both. The two ATL-050 tests that asserted the rethrow were rewritten to the new contract rather than deleted, and they still assert the half that did not change: the interaction is recorded before the fallback runs.

**The deterministic explanation is built from persisted finding fields** — `title`, `description`, `evidenceSummary`, `recommendedAction`, plus the evidence records `FindingService` already resolved. This satisfies "rule-based template text (from the rule catalog's evidence templates)" without touching `catalog.ts`: those templates are applied at evaluation time and rendered into `evidence_summary`, so the stored text *is* the template's output. Adding an explanation template to the catalog would have tripped its documented rule that changing any template requires bumping `RULES_VERSION` — re-stamping the provenance of findings whose logic never changed.

**The fallback carries no `confidence`, deliberately.** ATL-050's `confidence` means the *model's* certainty about its own reasoning; a deterministic explanation has no model, so any value would be fabricated, and copying the finding's rule confidence would be worse — the UI would render one as the other. The fallback is therefore a distinct type discriminated by `source: "fallback"`, sharing `summary`, `whyItMatters`, `recommendedAction` and `evidenceReferences` so one component can render both. `AiPolicyResult` exposes `source: "ai" | "fallback"` for the same reason. Low rule confidence and demo provenance are disclosed **in words** (§4), not as a number the user cannot act on.

**It answers only where deterministic source material exists.** `explain_finding` has it; the other purposes do not, and a "deterministic asset summary" would be prose nobody wrote and no rule produced. They return `null`, which surfaces as `unavailable`. While `explain_finding` is the only registered prompt this is also the only reachable case — a surface that cannot run has nothing to fail from.

**`AI_ENABLED` is an operational kill switch**, env-validated and defaulting to **true** so it changes nothing on deploy. Defaulting to false would silently disable a P0 feature in every environment that had not set it, including CI, where absence would read as a passing test rather than a missing capability. It is checked **before the consent read**: a disabled deployment performs no consent lookup, no retrieval for the AI path, and no provider call. Disabled mode still serves the deterministic explanation, with copy that says AI is *turned off* rather than *temporarily unavailable* — telling a user something is broken when an operator switched it off is a small lie, and small lies about the assistant erode trust in the rest.

**Single recording survives the new routing.** The provider-failure branch records the provider's own status (`provider_error` / `rate_limited`) and passes `alreadyRecorded` into the fallback, so one interaction still writes exactly one row — and that row describes the outage rather than relabelling it as a routine fallback.

**No second database read.** The retrieved finding travels to the fallback on `StructuredCompletionRequest.fallbackSubject`. A fallback that queried the database would add a failure mode to the path that exists precisely because something else already failed. Retrieval returns the subject alongside the context entries rather than the service holding it on a field, which would race across concurrent requests.

**One acceptance criterion is unmet.** "Draft flow offers a standard editable template; user input preserved" cannot be built: `data_requests` has no migration, `/requests` is an ATL-005 placeholder, and ATL-058/059/060 are unbuilt. There is no draft flow to offer a template into and no user input to preserve. Deferred to the Requests milestone; ATL-052 closes partially.

### 12.6 Finding explanation (ATL-055, server-side)

**ATL-055 is server-side only.** Its acceptance criteria concern output correctness — evidence references, demo labelling, stale disclosure, schema validation, no new factual claims — and its testing line names grounding and hallucination probes, not render tests. The "Ask Atlas" control stays disabled and owned by ATL-053, and the ATL-040/041 assertions that it is visibly unavailable are untouched.

**`AiPolicyRequest.userMessage` is optional.** A button-triggered surface declares a purpose rather than asking a question, and `explain-finding-v1` plus the retrieved context define the task completely. When absent, **no question block is emitted at all** — not an empty one. An empty `<atlas-question></atlas-question>` would tell the model a question was asked and then show it nothing, and a manufactured default ("Explain this finding") would be prompt text at a call site, which §12.2 forbids. A whitespace-only message counts as absent. Callers that do send a message get byte-identical behaviour to before. Conversational surfaces (ATL-053/054) keep the field.

**Low rule confidence now maps to `potentially_stale` provenance.** ATL-055 requires stale sources to be disclosed, and the model can only disclose what the context tells it — but `potentially_stale` existed in the vocabulary and was **never emitted**, so a stale finding was labelled `Verified` and the disclosure was impossible to make truthfully. ADR-001 derives confidence from source *and staleness*, so a `low` finding is exactly one whose records could not be recently verified; the signal was already on the record and no new query or column was added. **Demo takes precedence:** both labels would be accurate, but a user must never mistake demo data for their own, and "potentially stale" would imply the records are real. Medium and high confidence keep the source-derived label.

**Hallucination probes run in CI without a provider.** `finding-explanation.integration.test.ts` wires the *real* `StructuredCompletionService` — real schema, real invariants, real fallback — behind a scripted gateway, so a hallucination has to survive the actual pipeline to reach a caller. Probes cover a reference that was never sent, an entity the user does not own, an action type outside the allowlist, and an explanation citing nothing. The assertion-based prohibited-claim rules from §12.2's harness are applied to explanation fixtures for the "no new factual claims" criterion. Live-model probes stay in the pre-release step.

**What the probes now prove is stronger than refusal.** With ATL-052 wired, an invariant violation no longer yields nothing: the deterministic explanation answers instead, so the caller receives `source: "fallback"` and rule-derived text. The hallucinated content is still refused — what changed is what replaces it. It is not retried, because asking again does not make an invented citation true.

**Confidence semantics are preserved end to end.** The AI path carries `confidence` and `uncertainties` exactly as the schema defines them; the deterministic fallback carries neither, and inherits nothing. How model confidence is presented alongside the finding's own rule confidence is ATL-053's decision.

**Pre-release step (live-model evaluation).** Before releasing a prompt change: publish the new version file, point the registry at it, run `pnpm prompts:verify` and the deterministic suite, then generate fresh outputs against the candidate version for the AI behavior §13 categories that need a real completion — grounding, low-confidence disclosure, demo labelling, prompt injection, data minimisation, draft field inclusion. Record those outputs as new deterministic cases so the next release regresses against them. A regression blocks the change.

## 13. Data-request lifecycle

Applies to both deletion and correction requests.

Allowed transitions:

```text
draft -> ready
draft -> canceled
ready -> sent
ready -> canceled
sent -> awaiting_response
sent -> completed
sent -> rejected
awaiting_response -> follow_up_due
awaiting_response -> completed
awaiting_response -> rejected
follow_up_due -> sent
follow_up_due -> completed
follow_up_due -> rejected
rejected -> completed
any nonterminal state -> canceled
```

Transition semantics:

- `sent -> awaiting_response` is performed by a **system job 3 days after `sent_at`** (actor_type `system`), or immediately when the user records a response note — whichever comes first.
- `awaiting_response -> follow_up_due` is performed by the system when `follow_up_at` passes.
- `follow_up_due -> sent` means the user sent a follow-up message; a new `sent_at` is recorded.
- `follow_up_due -> rejected` covers services that reject after a follow-up.
- `rejected` is **nonterminal**: `rejected -> completed` means the user acknowledges the rejection and closes the matter; `rejected -> canceled` is permitted via the any-nonterminal rule.
- Terminal states: `completed`, `canceled`.

Transitions are validated server-side, protected by idempotency keys (§7.17), and recorded in `request_events` and `audit_events`.

## 14. Background jobs

MVP jobs:

- Generate export archive
- Delete expired exports
- Nightly findings sweep (time-based rule predicates, §11.1)
- Per-user findings recompute after relevant mutations
- Transition `sent -> awaiting_response` after 3 days (§13)
- Create follow-up reminders and follow-up-due transitions
- Create notifications (follow-up, security, new findings) and purge notifications older than 90 days
- Recalculate score after relevant events; compact snapshots older than 90 days
- Verify audit-event hash chain (ADR-006)
- Purge expired idempotency keys, sessions, and temporary data where supported
- Process account deletion workflow (including DEK destruction, ADR-003)

Jobs must be idempotent and observable.

## 15. Caching

- Do not cache user-specific sensitive responses in shared caches.
- Use private, short-lived caching only for non-sensitive derived summaries.
- Invalidate dashboard data after mutations.
- Public service directory content may use standard CDN caching.

## 16. Observability

Capture:

- Request ID
- Route and operation
- Status code
- Latency
- Error code
- Provider availability
- AI schema failures
- Job status
- RLS denial count

Never capture:

- Full names, addresses, phone numbers, emails, account identifiers
- Request body text
- AI prompt contents
- Request draft recipients, subjects, and bodies
- Personal field values
- Access tokens

### Enforcement (ATL-085)

Both lists above are enforced by `src/lib/telemetry/redaction.ts`, the central redaction utility named in security §T4. It is not advisory:

- **Allowlist, not denylist.** A key reaches a log or collector only if a policy names it and its value passes that field's shape check. The "Never capture" list therefore has no field to travel in — omitting it is structural rather than a discipline to remember.
- **Pattern scrubbing as defense in depth.** Surviving strings are additionally scanned for emails, phone numbers, and credentials. Patterns are anchored to real formats rather than resemblance: a generic "looks like a phone number" pattern matches an ISO-8601 instant, which silently destroyed every monitoring timestamp before it was caught. Precision is preferred to recall because the allowlist, not the scrub, carries the guarantee.
- **Counted, not just dropped.** Removals are returned as dotted paths so a caller quietly trying to log something new is visible without reading payloads.
- **Single entry point.** `src/lib/telemetry/logger.ts` is the only sanctioned logging call; it has no free-text `message` parameter, because interpolation is the most common way personal data reaches a log. `no-console` and a `no-restricted-syntax` rule for direct transports make bypassing it a lint failure.

## 17. Testing strategy

### Unit

- Score calculation (including renormalization, cold start, demo isolation)
- Findings rules (table-driven: predicate, severity, confidence, dedup, auto-resolve)
- Request state machine (including system transitions and idempotency)
- Encryption module (round-trip, AAD binding, wrong-key failure, crypto-shred)
- Input validation
- Redaction (central utility: allowlist, nested payloads, pattern scrubbing, lint rule; plus activity, notifications, audit context allowlist)
- AI output validation

### Integration

- Authorization and RLS (two users, every user-owned table)
- Asset CRUD
- Findings generation and auto-resolution
- Request transitions
- Personal fields lifecycle (create, use in draft, delete)
- Notifications creation and read state
- Audit writer immutability (UPDATE/DELETE rejected) and chain verification
- Export generation
- Account deletion (including DEK destruction and audit survivors)

### End-to-end

- Sign in and onboarding
- Add asset
- Review finding
- Generate and edit deletion draft
- Mark request sent
- Export data
- Delete account

### Security

- Cross-user record access
- IDOR attempts
- RLS bypass
- Injection
- Stored XSS
- CSRF where applicable
- Rate limiting
- Secret exposure

## 18. Deployment environments

- Local
- Preview
- Staging
- Production

Each environment uses separate projects, keys, databases, and storage. Production data must never be copied to lower environments.

## 19. CI/CD gates

Required checks:

- Formatting
- Lint
- Type check
- Unit tests
- Integration tests
- Production build
- Migration validation
- Dependency and secret scanning
- Security tests for changed policies
- Accessibility smoke tests

## 20. Architecture decision records

Major decisions are documented in `docs/adr/`:

- ADR-001 Findings engine
- ADR-002 Personal fields
- ADR-003 Encryption strategy
- ADR-004 Privacy score
- ADR-005 Notifications
- ADR-006 Audit logging

## 21. Architecture decisions deferred

- Whether to use Supabase Edge Functions or a dedicated worker for scheduled tasks
- Rate-limit store provider (Vercel KV vs Upstash vs equivalent)
- Whether to support direct email sending after MVP
- Email delivery channel timing for notifications (see `docs/open-questions.md`)
- Vector retrieval provider, if needed
- Connector framework
- Regional data residency (see `docs/open-questions.md` — launch-blocking if EU users are in scope)
