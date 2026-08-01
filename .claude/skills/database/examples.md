# Database Examples

## 1. New user-owned table, complete

```sql
create table public.user_personal_fields (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references auth.users (id) on delete cascade,
  field_key text not null,
  label text not null,
  value_encrypted text not null, -- AES-256-GCM, never queried
  last_used_at timestamptz,
  created_at timestamptz not null default now (),
  updated_at timestamptz not null default now (),
  constraint user_personal_fields_key_valid check (
    field_key in (
      'full_name',
      'email',
      'phone',
      'address',
      'username',
      'other'
    )
  )
);

create index idx_user_personal_fields_user on public.user_personal_fields (user_id);

alter table public.user_personal_fields enable row level security;

create policy "users_read_own" on public.user_personal_fields for
select
  using (auth.uid () = user_id);

create policy "users_insert_own" on public.user_personal_fields for insert
with
  check (auth.uid () = user_id);

create policy "users_update_own" on public.user_personal_fields for
update using (auth.uid () = user_id)
with
  check (auth.uid () = user_id);

create policy "users_delete_own" on public.user_personal_fields for delete using (auth.uid () = user_id);
```

## 2. Cross-user-safe child foreign key

```sql
-- Parent exposes a composite unique key
alter table public.digital_assets add constraint digital_assets_id_user_unique unique (id, user_id);

-- Wrong: child can point at another user's asset
-- asset_id uuid not null references public.digital_assets (id)
-- Right: composite FK makes cross-user references impossible
create table public.asset_data_categories (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references auth.users (id) on delete cascade,
  asset_id uuid not null,
  category text not null,
  sensitivity text not null,
  created_at timestamptz not null default now (),
  updated_at timestamptz not null default now (),
  constraint asset_data_categories_asset_same_user foreign key (asset_id, user_id) references public.digital_assets (id, user_id) on delete cascade
);

create index idx_asset_data_categories_asset on public.asset_data_categories (asset_id);

create index idx_asset_data_categories_user_category on public.asset_data_categories (user_id, category);
```

## 3. Findings dedup guarantee

```sql
create table public.privacy_findings (
  id uuid primary key default gen_random_uuid (),
  user_id uuid not null references auth.users (id) on delete cascade,
  asset_id uuid, -- nullable: account-level findings exist
  rule_id text,
  rule_version text,
  dedup_key text not null,
  severity text not null,
  confidence text not null,
  status text not null default 'open',
  evidence_summary text not null,
  evidence_refs_json jsonb not null default '[]',
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now (),
  updated_at timestamptz not null default now (),
  constraint privacy_findings_severity_valid check (severity in ('low', 'medium', 'high', 'critical')),
  constraint privacy_findings_status_valid check (
    status in ('open', 'in_progress', 'resolved', 'dismissed')
  ),
  constraint privacy_findings_resolved_by_valid check (
    resolved_by is null
    or resolved_by in ('user', 'system')
  )
);

-- One open finding per condition per user (ADR-001)
create unique index uniq_privacy_findings_user_dedup on public.privacy_findings (user_id, dedup_key);

create index idx_privacy_findings_user_status_severity on public.privacy_findings (user_id, status, severity);
```

## 4. Internal table with no client access

```sql
create table public.audit_events (
  id uuid primary key default gen_random_uuid (),
  occurred_at timestamptz not null default now (),
  event_type text not null,
  subject_ref text not null, -- HMAC of user id; no FK, survives deletion
  entity_type text,
  entity_id uuid,
  actor_type text not null check (actor_type in ('user', 'system', 'operator')),
  context_json jsonb not null default '{}', -- allowlisted keys only
  prev_hash text,
  event_hash text not null
);

create index idx_audit_events_subject_time on public.audit_events (subject_ref, occurred_at);

alter table public.audit_events enable row level security;

-- Deliberately no policies: all client access denied.
revoke
update,
delete on public.audit_events
from
  authenticated,
  anon;

grant insert,
select
  on public.audit_events to atlas_app_role;
```

Immutability test:

```ts
it("rejects updates and deletes on audit_events", async () => {
  const e = await auditWriter.record({ eventType: "export_requested", subject: user.id });
  await expect(appRole.update("audit_events", e.id, { event_type: "x" })).rejects.toThrow();
  await expect(appRole.delete("audit_events", e.id)).rejects.toThrow();
});
```

## 5. Partial index for unread notifications

```sql
-- Unread count is the hot query; index only the rows it touches
create index idx_notifications_unread on public.notifications (user_id, created_at desc)
where
  read_at is null;
```

## 6. Keyset pagination, not offset

```ts
// Wrong: slows down and can duplicate or skip rows as new events arrive
db.from("activity_events")
  .select("*")
  .eq("user_id", userId)
  .order("occurred_at", { ascending: false })
  .range(offset, offset + 24);

// Right: keyset cursor on an indexed, tie-broken ordering
db.from("activity_events")
  .select("*")
  .eq("user_id", userId)
  .or(
    `occurred_at.lt.${cursor.occurredAt},and(occurred_at.eq.${cursor.occurredAt},id.lt.${cursor.id})`,
  )
  .order("occurred_at", { ascending: false })
  .order("id", { ascending: false })
  .limit(25);
```

## 7. Transaction for a multi-record state transition

```ts
await db.transaction(async (tx) => {
  const updated = await tx.updateRequestStatus(userId, requestId, "sent", {
    sentAt,
    expectedFrom: "ready",
  });
  if (!updated) throw new DomainError("REQUEST_INVALID_TRANSITION", "…");

  await tx.insertRequestEvent({
    userId,
    requestId,
    fromStatus: "ready",
    toStatus: "sent",
    actorType: "user",
  });
  await tx.upsertIdempotencyResult(userId, "request_transition", idempotencyKey, updated);
});

// Score recalculation and notifications are enqueued after commit, not inside the transaction
await enqueueScoreRecalculation(userId);
```

## 8. Expand/contract instead of a rename

```sql
-- Migration N: expand
alter table public.data_requests
add column follow_up_at timestamptz;

-- Migration N+1: idempotent backfill
update public.data_requests
set
  follow_up_at = legacy_followup
where
  follow_up_at is null
  and legacy_followup is not null;

-- Migration N+2 (later, deliberate): stop writing legacy_followup in code first,
-- then contract in its own reviewed migration.
```

## 9. Enum kept in sync with TypeScript

```ts
export const REQUEST_STATUSES = [
  "draft",
  "ready",
  "sent",
  "awaiting_response",
  "follow_up_due",
  "completed",
  "rejected",
  "canceled",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
```

```sql
constraint data_requests_status_valid check (
  status in (
    'draft',
    'ready',
    'sent',
    'awaiting_response',
    'follow_up_due',
    'completed',
    'rejected',
    'canceled'
  )
)
```

```ts
// Drift guard
it("database status constraint matches the TypeScript union", async () => {
  expect(await fetchCheckConstraintValues("data_requests_status_valid")).toEqual(
    expect.arrayContaining([...REQUEST_STATUSES]),
  );
});
```
