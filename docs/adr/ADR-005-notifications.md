# ADR-005: Notifications System

**Status:** Accepted
**Date:** 2026-07-29
**Related:** `02-technical-architecture.md` §7.14, `04-frontend-specification.md` §4, §15, FR-11, ATL-107/108

## Problem

The top bar has a notification control, Settings manages notification preferences, and follow-up reminders depend on notifying users — yet no notifications data model, unread state, or delivery channel existed anywhere. The transactional email provider was scoped only to authentication and system notices.

## Options considered

1. **Email-only notifications.** Reuse the transactional provider.
   Cons: puts follow-up reminders (which reference services and requests) into email, a lower-control channel for restricted-adjacent content; no unread state for the in-app control; requires email content redaction design immediately.

2. **In-app only for MVP, with a model designed for later email delivery.**
   **Accepted.**

3. **Full multi-channel (in-app + email + digest) at MVP.** Rejected: scope; the MVP has no engagement data to justify digest design.

## Decision

**MVP scope: in-app notifications only**, plus the security-related emails the auth provider already sends (magic links, and login notifications where supported).

- **Data model:** `notifications` table — `id`, `user_id`, `type` (`follow_up_due`, `request_status`, `security`, `finding_new`, `system`), `title`, `body` (redacted: service names and statuses allowed; no personal values, no draft text), `entity_type`, `entity_id`, `read_at`, `created_at`. RLS-owned, standard pattern.
- **Unread state:** `read_at IS NULL`. Top-bar control shows unread count (capped display "9+"), opens a panel listing recent notifications with entity links. Actions: mark read (on open or explicit), mark all read. Opening a linked entity marks its notification read.
- **Delivery:** notifications are created server-side by services and background jobs (follow-up job, findings sweep, security events). No client-initiated creation. Realtime push is optional polish (Supabase Realtime on the user's own rows); polling on navigation is the accepted baseline.
- **Preferences:** per-type toggles in Settings → Notifications (follow-up reminders on by default; new-finding notices on by default; product updates off by default per existing spec). Security notifications cannot be disabled.
- **Retention:** notifications older than 90 days are purged by a background job; all are deleted with the account.
- **Future expansion:** email delivery becomes a per-type opt-in rendered from the same rows with a stricter redaction pass; push arrives with native apps (Phase 3). The `type` enum and entity linkage are designed so channels are additive.

## Rationale

- In-app keeps restricted-adjacent content inside the authenticated surface, requires no new redaction pipeline for launch, and gives the existing top-bar control real behavior.
- Follow-up reminders — the reason request tracking has value — get a concrete delivery mechanism, letting ATL-066 move to P0.
- The model is channel-agnostic, so adding email later is a delivery concern, not a schema migration.

## Tradeoffs

- Users who don't return to Atlas won't see follow-up reminders. Accepted for MVP and recorded as the primary argument for early email opt-in post-launch (open question OQ-07 tracks timing).
- A notifications table adds one more user-owned table to the RLS test matrix. Acceptable, standard pattern.

## Consequences

- New table + tickets ATL-107 (schema/service) and ATL-108 (UI); ATL-066 (follow-up reminders) promoted to P0 and now depends on ATL-107.
- Frontend spec gains a Notifications panel section; Settings → Notifications semantics defined.
