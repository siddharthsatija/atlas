---
name: database
description: Atlas PostgreSQL schema conventions, naming, indexes, foreign keys, UUID strategy, soft deletes, audit tables, migration rules, and query performance. Use when adding or changing schema, writing migrations, or reviewing data access performance.
---

# Atlas Database

**Sources of truth:** `docs/02-technical-architecture.md` §7–8 (data model and rules), `docs/03-security-and-access.md` §7–8 (RLS and encryption). ADR-003 governs encrypted columns; ADR-006 governs the audit table.

## Purpose

Keep the schema correct, secure, and evolvable under an append-only migration rule where mistakes are permanent.

## Core principles

1. **Migrations are append-only after shared deployment.** Names and shapes must be right the first time.
2. Every user-owned table has `user_id` and RLS. Deny by default.
3. Foreign keys must make cross-user relationships impossible.
4. Restricted text is encrypted at the application layer and is therefore unqueryable.
5. Audit data must not become a second sensitive dataset.
6. Demo records are always separable from real records.
7. Prefer deletion over soft deletion unless recovery or audit genuinely requires retention.

## Naming conventions

| Object           | Convention                  | Example                                       |
| ---------------- | --------------------------- | --------------------------------------------- |
| Table            | plural, snake_case          | `digital_assets`, `data_requests`             |
| Column           | singular, snake_case        | `service_name`, `follow_up_at`                |
| Encrypted column | `_encrypted` suffix         | `body_encrypted`, `value_encrypted`           |
| JSON column      | `_json` suffix              | `factor_breakdown_json`, `evidence_refs_json` |
| Timestamp        | `_at` suffix, `timestamptz` | `created_at`, `resolved_at`, `destroyed_at`   |
| Boolean          | `is_`/`has_` prefix         | `is_demo`, `has_completed`                    |
| Foreign key      | `<singular_table>_id`       | `asset_id`, `request_id`                      |
| Index            | `idx_<table>_<columns>`     | `idx_digital_assets_user_status`              |
| Constraint       | `<table>_<rule>`            | `data_requests_status_valid`                  |
| Policy           | `users_<action>_own`        | `users_read_own`                              |

Naming lesson already learned: `deletion_requests` became `data_requests` before the first migration because the MVP supports correction requests too. Think about the second use case before naming.

## UUID strategy

- All primary keys are UUIDs — they avoid enumeration and make IDOR attempts non-guessable (threat T1).
- Generate in the database with a default; do not accept client-supplied IDs for new records.
- UUIDs may appear in internal contexts (URLs for owned entities, `ai_interactions.records_referenced`, audit `entity_id`) but never in external logs or telemetry sinks (architecture §16).
- Prefer UUIDv7-style time-ordered values if available, since random v4 primary keys fragment index locality on high-insert tables (`activity_events`, `notifications`, `audit_events`). Document the choice once and apply it consistently.

## Column and type conventions

- `timestamptz` always; never naive timestamps. Store UTC, convert at the edge using the profile timezone.
- Enumerated values: use a check constraint or a Postgres enum, and keep it aligned with the TypeScript union. A value permitted in code but not the database (or vice versa) is a defect.
- `numeric` for exact values; never `float` for a score. The privacy score is an integer 0–100.
- JSON columns are validated with Zod at the repository boundary — the database only guarantees it is JSON.
- `not null` by default; nullable columns need a documented reason (`asset_id` on findings is nullable because account-level findings exist).
- Defaults for `created_at`/`updated_at`; `updated_at` maintained by trigger or repository, consistently.

## Foreign keys

- Every FK has an explicit `on delete` behavior chosen deliberately: `cascade` for records that cannot exist without the parent (asset categories, permissions, request events), `restrict` where orphaning should be prevented, `set null` only where the child is meaningful alone.
- **Composite FKs for cross-user safety:** child tables reference `(parent_id, user_id)` against a parent unique key so a row cannot point at another user's parent.
- FK columns are always indexed (Postgres does not do this automatically).

## Indexes

Index for the queries the product actually runs:

| Table                     | Index                                                                     | Serves                                |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| `digital_assets`          | `(user_id, status)`, `(user_id, category)`, `(user_id, last_verified_at)` | asset list filters, rule R-001        |
| `privacy_findings`        | `(user_id, status, severity)`, unique `(user_id, dedup_key)`              | insights views, dedup guarantee       |
| `data_requests`           | `(user_id, status)`, `(user_id, follow_up_at)`                            | request list, follow-up job           |
| `activity_events`         | `(user_id, occurred_at desc)`                                             | timeline pagination                   |
| `notifications`           | `(user_id, read_at, created_at desc)`                                     | unread count and panel                |
| `privacy_score_snapshots` | `(user_id, recorded_at desc)`                                             | history and latest score              |
| `audit_events`            | `(subject_ref, occurred_at)`                                              | chain verification, incident response |
| `idempotency_keys`        | unique `(user_id, scope, idempotency_key)`                                | duplicate suppression                 |

Rules:

- Never index an encrypted column — it cannot be searched and the index leaks nothing useful.
- Partial indexes for skewed predicates (e.g. `where read_at is null` for unread notifications).
- Verify with `explain analyze` on realistic row counts, not on ten seed rows.
- Every index has a justifying query; remove speculative indexes (write cost is real).

## Soft deletes

Atlas prefers hard deletion (architecture §8). Use status-based retention only where the product requires recovery or audit:

- **Archive is a status, not a soft delete** — `digital_assets.status = 'archived'` is a user-facing state with restore.
- Dismissed findings retain their row because the score and re-fire logic depend on it (ADR-001/004).
- Everything else deletes. Do not add a `deleted_at` column "just in case" — it creates a second copy of sensitive data with unclear lifecycle.
- Where a row must persist for audit, keep the audit record in `audit_events` (pseudonymous, allowlisted) rather than retaining the sensitive row.

## Audit and internal tables

- `audit_events`: RLS enabled with **no client policies**; application role granted INSERT and SELECT only; no UPDATE/DELETE ever issued. Pseudonymous `subject_ref` (HMAC), allowlisted `context_json`, `prev_hash`/`event_hash` chain (ADR-006).
- `user_encryption_keys`: service-role only, no client policies. Holds wrapped DEKs and `kek_version`; `destroyed_at` records crypto-shredding.
- Neither table has a `user_id` FK to auth users by design — deletion must be able to leave pseudonymous evidence behind.

## Migration rules

- **Append-only after shared deployment.** No renames, no destructive column changes, no re-typing in place.
- One logical change per migration; reviewed alongside its RLS policies.
- Forward-only expand/contract for changes that would otherwise be breaking: add the new column, backfill idempotently, switch reads, stop writing the old one. Removal, if ever, is a separate deliberate migration.
- New table checklist: `user_id` (or documented exception), RLS enabled, four policies, FK constraints with cross-user protection, indexes for FKs and known filters, two-user tests, generated types updated.
- Never put production data in seeds or tests; demo data is per-user and labeled `source_type = 'demo'`.
- Migration validation runs in CI (ATL-004) and must detect non-append-only edits.

## Query performance

- Cursor pagination (keyset) for timelines: `where (user_id, occurred_at, id) < (…)`. Offset pagination degrades and can skip rows during inserts.
- Avoid N+1 across repositories: fetch related records in one query with an explicit join or a batched `in` lookup.
- The dashboard uses one aggregated query (ATL-019), not several round trips.
- Decrypt only what is displayed. Do not decrypt a list of bodies to render statuses.
- Keep transactions short; use them for multi-record state transitions (request transition plus event plus score trigger).
- Set statement timeouts on user-facing paths so a pathological query fails fast rather than hanging a request.

## Common mistakes

- Adding a table without RLS, or without two-user tests.
- Forgetting `user_id` on a child table because ownership is inferable.
- A plain `asset_id` FK that permits pointing at another user's asset.
- Unindexed foreign keys.
- Indexing or filtering an encrypted column.
- `float` for the score, or a naive `timestamp` column.
- Enum drift between the database constraint and the TypeScript union.
- `deleted_at` added by reflex, creating an ambiguous second dataset.
- Offset pagination on activity, then surprise at duplicates and slowness.
- Renaming a column after shared deployment.
- Seeding realistic-looking personal data that is actually production-derived.

## Decision framework

**New table or new column?** New table when the concept has its own lifecycle, cardinality, or access rules. Column when it is an attribute of an existing row.

**Hard delete or status?** Status only if the user can restore it or the score/rules depend on it. Otherwise delete.

**Encrypted or plaintext?** Restricted per security §3 → encrypted, and accept it is unqueryable. If a search requirement appears, escalate rather than weakening the control.

**Index or not?** Name the query it serves and the expected row count. No query, no index.

**Enum in the database or code only?** Both, kept in sync, with a check constraint as the backstop.

**Breaking change needed?** Expand/contract forward-only. Never edit a deployed migration.

## Review checklist

Full version in `checklists.md`. Fast pass:

- [ ] `user_id` present; RLS enabled with all four policies; two-user tests written
- [ ] FKs indexed and cross-user-safe (composite where needed)
- [ ] Indexes justified by real queries; none on encrypted columns
- [ ] Types correct (`timestamptz`, integer score, enum constraints matching code)
- [ ] Append-only migration; names final; validated in CI
- [ ] No production data in seeds; demo rows labeled
- [ ] Pagination is keyset for growing collections
