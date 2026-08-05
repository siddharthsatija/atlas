-- ATL-103 · audit_events
--
-- Internal security audit log per ADR-006. Architecture §7.15, security §12.
--
-- APPEND-ONLY: this migration adds a table and touches nothing that came before.
-- The profiles and user_encryption_keys migrations and their policies are
-- untouched.
--
-- rls: deny-all
--
-- No client policies at all. This is the same internal-table pattern as
-- `user_encryption_keys`, and for a stronger reason: an audit log the audited
-- party can read tells them what was noticed, and one they can write is not
-- evidence of anything.
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  -- From the security §12 inventory. Constrained in the application rather than
  -- as a check constraint: the inventory grows with each feature milestone, and
  -- an append-only rule makes a growing enum in SQL expensive to maintain.
  event_type text not null check (char_length(event_type) between 1 and 64),
  -- Pseudonymous stable HMAC of the user ID.
  --
  -- There is deliberately **no `user_id` column and no foreign key** (ADR-006).
  -- A foreign key would cascade the audit log away with the account, which is
  -- precisely the property that disqualified `activity_events` from this role.
  -- Retention is time-based, not lifecycle-based, so deletion-completion
  -- evidence outlives the row it describes.
  subject_ref text not null check (char_length(subject_ref) = 64),
  entity_type text check (char_length(entity_type) between 1 and 64),
  entity_id text check (char_length(entity_id) between 1 and 128),
  actor_type text not null check (actor_type in ('user', 'system', 'operator')),
  -- Allowlisted keys only: versions, request IDs, statuses, counts. The writer
  -- enforces the allowlist; the size cap here is a backstop against a caller
  -- that finds a way to pass something large.
  --
  -- Measured as serialised text length, deliberately not `pg_column_size`.
  -- `pg_column_size` reports the *stored* size after TOAST compression, so the
  -- effective cap would rise and fall with how compressible the payload happens
  -- to be — highly repetitive junk would slip far past 4096 bytes while dense
  -- content was rejected early. It is also marked STABLE, and PostgreSQL
  -- assumes CHECK expressions are IMMUTABLE (it does not enforce this, so the
  -- constraint would have been accepted and then quietly rested on an
  -- assumption it breaks). `length(... ::text)` is immutable and bounds the
  -- thing actually worth bounding.
  context_json jsonb not null default '{}'::jsonb check (length(context_json::text) <= 4096),
  -- Per-subject hash chain (ADR-006).
  --
  -- `prev_hash` is NOT NULL, using an all-zero genesis value for a subject's
  -- first event rather than NULL. That is what makes the unique index below
  -- work: Postgres treats NULLs as distinct by default, so a nullable
  -- `prev_hash` would let two concurrent "first events" both insert and fork the
  -- chain at its root — the one place a fork is most likely and least visible.
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  event_hash text not null check (event_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

comment on table public.audit_events is 'Internal security audit log (ADR-006). Service-role only, append-only, per-subject hash chain. No client policies.';

comment on column public.audit_events.subject_ref is 'HMAC-SHA256 of the user ID under AUDIT_HMAC_KEY. Not reversible to identity once the auth record is gone.';

comment on column public.audit_events.prev_hash is 'Previous event_hash for this subject, or 64 zeros for the first event.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The chain must stay linear.
--
-- A writer reads the subject's latest `event_hash` and inserts a row claiming it
-- as `prev_hash`. Two concurrent writers read the same value and both try to
-- extend from it; without this index both succeed and the chain silently forks
-- into two branches. Verification would then have to guess which branch is
-- authentic — and a fork is exactly what a tamperer would manufacture.
--
-- Making the link unique turns that race into a unique-violation the writer
-- retries, so concurrency produces a slower write rather than a corrupt record.
create unique index audit_events_chain_link_unique on public.audit_events (subject_ref, prev_hash);

-- An event hash is the chain's identity; a duplicate would make verification
-- ambiguous.
create unique index audit_events_event_hash_unique on public.audit_events (event_hash);

-- Chain walks and verification both read one subject in occurrence order.
create index audit_events_subject_occurred_idx on public.audit_events (subject_ref, occurred_at);

-- Retention purge and incident review scan by time.
create index audit_events_occurred_at_idx on public.audit_events (occurred_at);

-- Incident response filters by event type over a window.
create index audit_events_event_type_occurred_idx on public.audit_events (event_type, occurred_at);

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------
--
-- Privileges below already withhold UPDATE and DELETE from every application
-- role. This trigger is the second lock: it also binds anything acting as the
-- table owner or a superuser, which grants alone never restrict.
--
-- Without it, "append-only" would hold only for as long as nobody connects with
-- elevated credentials — and incident response, migrations, and support tooling
-- are exactly the contexts where someone does.
create function public.audit_events_reject_mutation () returns trigger language plpgsql as $$
begin
  raise exception
    'audit_events is append-only (ADR-006): % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function public.audit_events_reject_mutation () is 'Enforces ADR-006 append-only semantics even for owner and superuser connections.';

create trigger audit_events_no_update
before update on public.audit_events for each row
execute function public.audit_events_reject_mutation ();

create trigger audit_events_no_delete
before delete on public.audit_events for each row
execute function public.audit_events_reject_mutation ();

-- ---------------------------------------------------------------------------
-- Row Level Security — deny all
-- ---------------------------------------------------------------------------
--
-- RLS on, no policies created: every client role is denied every row. There is
-- no predicate to get wrong because there is no predicate (security §7).
alter table public.audit_events enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- The grant gate is the primary control. `anon` and `authenticated` are revoked
-- explicitly so that a policy added by mistake later still grants nothing — a
-- policy without a grant is inert.
revoke all on public.audit_events
from
  anon;

revoke all on public.audit_events
from
  authenticated;

-- `service_role` gets exactly what ADR-006 specifies and nothing more:
--   select — chain verification and incident response
--   insert — the audit writer
--
-- UPDATE and DELETE are withheld from every role, and the triggers above refuse
-- both even for owner and superuser connections.
--
-- KNOWN CONSEQUENCE, accepted deliberately: ADR-006 also specifies a 90-day
-- retention purge and a rule that only deletion-completion evidence survives
-- account deletion. Neither can run against this table as it stands. Both are
-- M11 work (ATL-082), and both will need a follow-up migration that opens a
-- narrow, reviewed path — for example a SECURITY DEFINER function that removes
-- only rows past the retention window.
--
-- Requiring that migration is the point rather than an oversight. Deleting audit
-- history is the single most damaging operation this table permits, so it should
-- cost a reviewed schema change, not be reachable from whatever credential a
-- job happens to hold. Leaving DELETE open now would be cheaper today and
-- indistinguishable from tampering later.
grant
select
,
  insert on public.audit_events to service_role;
