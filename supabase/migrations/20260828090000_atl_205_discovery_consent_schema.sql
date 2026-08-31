-- ATL-205 · Discovery consent schema
--
-- Creates one new table required for the discovery consent and ConsentProof
-- infrastructure:
--
--   discovery_first_disclosure_acknowledgments
--     — durable acknowledgment that a user reviewed the first-disclosure notice
--       before a specific (provider_class, field_id, disclosure_contract_version)
--       tuple was transmitted (ADR-008 §3).
--
-- Discovery consent grants and revocations are NOT stored in a new table here.
-- ADR-008 §4 (dispatch check 5) and §9 are authoritative: the canonical
-- append-only `consents` ledger (ATL-078) is the sole durable source of truth
-- for discovery consent state. The three discovery consent types
-- (discovery_hashed_query, discovery_identifying, discovery_connected_sources)
-- were added to the consents.consent_type CHECK constraint in the ATL-200
-- migration; no schema change to `consents` is required here.
--
-- APPEND-ONLY: this migration adds one table. No existing table, policy, grant,
-- index, or trigger is otherwise modified.
-- ============================================================
-- discovery_first_disclosure_acknowledgments
-- ============================================================
-- One row per (user_id, field_id, provider_class, disclosure_contract_version)
-- tuple. Records that the user reviewed the pre-disclosure notice required by
-- ADR-008 §3 before an identifying value was transmitted to a specific provider
-- for the first time under a specific contract version.
--
-- Key invariants:
--   - The actual personal-field value is never stored here — only the internal
--     field reference (field_id) and the contract version (ADR-008 §3).
--   - The UNIQUE constraint on the four-part tuple is the idempotency key:
--     a second acknowledgment for the same tuple is silently swallowed via
--     ON CONFLICT DO NOTHING in the repository, so the operation is
--     concurrency-safe without a SELECT-before-INSERT pattern.
--   - The cross-user composite FK on (user_id, field_id) prevents a service-
--     role misuse where a row for user A references a field belonging to user B.
--   - Only the dispatch engine (ATL-208 §3 check) reads these rows at run time;
--     authenticated clients may read their own rows for UI display only.
create table public.discovery_first_disclosure_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Internal reference to the specific personal field that was acknowledged.
  -- The field value is not stored here; only the id (ADR-008 §3).
  field_id uuid not null,
  -- Provider registry identifier. Same vocabulary as discovery_rejections.
  provider_class text not null check (provider_class ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Version of the disclosure contract that was in effect when the user
  -- acknowledged. A material policy change issues a new version and the prior
  -- acknowledgment is no longer sufficient (ADR-008 §3).
  disclosure_contract_version text not null check (disclosure_contract_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  acknowledged_at timestamptz not null default now(),
  -- Cross-user composite FK to user_personal_fields.
  -- UNIQUE (user_id, id) on user_personal_fields was established by ATL-201 as
  -- a prerequisite for the discovery_provider_invocation_fields composite FK.
  -- The same constraint satisfies this FK.
  constraint discovery_first_disclosure_acknowledgments_field_fkey foreign key (user_id, field_id) references public.user_personal_fields (user_id, id),
  -- Four-part idempotency key. ON CONFLICT DO NOTHING in the repository makes
  -- duplicate acknowledgment calls safe under concurrent writes.
  constraint discovery_first_disclosure_acknowledgments_tuple_key unique (user_id, field_id, provider_class, disclosure_contract_version)
);

comment on table public.discovery_first_disclosure_acknowledgments is 'Durable acknowledgment that a user reviewed the pre-disclosure notice for a specific (provider_class, field_id, disclosure_contract_version) tuple before the identifying value was first transmitted (ATL-205, ADR-008 §3). Idempotent: a second acknowledgment for the same tuple is silently ignored. The actual field value is never stored — only the internal field_id reference.';

comment on column public.discovery_first_disclosure_acknowledgments.disclosure_contract_version is 'Version of the disclosure contract in effect when the user acknowledged. A material policy change issues a new version; the prior acknowledgment is then no longer sufficient and a new notice must be presented (ADR-008 §3).';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The UNIQUE constraint on the four-part tuple already creates an index that
-- serves dispatch check 8 (ATL-206):
--   WHERE user_id = $1 AND field_id = $2
--         AND provider_class = $3
--         AND disclosure_contract_version = $4
-- No additional compound index is needed for that access pattern.
-- FK/cascade support: account deletion cascades via user_id.
create index discovery_first_disclosure_acknowledgments_user_id_idx on public.discovery_first_disclosure_acknowledgments (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.discovery_first_disclosure_acknowledgments enable row level security;

-- Deny by default. Authenticated users may read their own acknowledgment rows;
-- all writes are server-side only (service_role).
create policy "discovery_first_disclosure_acknowledgments_select_own" on public.discovery_first_disclosure_acknowledgments for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.discovery_first_disclosure_acknowledgments
from
  anon;

grant
select
  on public.discovery_first_disclosure_acknowledgments to authenticated;

-- service_role: all verbs. The disclosure acknowledgment service inserts rows;
-- auth.users cascade issues deletes on account deletion.
grant
select
,
  insert,
update,
delete on public.discovery_first_disclosure_acknowledgments to service_role;
