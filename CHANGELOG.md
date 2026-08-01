# Atlas Documentation Changelog

## 1.1.0 — 2026-07-29

Documentation hardening pass following the pre-implementation review. Goal: a production-ready specification implementable without major ambiguity. No application code, migrations, or scaffolding — documentation only.

### Added

**Findings generation engine** (ADR-001; architecture §11.1; PRD FR-05)
The MVP previously had no mechanism that produced findings — the core loop was hollow for real users. Added a deterministic, versioned rule engine (catalog `rules-v1`, rules R-001–R-008) with defined confidence and evidence models, dedup, auto-resolution, and demo isolation. New tickets ATL-101/102.
_Why:_ delivers real product value without internet scanning, preserves explainability (NFR-06), keeps AI out of the source-of-truth path.

**Personal fields architecture** (ADR-002; architecture §7.13; PRD FR-13; security §4; frontend §10, §15)
Drafts referenced "user-approved fields" that had no storage. Added an encrypted, consent-gated, just-in-time-collected `user_personal_fields` vault with per-field deletion and per-request approval. New tickets ATL-105/106.
_Why:_ makes FR-08's field-level inclusion implementable while honoring data minimization; onboarding still collects nothing sensitive.

**Encryption specification** (ADR-003; security §8; architecture §7.16)
Replaced the one-line encryption mandate with a full design: AES-256-GCM envelope encryption, per-user DEKs wrapped by an environment KEK, bound AAD, an authoritative encrypted-column inventory, rotation procedures, crypto-shredding on account deletion, and an explicit non-searchability rule for encrypted fields.
_Why:_ ATL-084 was an XL ticket with no design — the highest technical-debt risk; crypto-shredding materially strengthens the deletion promise.

**Privacy score specification** (ADR-004; architecture §11.2; PRD FR-06; frontend §5.2, §12)
Defined `score-v1`: six factors with fixed weights, missing-data renormalization with visible coverage, cold-start ("Not yet scored") and demo-mode ("Demo score") behavior, recalculation triggers, snapshot write-on-change and compaction, and a worked example. Snapshots gain `score_version` and `is_demo`.
_Why:_ the product's most visible number was previously uncomputable from the spec.

**Notifications system** (ADR-005; architecture §7.14; PRD FR-14; frontend §4.1)
The top-bar control and settings toggles had no backing system. Added an in-app notifications model with unread state, server-only creation, per-type preferences (security not disableable), 90-day purge, and a channel-agnostic design for later email delivery. New tickets ATL-107/108; ATL-066 promoted to P0.
_Why:_ follow-up reminders are the value of request tracking; in-app keeps restricted-adjacent content inside the authenticated surface.

**Audit log architecture** (ADR-006; architecture §7.15; security §12)
Added an internal `audit_events` table: deny-all client policies, pseudonymous HMAC subject references, context-key allowlist, append-only privileges, per-subject hash chaining, 90-day retention, and defined deletion survivors. Clarified the split from user-facing `activity_events`. New ticket ATL-103.
_Why:_ "append-oriented and access-controlled" was an intention without a design; an audit log the audited party can delete is not an audit log.

**Supporting additions**

- `idempotency_keys` table and helper (ATL-104) — idempotency was required but had no storage.
- `ai_conversations`/`ai_messages` (consent-gated, encrypted) — the settings toggle had no schema (ATL-109).
- `profiles.onboarding_state_json` and `selected_categories` — onboarding persistence had nowhere to save.
- Optional TOTP MFA as P1 (ATL-110). **Documented scope addition:** Atlas aggregates a user's full digital footprint; with magic-link auth the email account was a single point of compromise.
- Rate limiting now names its infrastructure requirement (shared durable store) in the stack.
- Baseline light/dark palette values in design system §2.1 so ATL-008 can start.
- Defined `consent_type` values and consent gating for AI processing, personal-fields storage, and conversation history.

### Changed

**Feature ticket backlog rewritten** (05)
All 100 tickets now have real objectives, explicit dependencies, specific acceptance criteria, and testing requirements, ordered into milestones M0–M12. Ten tickets added (ATL-101–110). Priority changes: ATL-029 (permissions schema) P1→P0 (feeds rules and score), ATL-066 (follow-ups) P1→P0.
_Why:_ identical boilerplate criteria and "TBD" dependencies made the backlog unimplementable despite the README claiming tickets define build order.

**Request model** (architecture §7.7, §13; PRD FR-08; frontend §9–10; AI behavior §5)

- `deletion_requests` → `data_requests` with `request_type` (deletion, correction) — the PRD, asset detail, and request list all referenced correction requests the schema couldn't represent. Renamed now because migrations are append-only after shared deployment.
- `recipient` and `subject` are now encrypted (`recipient_encrypted`, `subject_encrypted`) — they are Restricted data (email addresses, personal identifiers); storing them plaintext contradicted the classification.
- State machine completed: `sent → awaiting_response` trigger defined (system job at 3 days or user response note), `follow_up_due → rejected` added, `rejected` explicitly nonterminal with documented close semantics.
- MVP recipient is user-entered and labeled unverified; "verified recipient" and jurisdiction templates correctly attributed to Phase 2 (AI behavior §5 updated).
- Mailto handoff: ~1,800-character safety threshold with copy-path guidance (silent truncation risk).

### Fixed (contradictions resolved)

1. **Dashboard metrics row:** PRD implied five cards (score + four metrics including "recent changes"); frontend spec mandated four. Resolved: four cards, change context lives inside cards and the activity preview. (PRD FR-03, frontend §5.2, ATL-022.)
2. **Plaintext recipient/subject vs. Restricted classification:** resolved via encryption (above).
3. **Correction requests referenced but unrepresentable:** resolved via `request_type`.
4. **`profiles` violated the "every table has `user_id`" rule:** documented as the explicit `auth.uid() = id` exception (architecture §7.1/§8, security §7).
5. **`ai_interactions.records_referenced` vs. "no identifiers in logs":** clarified — it is an authorized, RLS-protected disclosure table, not a log (architecture §7.11).
6. **AI behavior assumed Phase 2 assets (verified recipients, jurisdiction templates) in MVP flows:** corrected to user-entered recipient with unverified labeling.
7. **Onboarding persistence required but unstorable:** `onboarding_state_json` added.
8. **Conversation-history setting with no storage or deletion semantics:** schema + consent gating + disable-deletes defined.
9. **Notification control/settings with no notification system:** system added.
10. **Audit mandate with no storage and a user-deletable stand-in:** dedicated architecture added.
11. **AI refusal list gap:** drafting to individual people (rather than services) added as refused (AI behavior §9).
12. **Score behavior for empty/demo accounts undefined:** cold-start and demo states specified end to end (model, card states, detail view).

### Affected documents

`README.md` · `docs/01-product-requirements.md` · `docs/02-technical-architecture.md` · `docs/03-security-and-access.md` · `docs/04-frontend-specification.md` · `docs/05-feature-ticket-list.md` · `docs/06-design-system.md` · `docs/07-ai-behavior.md` · `docs/adr/ADR-001…006` (new) · `docs/open-questions.md` (new) · `CHANGELOG.md` (new)

### Not decided here

Product decisions with multiple valid answers are recorded in `docs/open-questions.md` (EU launch scope, request jurisdictions, disputed-finding score fairness, notification email timing, audit retention by jurisdiction, provider selections, pre-auth demo, monetization).

## 1.0.0

Initial documentation package.
