# Repositories

The only layer that touches the database client.

## Rules

- One repository per table or tightly coupled group
- Parameterized queries only; no string-built SQL
- Every read scoped by `user_id`; every write sets it from the verified session
- Encryption and decryption happen here (ADR-003) — services deal in plaintext
  domain objects, repositories deal in ciphertext columns
- Return domain types; provider row types never escape this layer
- Keyset (cursor) pagination for anything that grows: activity, notifications,
  requests, findings
- **Never** filter, sort, join, or index on an encrypted column, and never store a
  plaintext copy of a restricted value for searchability
- Decrypt only what will be displayed — never a page of bodies to render statuses

Generated database types live in `src/types/database.generated.ts` (`pnpm db:types`)
and stop here.
