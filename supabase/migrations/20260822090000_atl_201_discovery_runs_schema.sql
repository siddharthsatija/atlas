-- ATL-201 · Discovery runs and invocations schema
--
-- Creates three tables that track the lifecycle of a discovery run and the
-- outbound provider calls it generates:
--
--   discovery_runs                       — one row per user-triggered operation
--   discovery_provider_invocations       — one row per provider call within a run
--   discovery_provider_invocation_fields — one row per field queried per call
--
-- ADR-007 §5, ADR-008 §5, §10.
--
-- APPEND-ONLY: this migration adds three tables and one prerequisite unique
-- constraint on user_personal_fields. No existing table, policy, grant, index
-- or trigger is otherwise modified.
--
-- Cross-user composite FK pattern (ADR-008 §10):
-- A simple single-column FK is not sufficient — it would allow the database to
-- represent a cross-user parent/child association that RLS alone cannot prevent
-- at the schema level. Every parent/child relationship here uses the composite
--   FOREIGN KEY (user_id, parent_id) REFERENCES parent (user_id, id)
-- form. This requires UNIQUE (user_id, id) on each parent table, which is
-- established either inline (discovery_runs, discovery_provider_invocations) or
-- as a prerequisite (user_personal_fields, below).
--
-- Tables in dependency order:
--   0. [Prerequisite] user_personal_fields — add UNIQUE (user_id, id)
--   1. discovery_runs
--   2. discovery_provider_invocations
--   3. discovery_provider_invocation_fields
-- ============================================================
-- Prerequisite: UNIQUE (user_id, id) on user_personal_fields
-- ============================================================
-- The composite FK in discovery_provider_invocation_fields requires
-- UNIQUE (user_id, id) on user_personal_fields. The ATL-105 migration does
-- not contain this constraint. ATL-201 adds it conditionally so the migration
-- is idempotent if a subsequent migration introduces the same constraint before
-- ATL-201 executes.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_personal_fields'::regclass
      and conname = 'user_personal_fields_user_id_id_key'
  ) then
    alter table public.user_personal_fields
      add constraint user_personal_fields_user_id_id_key unique (user_id, id);
  end if;
end $$;

-- ============================================================
-- 1. discovery_runs
-- ============================================================
-- One row per user-triggered discovery operation. run_status is a deterministic
-- aggregation of child discovery_provider_invocations terminal states computed
-- by the run orchestrator — it must not be independently written by services
-- (ADR-008 §10).
create table public.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Aggregated status derived from child invocation terminal states (ADR-008 §10):
  --   pending   — no child invocation rows exist yet
  --   running   — at least one child invocation is non-terminal
  --   completed — all terminal; all are success
  --   partial   — all terminal; at least one success and at least one non-success
  --   blocked   — all terminal; all are blocked
  --   failed    — all terminal; none succeeded; at least one error or rate_limited
  run_status text not null default 'pending' check (run_status in ('pending', 'running', 'completed', 'partial', 'blocked', 'failed')),
  -- What triggered this discovery run.
  --   user           — explicit user action
  --   scheduled      — background schedule (Phase 3, not yet implemented)
  --   profile_change — triggered by an identity profile update
  triggered_by text not null check (triggered_by in ('user', 'scheduled', 'profile_change')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  -- Required for the cross-user composite FK from discovery_provider_invocations:
  --   FOREIGN KEY (user_id, run_id) REFERENCES discovery_runs (user_id, id)
  -- Naming follows digital_assets_user_id_id_key (ATL-028) and
  -- data_requests_user_id_id_key (ATL-058).
  constraint discovery_runs_user_id_id_key unique (user_id, id)
);

comment on table public.discovery_runs is 'One row per user-triggered discovery operation (ATL-201, ADR-007 §5, ADR-008 §10). run_status is a deterministic aggregation of child invocation states; it must not be independently written — only the run orchestrator may set it.';

comment on column public.discovery_runs.run_status is 'Aggregated from child discovery_provider_invocations: pending (no invocations), running (any non-terminal), completed (all success), partial (mixed success/non-success), blocked (all blocked), failed (all terminal, none succeeded). Computed from child state only — not written independently (ADR-008 §10).';

comment on column public.discovery_runs.triggered_by is 'What initiated this run: user = explicit user action; scheduled = background schedule (Phase 3, deferred); profile_change = triggered by identity profile update.';

-- ---------------------------------------------------------------------------
-- discovery_runs · indexes
-- ---------------------------------------------------------------------------
-- Run history for a user, newest first (ticket: partial index on (user_id, created_at DESC)).
create index discovery_runs_user_created_idx on public.discovery_runs (user_id, created_at desc);

-- FK support (CLAUDE.md: index foreign keys).
create index discovery_runs_user_id_idx on public.discovery_runs (user_id);

-- ---------------------------------------------------------------------------
-- discovery_runs · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.discovery_runs enable row level security;

-- Deny by default. Authenticated users may read their own runs; all writes go
-- through the server-side run orchestrator (no client insert/update/delete).
create policy "discovery_runs_select_own" on public.discovery_runs for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- discovery_runs · Privileges
-- ---------------------------------------------------------------------------
revoke all on public.discovery_runs
from
  anon;

grant
select
  on public.discovery_runs to authenticated;

-- service_role: all verbs. The run orchestrator creates, reads, and updates
-- run rows; the auth.users cascade issues deletes on account deletion.
grant
select
,
  insert,
update,
delete on public.discovery_runs to service_role;

-- ============================================================
-- 2. discovery_provider_invocations
-- ============================================================
-- One row per provider execution within a run. Carries the ConsentProof
-- binding (consent_proof_issued_at) and per-invocation lifecycle state.
-- invocation_status is nullable while non-terminal; it is set exactly once
-- when a terminal state is reached (ADR-008 §10 lifecycle invariant).
--
-- A blocked invocation records invocation_status = 'blocked' and sets
-- completed_at without transmitting any request to the provider, distinguishing
-- it from a zero-result execution (ADR-007 §4, ADR-008 §10).
create table public.discovery_provider_invocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Cross-user composite FK to discovery_runs (ADR-008 §10). A plain
  -- run_id → discovery_runs(id) FK would allow cross-user associations.
  run_id uuid not null,
  -- Provider registry identifier, e.g. 'hibp', 'github_username'.
  -- Vocabulary is owned by the provider registry (code constant, not DB enum),
  -- following the pattern of activity_events.event_type and digital_assets.category.
  provider_class text not null check (provider_class ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Nullable while the invocation is non-terminal.
  -- Terminal values only: success, blocked, error, rate_limited (ADR-008 §10).
  invocation_status text check (
    invocation_status is null
    or invocation_status in ('success', 'blocked', 'error', 'rate_limited')
  ),
  -- issued_at timestamp from the ConsentProof for this invocation (ADR-008 §4).
  -- Audit and replay metadata only — not a validity window.
  consent_proof_issued_at timestamptz,
  -- Lifecycle timestamps (ADR-008 §10 invocation lifecycle):
  --   started_at:   set when the invocation enters Atlas's dispatch-processing
  --                 boundary, not when an HTTP request is transmitted.
  --   completed_at: set when invocation_status reaches a terminal value.
  started_at timestamptz,
  completed_at timestamptz,
  -- Closed Atlas-owned error code. Populated on error or blocked status.
  error_code text check (
    error_code is null
    or error_code ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  created_at timestamptz not null default now(),
  -- Cross-user composite FK to discovery_runs (ADR-008 §10).
  constraint discovery_provider_invocations_run_fkey foreign key (user_id, run_id) references public.discovery_runs (user_id, id) on delete cascade,
  -- Required for the cross-user composite FK from discovery_provider_invocation_fields:
  --   FOREIGN KEY (user_id, invocation_id) REFERENCES
  --     discovery_provider_invocations (user_id, id)
  constraint discovery_provider_invocations_user_id_id_key unique (user_id, id),
  -- Lifecycle invariant — three prohibited states (ADR-008 §10):
  -- (1) A non-null invocation_status (terminal) requires completed_at to be set.
  constraint discovery_provider_invocations_terminal_needs_completed check (
    invocation_status is null
    or completed_at is not null
  ),
  -- (2) A non-null completed_at requires a terminal invocation_status.
  constraint discovery_provider_invocations_completed_needs_status check (
    completed_at is null
    or invocation_status is not null
  ),
  -- (3) A non-null completed_at requires started_at to be set.
  constraint discovery_provider_invocations_completed_needs_started check (
    completed_at is null
    or started_at is not null
  )
);

comment on table public.discovery_provider_invocations is 'One row per provider execution within a discovery run (ATL-201, ADR-008 §10). invocation_status is nullable while non-terminal; set exactly once at terminal state. A blocked invocation records invocation_status = blocked with completed_at set, distinguishing it from a zero-result execution.';

comment on column public.discovery_provider_invocations.invocation_status is 'Nullable while non-terminal. Set exactly once when a terminal state is reached; never overwritten. Terminal values: success, blocked, error, rate_limited (ADR-008 §10).';

comment on column public.discovery_provider_invocations.consent_proof_issued_at is 'issued_at from the ConsentProof for this invocation (ADR-008 §4). Audit and replay metadata; not a validity window.';

comment on column public.discovery_provider_invocations.started_at is 'Set when the invocation enters Atlas dispatch-processing boundary, not when an external HTTP request is transmitted. An invocation may be blocked at any ConsentProof check after started_at is set (ADR-008 §10).';

comment on column public.discovery_provider_invocations.error_code is 'Closed Atlas-owned error vocabulary. Populated on error or blocked status. Never contains provider error bodies or messages (ADR-008 §8).';

-- ---------------------------------------------------------------------------
-- discovery_provider_invocations · indexes
-- ---------------------------------------------------------------------------
-- Run-to-invocations lookup: used by run-status aggregation and dispatch.
create index discovery_provider_invocations_run_idx on public.discovery_provider_invocations (user_id, run_id);

-- FK support.
create index discovery_provider_invocations_user_id_idx on public.discovery_provider_invocations (user_id);

-- ---------------------------------------------------------------------------
-- discovery_provider_invocations · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.discovery_provider_invocations enable row level security;

create policy "discovery_provider_invocations_select_own" on public.discovery_provider_invocations for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- discovery_provider_invocations · Privileges
-- ---------------------------------------------------------------------------
revoke all on public.discovery_provider_invocations
from
  anon;

grant
select
  on public.discovery_provider_invocations to authenticated;

grant
select
,
  insert,
update,
delete on public.discovery_provider_invocations to service_role;

-- ============================================================
-- 3. discovery_provider_invocation_fields
-- ============================================================
-- One row per field queried within a provider invocation. Decouples the
-- invocation record (one row per HTTP call) from the field count, preserving
-- the one-invocation-per-disclosure-attempt invariant for providers that query
-- multiple fields in a single network call (ADR-008 §10).
--
-- field_type is a snapshot of user_personal_fields.field_key taken at mapping
-- time. Preserved for audit. The dispatcher reads the live user_personal_fields
-- row at dispatch time per ADR-008 §4 check 7 — field_type does not substitute
-- for that live read (check 7 requires both field-type eligibility and
-- include_in_discovery = true from the current row).
create table public.discovery_provider_invocation_fields (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Cross-user composite FK to discovery_provider_invocations (ADR-008 §10).
  invocation_id uuid not null,
  -- Cross-user composite FK to user_personal_fields (ADR-008 §10).
  -- Requires UNIQUE (user_id, id) on user_personal_fields, added as a
  -- prerequisite at the top of this migration.
  -- No ON DELETE CASCADE: PersonalFieldService.removeField (ATL-204) blocks
  -- deletion of a field that has active invocation references. The FK enforces
  -- this at the DB layer; account deletion is safe because both tables cascade
  -- from auth.users and the NO ACTION check passes at statement end.
  field_id uuid not null,
  -- Snapshot of user_personal_fields.field_key at mapping time. Preserved for
  -- audit. Does not substitute for the live user_personal_fields read required
  -- by ADR-008 §4 check 7 at dispatch time.
  field_type text not null check (field_type in ('full_name', 'email', 'phone', 'address', 'username', 'other')),
  created_at timestamptz not null default now(),
  -- Cross-user composite FK to discovery_provider_invocations.
  -- ON DELETE CASCADE: cleaning up field mappings when an invocation is removed.
  constraint discovery_provider_invocation_fields_invocation_fkey foreign key (user_id, invocation_id) references public.discovery_provider_invocations (user_id, id) on delete cascade,
  -- Cross-user composite FK to user_personal_fields.
  -- NO ON DELETE CASCADE: deletion blocked at service layer (ATL-204).
  constraint discovery_provider_invocation_fields_field_fkey foreign key (user_id, field_id) references public.user_personal_fields (user_id, id),
  -- A field may not appear twice in the same invocation (ADR-008 §10).
  constraint discovery_provider_invocation_fields_unique_per_invocation unique (user_id, invocation_id, field_id)
);

comment on table public.discovery_provider_invocation_fields is 'One row per field queried in a provider invocation (ATL-201, ADR-008 §10). Decouples the invocation record from field count; preserves the one-invocation-per-disclosure-attempt invariant for multi-field providers.';

comment on column public.discovery_provider_invocation_fields.field_type is 'Snapshot of user_personal_fields.field_key at the time this field was mapped to the invocation. Same closed vocabulary. Preserved for audit. The dispatcher still reads the live user_personal_fields row per ADR-008 §4 check 7 — field_type does not substitute for that live read.';

comment on column public.discovery_provider_invocation_fields.field_id is 'References user_personal_fields (user_id, id) via cross-user composite FK (ADR-008 §10). No ON DELETE CASCADE: PersonalFieldService.removeField (ATL-204) blocks field deletion when active invocation references exist.';

-- ---------------------------------------------------------------------------
-- discovery_provider_invocation_fields · indexes
-- ---------------------------------------------------------------------------
-- Dispatch check 6: load all field mappings for a (user_id, invocation_id).
create index discovery_provider_invocation_fields_invocation_idx on public.discovery_provider_invocation_fields (user_id, invocation_id);

-- FK support for the user_personal_fields reference.
create index discovery_provider_invocation_fields_field_idx on public.discovery_provider_invocation_fields (user_id, field_id);

-- FK support for user_id.
create index discovery_provider_invocation_fields_user_id_idx on public.discovery_provider_invocation_fields (user_id);

-- ---------------------------------------------------------------------------
-- discovery_provider_invocation_fields · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.discovery_provider_invocation_fields enable row level security;

create policy "discovery_provider_invocation_fields_select_own" on public.discovery_provider_invocation_fields for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- discovery_provider_invocation_fields · Privileges
-- ---------------------------------------------------------------------------
revoke all on public.discovery_provider_invocation_fields
from
  anon;

grant
select
  on public.discovery_provider_invocation_fields to authenticated;

-- service_role: SELECT, INSERT (fields mapped before dispatch), DELETE (cleanup
-- via cascade). No UPDATE: a field mapping is immutable once created.
grant
select
,
  insert,
  delete on public.discovery_provider_invocation_fields to service_role;
