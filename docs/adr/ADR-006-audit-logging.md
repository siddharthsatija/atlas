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
- **Event inventory (MVP):** auth security events, export requested/downloaded/expired, account deletion initiated/completed, request state transitions, consent granted/revoked, DEK creation/destruction, operator elevation, sensitive-value reveal actions, **finding resolution by a user (`finding.resolved`)**, **AI conversation history destruction (`ai.history_cleared`, ATL-109)**.
  - `ai.history_cleared` is an amendment to this inventory, taken deliberately rather than by widening the list quietly — as `finding.resolved` was. It records irreversible destruction of user content, which §12 audits; and `consent.revoked` alone would not cover it, because consent is a decision while deletion is an act. Recording only the decision would leave no evidence that the obligation it triggered was discharged. Context carries a count and never message content.

  **Amendment (ATL-042).** `finding.resolved` was not in the original inventory. It is added deliberately rather than by widening the list quietly: ATL-042 requires a user's resolution of a privacy finding to be auditable, and a closed inventory that omitted it would have forced either an unaudited action or an ad-hoc event type. Its scope is narrow and stated here so it cannot expand by precedent:

  - **Only a user resolution.** The findings engine's auto-resolution (`resolved_by = 'system'`) is *not* audited — nobody acted, and ADR-004 already distinguishes the two.
  - **Dismissal is not covered.** A dismissal records a decision, not a fix; whether it warrants an audit event is ATL-043's to decide.
  - **Context is the existing allowlist, unchanged.** `toStatus`, `reason` (the resolution action, drawn from a closed vocabulary whose ids satisfy the `reason` pattern by construction), and `ruleVersion`. No new key was added to `AUDIT_CONTEXT_POLICY` for this event, and the finding's title, description and evidence never appear.
  - **Entity:** `entity_type = "finding"`, `entity_id` = the finding's id.

- **Post-commit audit failure policy (ATL-042).** Where an audit event describes a state change that has already committed, the event is written **after** the change, and its failure does not roll the change back.

  PostgREST cannot open a transaction, so a mutation and its audit write are two separate transactions and a partial failure is unavoidable rather than a defect to be fixed. Ordering is therefore the design, and it differs by direction:

  - **Before the fact** (`emitEvent`, ATL-103): the audit write comes first and its failure propagates, because the caller can still abandon the action.
  - **After the fact** (a committed status change): the audit write comes last. By the time it runs the change is durable, so reporting failure to the user would be false, and they could not retry it in any case — a resolved finding is terminal. The change stands, the failure is logged at error level (`audit.write_failed`, with no personal data), and nothing is reverted.

  The tradeoff is accepted explicitly: a gap in the trail is a worse record but a better outcome than reverting a completed user action because a secondary write failed. The failure is never swallowed silently — the log line is the only place a missing record can be noticed at all, and chain verification will not detect it, because an event that was never written breaks no link.
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
