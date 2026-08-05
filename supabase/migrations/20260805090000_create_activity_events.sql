-- ATL-068 · activity_events
--
-- The user-facing product timeline. Architecture §7.9, PRD FR-09, frontend §13,
-- ADR-006 (which defines how this differs from `audit_events`).
--
-- APPEND-ONLY: this migration adds a table and touches nothing that came before.
-- The profiles, user_encryption_keys, audit_events, idempotency_keys, and
-- consents migrations and their policies are untouched.
--
-- ## Not the audit log
--
-- ADR-006 separates the two deliberately, and the distinction drives every
-- decision below. This table is **the user's**: they can read it, it is shown in
-- the UI, and it is deleted with their account. `audit_events` is the internal
-- security record — pseudonymous, unreadable by clients, retention-bound, and
-- surviving account deletion as completion evidence.
--
-- Content is classified Confidential (security §data classification: "Activity
-- summaries"), not Restricted. Restricted values never reach it: summaries carry
-- masked identifiers at most (ATL-069) and `metadata_redacted_json` is
-- allowlisted.
create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- What happened, e.g. `asset.created`. Constrained by shape here and by a
  -- typed union in the application (ATL-069, which owns the enumeration).
  --
  -- Deliberately not a check constraint listing every value: the inventory grows
  -- with each feature milestone, and an append-only rule makes a growing SQL
  -- enum expensive to maintain. The same reasoning as `audit_events.event_type`.
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  -- What it happened to. Nullable because some events are account-level rather
  -- than about a specific record.
  entity_type text check (entity_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  entity_id uuid,
  -- The line the user reads.
  --
  -- Redaction is the writer's job (ATL-069: "summaries contain no restricted
  -- values, masked identifiers at most"); the length cap here is a backstop
  -- against a caller that finds a way to pass something large.
  summary text not null check (char_length(summary) between 1 and 500),
  -- Structured context for filtering and entity links.
  --
  -- Allowlisted in the application (`src/lib/activity/activity-metadata.ts`),
  -- built on the same ATL-085 redaction utility the audit context uses. The
  -- size cap is measured as serialised text rather than `pg_column_size`: the
  -- latter reports the post-TOAST-compression size, so the effective limit
  -- would rise and fall with how compressible the payload happened to be.
  metadata_redacted_json jsonb not null default '{}'::jsonb check (length(metadata_redacted_json::text) <= 2048),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- An entity reference is all-or-nothing.
  --
  -- Half a reference cannot produce the entity link frontend §13 requires, and a
  -- row carrying an id with no type is one the timeline would have to guess
  -- about.
  constraint activity_events_entity_reference_is_complete check (
    (
      entity_type is not null
      and entity_id is not null
    )
    or (
      entity_type is null
      and entity_id is null
    )
  )
);

comment on table public.activity_events is 'User-facing product timeline (ATL-068, architecture §7.9, ADR-006). Owner-readable; written only by the server-side emitter; deleted with the account.';

comment on column public.activity_events.summary is 'The line the user reads. Contains no restricted values — masked identifiers at most (ATL-069).';

comment on column public.activity_events.metadata_redacted_json is 'Allowlisted structured context. Enforced in the application by the ATL-085 redaction utility.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The timeline query (ATL-070): one user's events, newest first.
--
-- `id` is part of the key, not decoration. `occurred_at` is millisecond
-- resolution, so two events can tie; without a tiebreak the sort is ambiguous
-- and cursor pagination — which ATL-070 requires — can repeat or skip a row at
-- a page boundary. The same resolution problem produced a false tamper alert in
-- the ATL-103 chain verifier, so it is designed out here rather than discovered
-- later.
create index activity_events_timeline_idx on public.activity_events (user_id, occurred_at desc, id desc);

-- Entity lookups: "what happened to this asset?" (frontend §13 entity links).
-- Partial, because rows without an entity reference can never match.
create index activity_events_entity_idx on public.activity_events (user_id, entity_type, entity_id)
where
  entity_type is not null;

-- Filtering by action (frontend §13 "filters by entity and action").
--
-- Carries the same `id` tiebreak as the timeline index, and for the same reason.
-- Without it Postgres can satisfy `order by occurred_at desc` from the index but
-- must still order the rows that share a timestamp, which shows up as an
-- Incremental Sort node — measured, not assumed. Including `id` makes a filtered
-- timeline a pure index scan, so paginating a filtered view has the same cost
-- shape as paginating an unfiltered one.
create index activity_events_type_idx on public.activity_events (user_id, event_type, occurred_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.activity_events enable row level security;

-- Deny by default (security §7). The owner may read their own timeline, because
-- showing it is the point of the feature (PRD FR-09, frontend §13).
--
-- `auth.uid()` comes from the verified JWT, never from a client-supplied value.
create policy "activity_events_select_own" on public.activity_events for
select
  to authenticated using (auth.uid () = user_id);

-- No INSERT, UPDATE, or DELETE policy, each for its own reason.
--
-- **INSERT**: events are written by services through the shared emitter
-- (ATL-069) so that activity and audit cannot drift. A client that could insert
-- would be able to write a timeline entry describing something that never
-- happened.
--
-- **UPDATE**: an event records what occurred at a point in time. Editing one
-- after the fact makes the timeline a story rather than a record.
--
-- **DELETE**: a user cannot remove individual entries. This is an undocumented
-- decision recorded here rather than assumed: a selectively-erasable timeline is
-- a weaker record — including for the user, who may later want to see when a
-- change actually happened. Rows leave with the account through the cascade,
-- which is the deletion ADR-006 specifies. Adding a "clear history" action later
-- is additive; removing a delete capability would not be.
-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.activity_events
from
  anon;

-- `authenticated` — read-only, matching the single policy exactly.
grant
select
  on public.activity_events to authenticated;

-- `service_role` — the activity writer (ATL-069).
--
-- No UPDATE and no DELETE: nothing server-side rewrites history either, and
-- account deletion goes through the `auth.users` cascade rather than an
-- application delete.
grant
select
,
  insert on public.activity_events to service_role;
