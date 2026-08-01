# ADR-006: Audit Log Architecture

**Status:** Accepted
**Date:** 2026-07-29
**Related:** `03-security-and-access.md` §12, `02-technical-architecture.md` §7.15, §7.9, ATL-103

## Problem

The security spec mandates append-oriented, access-controlled audit logs for security events (sign-ins, exports, deletions, transitions, consent changes) but defines no storage, schema, or retention mechanics. `activity_events` cannot serve this purpose: it is user-owned, user-visible, and deleted with the account — an audit log that the audited party can erase is not an audit log. The relationship between the two was undefined, risking either duplication of sensitive data or a missing compliance record.

## Options considered

1. **Reuse `activity_events` for both purposes.** Rejected: conflicting lifecycles (user deletion vs. compliance retention), conflicting audiences (user timeline vs. security review), and pressure to add sensitive detail to a user-visible table.

2. **External log sink only (provider logs / SIEM).** Rejected for MVP: no queryable structure for incident response, retention controlled by provider tier, and export/deletion evidence needs first-party durability. Provider logs remain a complementary layer.

3. **Dedicated internal `audit_events` table, service-role only, append-only.**
   **Accepted.**

## Decision

- **Storage:** `audit_events` table in PostgreSQL. Not client-accessible: RLS enabled with **no policies for any client role** (deny all); writes go through a single server-only audit writer module using the service role. No UPDATE or DELETE is ever issued by application code; the database role used by the app for this table is granted INSERT and SELECT only.
- **Schema:** `id`, `occurred_at`, `event_type`, `subject_ref` (pseudonymous stable hash of user ID, HMAC-keyed), `entity_type`, `entity_id`, `actor_type` (`user`, `system`, `operator`), `context_json` (allowlisted keys only: policy/score/prompt versions, request IDs, statuses, counts), `prev_hash`, `event_hash`.
- **Immutability:** append-only by privilege design; each event carries `event_hash = hash(prev_hash + canonical event)` forming a per-subject hash chain so tampering or deletion is detectable. (Chain verification is a periodic job; this is tamper-evidence, not tamper-proofing — honest about the threat model.)
- **Content rules:** never store raw personal identifiers, request bodies, AI prompts, tokens, or export contents. The audit writer enforces a key allowlist; unknown keys are dropped and counted as a telemetry warning.
- **Event inventory (MVP):** auth security events, export requested/downloaded/expired, account deletion initiated/completed, request state transitions, consent granted/revoked, DEK creation/destruction, operator elevation, sensitive-value reveal actions.
- **Retention:** 90-day rolling window, purged by job. **Deletion survivors:** after account deletion, only events required as completion evidence (deletion initiated/completed, DEK destroyed, consent record of the deletion request) are retained for the 90-day window under the pseudonymous `subject_ref`; the HMAC key mapping is not reversible to identity once the auth record is gone.
- **Relationship with Activity:** `activity_events` is the user-facing, redacted product timeline — owned by the user, shown in the UI, deleted with the account. `audit_events` is the internal security record — invisible to users, pseudonymous, retention-bound. Services emit both where an action is user-meaningful and security-relevant (e.g., a request transition), from a single call site so the two cannot drift.

## Rationale

- Separating audiences resolves the lifecycle conflict cleanly and keeps each table's content rules simple.
- Pseudonymous subject references plus an allowlisted context keep the audit log from becoming a second sensitive dataset — an explicit security objective.
- Hash chaining is cheap and turns "append-oriented" from an intention into a verifiable property.

## Tradeoffs

- Some duplication of event emission (activity + audit). Mitigated by a shared emitter API.
- 90-day retention may be short for some compliance regimes; jurisdictional retention needs are an open question (OQ-06) and the window is a config value.
- Database-resident audit logs share fate with the database. Provider log streaming remains enabled as a secondary copy of security-relevant application logs.

## Consequences

- New table `audit_events`, audit-writer module, chain-verification job; ticket ATL-103.
- Security spec §12 rewritten with this design; account deletion flow documents surviving events.
