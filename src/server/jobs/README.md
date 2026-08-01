# Background jobs

Jobs required for the MVP are listed in `docs/02-technical-architecture.md` §14.

## Every job must be

- **Idempotent** — running twice leaves the same state. Use idempotency keys or
  predicate-based updates (`where status = 'sent' and follow_up_at <= now()`).
- **Bounded** — batched, so one large account cannot starve the queue.
- **Observable** — reports start, success, failure, retries, duration (ATL-096);
  repeated failure alerts.
- **Resumable** — long jobs (export generation, DEK rotation) checkpoint progress.
- **Timezone-correct** — follow-up dates compute in the user's profile timezone,
  never server local time.
- **Redacted** — job logs pass the same allowlist as everything else.
- **Attributed** — jobs that change user-visible state emit activity/audit events
  with `actor_type = 'system'` so the user can see why something changed.

Nothing external is ever sent from a job (security §11).

Runtime choice (Supabase Edge Functions vs a dedicated worker) is a deferred
architecture decision — architecture §21.
