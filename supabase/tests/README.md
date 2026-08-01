# Database tests

Two-user authorization matrix — **ATL-088**.

## Why this exists separately

RLS is the last line of defense for cross-user isolation (threat T1). It cannot be
verified by reading policy SQL; it must be exercised by a second user attempting
access. A single-user test proves nothing.

## Required per user-owned table

For every table, with two distinct authenticated users:

| Attempt                                 | Expected         |
| --------------------------------------- | ---------------- |
| User B selects User A's row             | no rows returned |
| User B updates User A's row             | rejected         |
| User B deletes User A's row             | rejected         |
| User B inserts a row with `user_id = A` | rejected         |
| User A operates on their own row        | succeeds         |

For internal tables (`audit_events`, `user_encryption_keys`): **all** client access
denied, and `audit_events` additionally rejects UPDATE and DELETE from the
application role (ADR-006).

## Completeness guard

The matrix is generated from the schema, not hand-maintained, so a new table
without tests fails CI. See the pattern in `.claude/skills/testing/examples.md`.

## Running

```bash
pnpm db:start
pnpm test:integration
```

Fixtures are synthetic and obviously so. No production data, ever.
