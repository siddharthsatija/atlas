# Audit

Two distinct records with different audiences, lifecycles, and content rules — ADR-006.

|            | `activity_events`            | `audit_events`                                           |
| ---------- | ---------------------------- | -------------------------------------------------------- |
| Audience   | The user                     | Security and incident response                           |
| Access     | RLS-owned, visible in the UI | No client access; server-only writer                     |
| Subject    | `user_id`                    | Pseudonymous HMAC `subject_ref`                          |
| Lifecycle  | Deleted with the account     | 90-day retention; only deletion evidence survives        |
| Mutability | Normal table                 | Append-only: INSERT/SELECT privileges only, hash-chained |

## Modules (ATL-103)

| File                                              | Responsibility                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `audit-event.ts`                                  | Event inventory, HMAC `subject_ref`, context allowlist, canonical form, hashing |
| `audit-writer.ts`                                 | The only writer. Chain append with retry, plus the shared `emitEvent` call site |
| `chain-verification.ts`                           | Tamper-evidence job                                                             |
| `../repositories/audit-event-repository.ts`       | Data access. Exposes no update or delete method                                 |

## The shared emitter

Both records are written from **one call site** so they cannot drift (completed
by ATL-069):

```ts
await emitEvent({
  audit: { userId, eventType, actorType, entityType, entityId, context },
  activity: { userId, type, params, entityType, entityId, metadata }, // optional
});
```

`activity` is optional. Some audited events — DEK destruction, operator
elevation — are security records with no user-facing counterpart, so omitting it
is a deliberate statement rather than a default.

### Ordering, and why it is not atomic

PostgREST cannot open a transaction, so these are two independent inserts and a
partial failure is unavoidable rather than a bug to be fixed. The ordering is the
design:

1. **Audit first, and its failure propagates.** The value of the log is that its
   absence means the event did not occur.
2. **Activity second, best effort.** A missing timeline row is cosmetic; failing
   a completed operation because the timeline insert failed would turn a display
   problem into a data problem, and a timeline outage would take the product
   down.

The failure is logged at error level with a count, so "best effort" is
*observably* best effort.

### Summaries are composed, never accepted (ATL-069)

`ActivityWriter` takes an event type and typed parameters; the template in
`src/lib/activity/activity-events.ts` produces the sentence. **No parameter
accepts free text.** A service holding a recipient address cannot put it in a
summary by accident — the most it can do is pass `maskedIdentifier`, having
masked it with `src/lib/formatting/mask.ts` first, and the writer verifies that
value really is masked.

Three guards run before storage: unknown event types are rejected, metadata
passes the ATL-068 allowlist, and the composed sentence is scanned for restricted
patterns. The scan runs against a control sentence with the masked identifier
substituted out — a masked email keeps its domain and so still matches an email
pattern, and a naive scan would reject the one case ATL-069 explicitly permits.

## Content rules

Never recorded in either table: raw request bodies, full personal identifiers, AI
prompts, export contents, tokens, sensitive query parameters. The audit writer
enforces a context-key allowlist built on the ATL-085 redaction utility; unknown
keys are dropped and counted, and the count is logged without the values.

## Chain mechanics

`event_hash = sha256(canonical(event including prev_hash))`, per subject, with a
64-zero genesis for the first event.

Two properties are enforced in the database rather than assumed:

- **`(subject_ref, prev_hash)` is unique.** Concurrent writers that read the same
  tail cannot both extend it, so the chain cannot silently fork. The loser
  retries against the new tail.
- **UPDATE and DELETE are refused** by grant and by trigger. The trigger also
  binds owner and superuser connections, which grants never restrict.

Verification walks the **links**, not the timestamps. Ordering by `occurred_at`
looks equivalent and is not: the column is millisecond-resolution, so two events
can tie and fall back to a random UUID, which produced tamper alerts on
untouched chains. A verification job with false positives gets muted, and a muted
job detects nothing.

This is tamper **evidence**, not tamper-proofing (ADR-006). It cannot detect the
removal of a subject's entire chain — provider log streaming remains the
secondary copy for that.

## Deferred: retention purge and deletion survivors

ADR-006 specifies a 90-day rolling purge, and that only deletion-completion
evidence survives account deletion. **Neither is implemented, and neither can run
against the table as it stands** — DELETE is refused by grant and by trigger for
every role.

That is deliberate. Erasing audit history is the most damaging operation this
table allows, so it should cost a reviewed migration rather than being reachable
from whatever credential a job holds. ATL-082 (M11) owns both, and will need a
follow-up migration opening a narrow path — e.g. a `SECURITY DEFINER` function
that removes only rows past the retention window. The window itself stays a
config value (ADR-006 tradeoffs, OQ-06), so it is not hardcoded in SQL here.

Tickets: ATL-103 (schema and writer), ATL-069 (activity writer).
