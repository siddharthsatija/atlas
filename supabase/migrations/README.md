# Migrations

**Empty by design.** No migration exists yet: schema work begins at milestone M3
(`ATL-084` encryption keys) and M5 (`ATL-027` digital assets). See
`.claude/implementation-order.md` for why security infrastructure precedes any table
that stores restricted data.

## The rule that shapes everything

**Migrations are append-only after shared deployment** (`docs/02-technical-architecture.md`
§8, `CLAUDE.md`). A deployed migration is never edited, renamed, or reversed. Get names
and shapes right the first time — `deletion_requests` became `data_requests` before the
first migration precisely because renaming later would be impossible.

## Naming

```
YYYYMMDDHHMMSS_short_snake_case_description.sql
20260801120000_create_user_encryption_keys.sql
```

One logical change per migration.

## Every migration that creates a user-owned table must include

1. `user_id uuid not null references auth.users (id) on delete cascade`
   (documented exceptions: `profiles` uses `id`; `audit_events` and
   `user_encryption_keys` have no client access and no FK to auth users)
2. `alter table ... enable row level security;`
3. All four policies — select, insert, update, delete — **in the same migration**.
   A table whose policies land later is a security defect, not a follow-up.
4. Composite foreign keys `(parent_id, user_id)` where cross-user safety matters
5. Indexes for every foreign key and every filter the product actually uses
6. Check constraints matching the TypeScript unions exactly

## Backward compatibility

Each migration must be safe against the **currently deployed** application version:
migrations run before the new version serves traffic, and application rollback must
remain safe with the new schema in place (`.claude/skills/deployment/SKILL.md`).

Breaking changes use **expand / contract**, forward-only:

1. Add the new column (nullable or defaulted)
2. Backfill idempotently, in bounded batches
3. Switch reads in application code
4. Stop writing the old path
5. Contract later, in its own deliberate migration

## Automated validation

`pnpm db:validate-migrations` runs as a required CI gate (ATL-004) and diffs this
directory against the pull request's base branch. It fails on:

| Rule | Meaning |
| --- | --- |
| `migration-modified` | A migration that already exists in the base was edited |
| `migration-deleted` | A committed migration was removed |
| `migration-inserted-out-of-order` | A new migration sorts before the latest committed one |
| `invalid-filename` | Not `YYYYMMDDHHMMSS_snake_case.sql` |
| `duplicate-timestamp` | Two migrations share a timestamp, making order ambiguous |
| `table-without-rls` | `create table` without `enable row level security` in the same migration |
| `table-without-policies` | RLS enabled but no policy, and no declared deny-all intent |

Content rules apply to **new** migrations only: a committed migration cannot be
edited without violating append-only, so it is never re-reported.

Internal tables that intentionally have RLS with no client policies
(`audit_events`, `user_encryption_keys` — ADR-006) must declare that intent:

```sql
-- rls: deny-all (internal table; server-only writer, ADR-006)
```

## Before opening the PR

- [ ] Two-user RLS tests written (`supabase/tests/`) and added to the completeness list
- [ ] `pnpm db:validate-migrations` passes
- [ ] `pnpm db:reset` succeeds from scratch
- [ ] `pnpm db:types` regenerated
- [ ] Reviewed by `database-engineer` and `security-engineer`
