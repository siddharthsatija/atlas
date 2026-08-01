# Audit

Two distinct records with different audiences, lifecycles, and content rules — ADR-006.

|            | `activity_events`            | `audit_events`                                           |
| ---------- | ---------------------------- | -------------------------------------------------------- |
| Audience   | The user                     | Security and incident response                           |
| Access     | RLS-owned, visible in the UI | No client access; server-only writer                     |
| Subject    | `user_id`                    | Pseudonymous HMAC `subject_ref`                          |
| Lifecycle  | Deleted with the account     | 90-day retention; only deletion evidence survives        |
| Mutability | Normal table                 | Append-only: INSERT/SELECT privileges only, hash-chained |

## The shared emitter

Both are written from **one call site** so they cannot drift:

```ts
await emitEvent({
  userId,
  activity: { type, entityType, entityId, summary }, // redacted, user-facing
  audit: { eventType, entityType, entityId, context }, // allowlisted keys only
});
```

## Content rules

Never recorded in either table: raw request bodies, full personal identifiers, AI
prompts, export contents, tokens, sensitive query parameters. The audit writer
enforces a context-key allowlist and drops unknown keys.

Ticket: ATL-103 (schema and writer), ATL-069 (activity writer).
