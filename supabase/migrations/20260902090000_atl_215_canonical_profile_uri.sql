-- ATL-215 · Canonical external-profile identity
--
-- Allows multiple evidence records and multiple discovery providers that
-- identify the same external profile to converge on a single
-- discovery_candidates row.
--
-- Changes:
--   1. discovery_candidates.canonical_profile_uri  — nullable text column
--   2. Partial unique index on (user_id, canonical_profile_uri)
--   3. discovery_candidate_evidence join table
--   4. Postgres function for atomic canonical candidate creation + founding
--      evidence association
--
-- Schema facts preserved:
--   discovery_candidates.evidence_id  — retained as immutable founding
--     provenance; all candidate rows, canonical or not, retain this column.
--
-- For every NEW canonical candidate the founding evidence must appear in
-- BOTH discovery_candidates.evidence_id AND discovery_candidate_evidence so
-- the join table represents the complete evidence set.
--
-- ADR-007 §6, §7; ADR-008 §5, §7, §10.
--
-- APPEND-ONLY: no existing tables, policies, grants, indexes, triggers,
-- or constraints are modified.
-- ============================================================
-- 1. discovery_candidates — add canonical_profile_uri
-- ============================================================
-- Nullable: existing candidates written before ATL-215 have no canonical URI.
-- Provider-neutral: no vendor-specific identifier, no confidence_tier.
-- Normalization is enforced by the Atlas-owned normalizer before the value
-- reaches the database; no check constraint is placed here.
alter table public.discovery_candidates
add column canonical_profile_uri text;

comment on column public.discovery_candidates.canonical_profile_uri is 'Atlas-normalised URI identifying the external profile this candidate
  represents (ATL-215). Null for legacy candidates and for evidence-based
  candidates that carry no canonical external-profile URI. When non-null,
  the partial unique index discovery_candidates_canonical_uri_key ensures
  at most one candidate per (user_id, canonical_profile_uri) across all
  statuses. Normalization is enforced in the application layer by the
  shared Atlas-owned normalizer; the database stores the already-normalised
  value.';

-- ============================================================
-- 2. Canonical uniqueness index
-- ============================================================
-- Partial: rows with canonical_profile_uri IS NULL are excluded so that
-- legacy evidence-based candidates (canonical_profile_uri = NULL) are not
-- subject to the one-per-user uniqueness rule.
-- All statuses (pending, confirmed, rejected, dismissed, not_sure) participate:
-- a rejected canonical candidate remains unique and cannot be displaced by a
-- new pending one for the same URI.
create unique index discovery_candidates_canonical_uri_key on public.discovery_candidates (user_id, canonical_profile_uri)
where
  canonical_profile_uri is not null;

-- ============================================================
-- 3. discovery_candidate_evidence join table
-- ============================================================
-- Associates multiple evidence records with a single canonical candidate.
-- The founding evidence appears here in addition to discovery_candidates.
-- evidence_id; all subsequent evidence records for the same canonical URI
-- appear here only.
--
-- Cross-user composite FK pattern (ADR-008 §10):
--   discovery_candidate_evidence.candidate_id
--     → discovery_candidates (user_id, id)
--   discovery_candidate_evidence.evidence_id
--     → discovery_evidence (user_id, id)
--
-- One evidence record may associate with at most one candidate
-- (UNIQUE (user_id, evidence_id)): the same evidence row cannot be shared
-- across two different candidates.
create table public.discovery_candidate_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  candidate_id uuid not null,
  evidence_id uuid not null,
  created_at timestamptz not null default now(),
  -- Cross-user composite FK to discovery_candidates (ADR-008 §10).
  constraint discovery_candidate_evidence_candidate_fkey foreign key (user_id, candidate_id) references public.discovery_candidates (user_id, id),
  -- Cross-user composite FK to discovery_evidence (ADR-008 §10).
  constraint discovery_candidate_evidence_evidence_fkey foreign key (user_id, evidence_id) references public.discovery_evidence (user_id, id),
  -- One evidence record → at most one candidate.
  constraint discovery_candidate_evidence_user_evidence_key unique (user_id, evidence_id)
);

comment on table public.discovery_candidate_evidence is 'Join table linking evidence records to their canonical candidate (ATL-215,
  ADR-007 §6). A single discovery_candidates row may aggregate evidence from
  multiple fields or providers that identify the same external profile URI.
  The founding evidence_id appears in both discovery_candidates.evidence_id
  (immutable provenance) and this table (complete evidence set). Composite
  FKs enforce per-user isolation (ADR-008 §10).';

comment on column public.discovery_candidate_evidence.candidate_id is 'The canonical candidate that this evidence record corroborates. Cross-user
  composite FK: (user_id, candidate_id) → discovery_candidates (user_id, id).';

comment on column public.discovery_candidate_evidence.evidence_id is 'The evidence record associated with the candidate. Cross-user composite FK:
  (user_id, evidence_id) → discovery_evidence (user_id, id). UNIQUE per user:
  one evidence record may not be associated with two different candidates.';

-- ---------------------------------------------------------------------------
-- discovery_candidate_evidence · indexes
-- ---------------------------------------------------------------------------
-- Candidate-to-evidence lookup: retrieve all evidence for a given candidate.
create index discovery_candidate_evidence_candidate_idx on public.discovery_candidate_evidence (user_id, candidate_id);

-- Evidence-to-candidate reverse lookup: find the candidate for a given
-- evidence record (used when detaching or auditing).
create index discovery_candidate_evidence_evidence_idx on public.discovery_candidate_evidence (user_id, evidence_id);

-- FK support for user_id.
create index discovery_candidate_evidence_user_id_idx on public.discovery_candidate_evidence (user_id);

-- ---------------------------------------------------------------------------
-- discovery_candidate_evidence · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.discovery_candidate_evidence enable row level security;

-- Deny by default. Authenticated users may read their own rows;
-- all writes go through the server-side canonical candidate resolver.
create policy "discovery_candidate_evidence_select_own" on public.discovery_candidate_evidence for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- discovery_candidate_evidence · Privileges
-- ---------------------------------------------------------------------------
revoke all on public.discovery_candidate_evidence
from
  anon;

grant
select
  on public.discovery_candidate_evidence to authenticated;

-- service_role: all verbs. The canonical candidate resolver inserts join rows;
-- auth.users cascade issues deletes on account deletion.
grant
select
,
  insert,
update,
delete on public.discovery_candidate_evidence to service_role;

-- ============================================================
-- 4. Atomic canonical candidate creation function
-- ============================================================
-- Creates a canonical discovery_candidates row and its founding
-- discovery_candidate_evidence row in a single transaction.
--
-- If a concurrent caller already created a candidate for the same
-- (p_user_id, p_canonical_profile_uri), the INSERT conflicts silently
-- (ON CONFLICT DO NOTHING) and the subsequent SELECT retrieves the winning
-- row. Both callers end up with the same candidate id; neither surfaces
-- an uncaught uniqueness error.
--
-- The founding evidence row in discovery_candidate_evidence is inserted with
-- ON CONFLICT DO NOTHING for the same idempotency guarantee.
--
-- Security design:
--   SECURITY INVOKER (default): the function runs as the calling role.
--   In production the caller is always service_role (the server-side
--   canonical candidate resolver), which already holds INSERT on both
--   tables. No privilege escalation occurs.
--   SET search_path = '': prevents search_path-based injection, following
--   the repository convention established by existing trigger functions.
--   Schema-qualified object references are used throughout.
--   EXECUTE is granted only to service_role; revoked from authenticated,
--   anon, and PUBLIC so no client-side caller can invoke this function.
--   Tenant isolation: the function writes only to the row identified by
--   p_user_id. Application code is the boundary that ensures p_user_id
--   matches the authenticated session; service_role is trusted server-side
--   code that never accepts p_user_id from client input.
create function public.create_canonical_candidate (p_user_id uuid, p_candidate_id uuid, p_evidence_id uuid, p_canonical_profile_uri text) returns uuid language plpgsql
set
  search_path = '' as $$
declare
  v_candidate_id uuid;
begin
  -- Attempt to insert the new canonical candidate. If a concurrent caller
  -- has already created a candidate for this (user_id, canonical_profile_uri)
  -- pair, the partial unique index fires and DO NOTHING suppresses the error.
  insert into public.discovery_candidates
    (id, user_id, evidence_id, canonical_profile_uri, status)
  values
    (p_candidate_id, p_user_id, p_evidence_id, p_canonical_profile_uri, 'pending')
  on conflict (user_id, canonical_profile_uri)
    where canonical_profile_uri is not null
  do nothing;

  -- Retrieve the winning candidate id (either the one we just created or the
  -- one that caused the conflict). INTO STRICT asserts exactly one row exists,
  -- which is guaranteed by the unique index and the fact that candidates are
  -- never hard-deleted.
  select id
    into strict v_candidate_id
    from public.discovery_candidates
   where user_id              = p_user_id
     and canonical_profile_uri = p_canonical_profile_uri;

  -- Associate the founding evidence with the candidate. Idempotent: a second
  -- call for the same (user_id, evidence_id) pair is silently ignored.
  insert into public.discovery_candidate_evidence
    (user_id, candidate_id, evidence_id)
  values
    (p_user_id, v_candidate_id, p_evidence_id)
  on conflict (user_id, evidence_id)
  do nothing;

  return v_candidate_id;
end;
$$;

comment on function public.create_canonical_candidate (uuid, uuid, uuid, text) is 'Atomically creates a canonical discovery_candidates row and its founding
  discovery_candidate_evidence row (ATL-215). Concurrent callers for the same
  (user_id, canonical_profile_uri) converge to exactly one candidate via the
  partial unique index. Callable by service_role only.';

-- Only the server-side service role may invoke this function.
-- Revoke from PUBLIC (which includes authenticated and anon) explicitly.
revoke all on function public.create_canonical_candidate (uuid, uuid, uuid, text)
from
  public;

revoke
execute on function public.create_canonical_candidate (uuid, uuid, uuid, text)
from
  authenticated;

revoke
execute on function public.create_canonical_candidate (uuid, uuid, uuid, text)
from
  anon;

grant
execute on function public.create_canonical_candidate (uuid, uuid, uuid, text) to service_role;
