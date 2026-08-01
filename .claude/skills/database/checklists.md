# Database Review Checklist

## New table

- [ ] `user_id` column present (or documented exception: `profiles`, `audit_events`, `user_encryption_keys`)
- [ ] RLS enabled
- [ ] Policies for select, insert, update, delete (or deliberate deny-all for internal tables)
- [ ] Two-user tests written and passing
- [ ] `created_at` and `updated_at` present unless documented otherwise
- [ ] Generated TypeScript types updated
- [ ] Table and column names final (append-only rule; no future renames)

## Columns and types

- [ ] `timestamptz` for all timestamps; no naive timestamps
- [ ] Integer for the privacy score; no floats for exact values
- [ ] Enumerated values constrained in the database and matching the TypeScript union
- [ ] `not null` unless nullability is documented
- [ ] Encrypted columns use the `_encrypted` suffix
- [ ] JSON columns use the `_json` suffix and are Zod-validated at the repository

## Foreign keys

- [ ] Every FK has a deliberate `on delete` behavior
- [ ] Child tables use composite FKs `(parent_id, user_id)` where cross-user safety matters
- [ ] Every FK column is indexed
- [ ] No FK from an internal audit/key table to auth users (must survive deletion)

## Indexes

- [ ] Each index names the query it serves
- [ ] Filters used by the product are covered (status, category, severity, follow-up date, unread)
- [ ] Unique index enforces `(user_id, dedup_key)` for findings and idempotency keys
- [ ] Partial indexes used for skewed predicates
- [ ] No index on an encrypted column
- [ ] `explain analyze` checked against realistic row counts

## Encryption interaction

- [ ] Restricted text stored encrypted per the security §8 inventory
- [ ] No query, filter, sort, join, or index touches an encrypted column
- [ ] No plaintext duplicate of a restricted value exists for searchability
- [ ] Decryption limited to values actually displayed

## Deletion semantics

- [ ] Hard deletion preferred; status retention justified where used
- [ ] No reflexive `deleted_at` column
- [ ] Cascades verified: deleting a parent leaves no orphans
- [ ] Account deletion sweep confirms the table is empty afterward
- [ ] Audit evidence retained in `audit_events`, not by keeping sensitive rows

## Migrations

- [ ] Append-only; no edits to deployed migrations
- [ ] One logical change per migration
- [ ] RLS policies reviewed in the same change
- [ ] Backfills are idempotent and resumable
- [ ] Breaking changes use expand/contract, forward-only
- [ ] CI migration validation passes
- [ ] No production data in seeds or fixtures; demo rows labeled `source_type = 'demo'`

## Performance

- [ ] Keyset pagination for growing collections (activity, notifications, requests)
- [ ] No N+1 across repository calls
- [ ] Dashboard served by a single aggregated query
- [ ] Transactions short and used for multi-record transitions
- [ ] Statement timeout applies on user-facing paths
- [ ] Write amplification considered before adding another index
