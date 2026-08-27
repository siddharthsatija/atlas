-- ATL-202 · Discovery evidence, candidates, and rejections schema
--
-- Creates three tables that hold discovery results and permanent suppression records:
--
--   discovery_evidence      — immutable evidence records, one per provider result (ADR-007 §3, §6)
--   discovery_candidates    — proposed digital relationships awaiting user adjudication (ADR-007 §6, §7)
--   discovery_rejections    — permanent rejection fingerprints (ADR-007 §8, ADR-008 §5)
--
-- Also wires the deferred FK from ATL-200:
--   digital_assets.candidate_id → discovery_candidates via composite FK (user_id, candidate_id)
--
-- ADR-007 §6, §7, §8; ADR-008 §5, §7, §10.
--
-- APPEND-ONLY: adds three tables, three index groups, three RLS policy groups,
-- and one FK constraint on digital_assets. No existing table, policy, grant,
-- index, or trigger is otherwise modified.
--
-- Cross-user composite FK pattern (ADR-008 §10):
-- All parent/child relationships use the composite form
--   FOREIGN KEY (user_id, parent_id) REFERENCES parent (user_id, id)
-- to prevent cross-user associations at the schema level. This requires
-- UNIQUE (user_id, id) on each parent table:
--   - discovery_provider_invocations: established by ATL-201
--   - digital_assets: established by ATL-028 (digital_assets_user_id_id_key)
--   - discovery_evidence: established inline below
--   - discovery_candidates: established inline below (required for the composite
--       FK from digital_assets.candidate_id; see step 4)
--
-- Tables in dependency order:
--   1. discovery_evidence    — depends on auth.users, discovery_provider_invocations
--   2. discovery_candidates  — depends on auth.users, discovery_evidence, digital_assets;
--                              exposes UNIQUE (user_id, id) for downstream composite FKs
--   3. discovery_rejections  — depends on auth.users only
--   4. digital_assets        — ALTER TABLE: add composite FK (user_id, candidate_id)
--                              → discovery_candidates (user_id, id)
-- ============================================================
-- 1. discovery_evidence
-- ============================================================
-- One immutable record per provider result. Evidence is the substrate from
-- which candidates and findings are derived; rows are never modified after
-- creation (ADR-007 §3). The encrypted provider_evidence_json column carries
-- the raw normalized payload under AES-256-GCM, per-user DEK (ADR-003,
-- ADR-008 §7). The application generates the row UUID before insert so the
-- AAD can be bound before sealing.
create table public.discovery_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Cross-user composite FK to discovery_provider_invocations (ADR-008 §10).
  -- A plain invocation_id FK would allow cross-user parent/child associations.
  invocation_id uuid not null,
  -- Provider registry identifier matching the invocation row.
  -- Vocabulary is owned by the provider registry (code constant, not DB enum),
  -- following the pattern of discovery_provider_invocations.provider_class.
  provider_class text not null check (provider_class ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- True when the HIBP breach metadata flag IsAggregator = true (ADR-007 §12).
  -- Aggregator evidence creates no discovery_candidates row and is surfaced
  -- through the discovery experience independently of candidate adjudication.
  is_aggregator_attributed boolean not null default false,
  -- Application-level evidence classification. Vocabulary is owned by the
  -- provider registry (code constant), following the pattern of
  -- activity_events.event_type and digital_assets.category.
  evidence_type text not null,
  -- Human-readable summary for the candidate card. Must never contain
  -- plaintext personal field values, HIBP hash prefixes, handles, or provider
  -- response bodies (ADR-008 §8).
  evidence_summary text not null,
  -- AES-256-GCM ciphertext under the per-user DEK (ADR-003). AAD bound to
  -- discovery_evidence.provider_evidence_json:<row_uuid> so this ciphertext
  -- cannot be transplanted to another row or column (ADR-008 §7). The
  -- application generates the UUID before insert. Nullable: not all providers
  -- produce a raw normalized payload worth storing beyond what evidence_summary
  -- already captures.
  provider_evidence_json text,
  created_at timestamptz not null default now(),
  -- Cross-user composite FK to discovery_provider_invocations (ADR-008 §10).
  constraint discovery_evidence_invocation_fkey foreign key (user_id, invocation_id) references public.discovery_provider_invocations (user_id, id),
  -- Required for the cross-user composite FK from discovery_candidates:
  --   FOREIGN KEY (user_id, evidence_id) REFERENCES discovery_evidence (user_id, id)
  -- Naming follows discovery_runs_user_id_id_key (ATL-201) and
  -- digital_assets_user_id_id_key (ATL-028).
  constraint discovery_evidence_user_id_id_key unique (user_id, id)
);

comment on table public.discovery_evidence is 'One immutable evidence record per provider result (ATL-202, ADR-007 §3, §6). Evidence is the substrate for candidates and findings; rows are never modified after creation. provider_evidence_json is AES-256-GCM encrypted under the per-user DEK with AAD bound to the record UUID (ADR-003, ADR-008 §7).';

comment on column public.discovery_evidence.provider_evidence_json is 'Restricted. AES-256-GCM envelope under the per-user DEK (ADR-003). AAD = discovery_evidence.provider_evidence_json:<row_id>. The application generates the UUID before insert so the AAD is bound before sealing (ADR-008 §7). Nullable: omitted when the provider result does not warrant a separate encrypted payload.';

comment on column public.discovery_evidence.is_aggregator_attributed is 'True when the provider breach metadata indicates an aggregator origin (HIBP IsAggregator = true, ADR-007 §12). Aggregator evidence creates no discovery_candidates row and is surfaced independently of the candidate adjudication flow.';

comment on column public.discovery_evidence.evidence_summary is 'Human-readable summary for the candidate card. Must never contain plaintext personal field values, HIBP hash prefixes, handles, or any provider response body content (ADR-008 §8).';

-- ---------------------------------------------------------------------------
-- discovery_evidence · indexes
-- ---------------------------------------------------------------------------
-- Invocation-to-evidence lookup; used when aggregating evidence for a run
-- and when the de-confirmation flow resolves findings back to evidence.
create index discovery_evidence_invocation_idx on public.discovery_evidence (user_id, invocation_id);

-- FK support for user_id.
create index discovery_evidence_user_id_idx on public.discovery_evidence (user_id);

-- ---------------------------------------------------------------------------
-- discovery_evidence · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.discovery_evidence enable row level security;

-- Deny by default. Authenticated users may read their own evidence rows;
-- all writes go through the server-side provider adapters and purge jobs.
create policy "discovery_evidence_select_own" on public.discovery_evidence for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- discovery_evidence · Privileges
-- ---------------------------------------------------------------------------
revoke all on public.discovery_evidence
from
  anon;

grant
select
  on public.discovery_evidence to authenticated;

-- service_role: all verbs. Provider adapters insert evidence rows; the purge
-- job deletes eligible rejected-candidate evidence; auth.users cascade issues
-- deletes on account deletion.
grant
select
,
  insert,
update,
delete on public.discovery_evidence to service_role;

-- ============================================================
-- 2. discovery_candidates
-- ============================================================
-- One row per proposed digital relationship awaiting user adjudication
-- (ADR-007 §6). A candidate is promoted to a confirmed digital_assets row only
-- when the user explicitly confirms it (ADR-007 §7). Unconfirmed candidates
-- (pending, dismissed, not_sure) must not create privacy_findings rows or
-- affect the score pipeline. No service_name or service_domain columns: those
-- are derived at read time from the linked digital_asset (on confirm) or from
-- discovery_evidence (before confirm).
create table public.discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Cross-user composite FK to discovery_evidence (ADR-008 §10).
  evidence_id uuid not null,
  -- Candidate lifecycle status (ADR-007 §6).
  --   pending   — no user action yet
  --   confirmed — user confirmed; asset promoted to digital_assets
  --   rejected  — user denied; rejection fingerprint written to discovery_rejections
  --   dismissed — user deliberately deferred; may resurface at lower urgency
  --   not_sure  — user cannot determine ownership; eligible for additional evidence
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'dismissed', 'not_sure')),
  -- Populated by the adjudication service on confirm only; null for all other
  -- statuses. Cross-user composite FK to digital_assets (ADR-008 §10, ATL-028).
  asset_id uuid,
  -- Set by the adjudication service when status first reaches a decisive value:
  -- confirmed, rejected, dismissed, or not_sure.
  adjudicated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Cross-user composite FK to discovery_evidence (ADR-008 §10).
  constraint discovery_candidates_evidence_fkey foreign key (user_id, evidence_id) references public.discovery_evidence (user_id, id),
  -- Cross-user composite FK to digital_assets (ADR-007 §7, ADR-008 §10).
  -- Nullable: asset_id is null until the candidate is confirmed. The partial
  -- unique index below (status = 'pending') is the primary deduplication gate;
  -- this FK enforces cross-user integrity for the confirmed link.
  constraint discovery_candidates_asset_fkey foreign key (user_id, asset_id) references public.digital_assets (user_id, id),
  -- Required for the cross-user composite FK from digital_assets:
  --   FOREIGN KEY (user_id, candidate_id) REFERENCES discovery_candidates (user_id, id)
  -- Naming follows discovery_evidence_user_id_id_key (ATL-202) and
  -- digital_assets_user_id_id_key (ATL-028).
  constraint discovery_candidates_user_id_id_key unique (user_id, id)
);

comment on table public.discovery_candidates is 'One proposed digital relationship per discovery evidence record, awaiting user adjudication (ATL-202, ADR-007 §6, §7). Unconfirmed candidates (pending, dismissed, not_sure) must not create privacy_findings rows or affect the score pipeline. Confirmed candidates link to a digital_assets row via asset_id.';

comment on column public.discovery_candidates.status is 'Candidate lifecycle: pending (no action yet), confirmed (user confirmed; asset promoted to digital_assets), rejected (user denied; fingerprint written to discovery_rejections), dismissed (deferred by user; may resurface at lower urgency), not_sure (user cannot determine ownership; eligible for additional evidence). ADR-007 §6.';

comment on column public.discovery_candidates.asset_id is 'Populated by the adjudication service on confirm only; null for all non-confirmed statuses. Cross-user composite FK to digital_assets (user_id, id) per ADR-008 §10, using digital_assets_user_id_id_key from ATL-028.';

comment on column public.discovery_candidates.adjudicated_at is 'Set when the candidate first reaches a decisive status (confirmed, rejected, dismissed, not_sure). Null while the candidate remains pending. Not reset if the candidate is re-evaluated in a future run.';

-- ---------------------------------------------------------------------------
-- discovery_candidates · updated_at trigger
-- ---------------------------------------------------------------------------
-- public.set_updated_at() is the shared trigger function (ATL-027, profiles
-- migration) that keeps updated_at current on every row modification.
create trigger discovery_candidates_set_updated_at
before update on public.discovery_candidates for each row
execute function public.set_updated_at ();

-- ---------------------------------------------------------------------------
-- discovery_candidates · indexes
-- ---------------------------------------------------------------------------
-- Evidence-to-candidate lookup; used when presenting candidates for a run and
-- when checking for an existing pending candidate before inserting a new one.
create index discovery_candidates_evidence_idx on public.discovery_candidates (user_id, evidence_id);

-- Asset-to-candidate reverse lookup; used by the de-confirmation flow
-- (ADR-007 §9) to locate the originating candidate when a user de-confirms.
create index discovery_candidates_asset_idx on public.discovery_candidates (user_id, asset_id)
where
  asset_id is not null;

-- Status filter for the candidate adjudication surface and run-status queries.
create index discovery_candidates_status_idx on public.discovery_candidates (user_id, status, created_at desc);

-- Partial unique index: at most one pending candidate per (user, evidence) pair.
-- Confirmed, rejected, dismissed, and not_sure candidates are excluded so a
-- re-run may surface a new pending candidate after a prior adjudication.
create unique index discovery_candidates_one_pending_per_evidence on public.discovery_candidates (user_id, evidence_id)
where
  status = 'pending';

-- FK support for user_id.
create index discovery_candidates_user_id_idx on public.discovery_candidates (user_id);

-- ---------------------------------------------------------------------------
-- discovery_candidates · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.discovery_candidates enable row level security;

-- Deny by default. Authenticated users may read their own candidate rows;
-- all writes go through the server-side adjudication service.
create policy "discovery_candidates_select_own" on public.discovery_candidates for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- discovery_candidates · Privileges
-- ---------------------------------------------------------------------------
revoke all on public.discovery_candidates
from
  anon;

grant
select
  on public.discovery_candidates to authenticated;

-- service_role: all verbs. The adjudication service inserts and updates
-- candidate rows; auth.users cascade issues deletes on account deletion.
grant
select
,
  insert,
update,
delete on public.discovery_candidates to service_role;

-- ============================================================
-- 3. discovery_rejections
-- ============================================================
-- Permanent rejection fingerprints written when a user rejects a candidate or
-- de-confirms a previously confirmed discovery asset (ADR-007 §8, ADR-008 §5).
-- The fingerprint is HMAC-SHA256 under a per-user rejection key wrapped in
-- user_encryption_keys (key_purpose = 'rejection', ATL-200), stored in the
-- JSON envelope format defined by ADR-008 §5. It is not AES-encrypted:
-- randomised ciphertext would destroy the equality-lookup semantics required
-- for run-time candidate suppression. Protection is provided by the keyed-HMAC
-- construction, the per-user key, RLS, and the wrapped key infrastructure.
create table public.discovery_rejections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- HMAC-SHA256 fingerprint in the ADR-008 §5 envelope format:
  -- {"v":1,"alg":"hmac-sha256","value":"<base64url>"}
  -- Stored as text; not AES-encrypted (equality lookup required, ADR-008 §5).
  fingerprint text not null,
  -- Provider registry identifier for the rejected signal. Used by the
  -- suppression check to scope lookup to the relevant provider.
  provider_class text not null check (provider_class ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz not null default now(),
  -- A user may not hold two rejection rows with the same fingerprint.
  -- The fingerprint already encodes (provider_class, source_identifier) so
  -- equality within a user's records indicates either a duplicate write or a
  -- canonicalization collision, both of which are programming errors.
  constraint discovery_rejections_user_fingerprint_key unique (user_id, fingerprint)
);

comment on table public.discovery_rejections is 'Permanent rejection fingerprints written when a user rejects a candidate or de-confirms a discovery asset (ATL-202, ADR-007 §8, ADR-008 §5). Fingerprints suppress re-surfacing of the matched signal in all future runs. They are retained until account deletion; crypto-shredding on deletion destroys the rejection key, rendering fingerprints meaningless without it.';

comment on column public.discovery_rejections.fingerprint is 'HMAC-SHA256 fingerprint in ADR-008 §5 envelope: {"v":1,"alg":"hmac-sha256","value":"<base64url>"}. Not AES-GCM encrypted: randomised ciphertext destroys equality-lookup semantics required for run-time suppression. Protected by the per-user rejection key (user_encryption_keys key_purpose = rejection, ATL-200), the keyed-HMAC construction, RLS, and the wrapped key infrastructure.';

comment on column public.discovery_rejections.provider_class is 'Provider registry identifier for the rejected signal. Scopes the suppression check to the relevant provider so a rejection of one provider''s result does not suppress an identical signal from a different provider.';

-- ---------------------------------------------------------------------------
-- discovery_rejections · indexes
-- ---------------------------------------------------------------------------
-- The UNIQUE constraint on (user_id, fingerprint) already creates an index
-- that serves the run-time suppression check:
--   WHERE user_id = $1 AND fingerprint = $2
-- No additional compound index is needed for that access pattern.
-- FK support for user_id.
create index discovery_rejections_user_id_idx on public.discovery_rejections (user_id);

-- ---------------------------------------------------------------------------
-- discovery_rejections · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.discovery_rejections enable row level security;

-- Deny by default. Authenticated users may read their own rejection rows;
-- all writes go through the server-side adjudication service.
create policy "discovery_rejections_select_own" on public.discovery_rejections for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- discovery_rejections · Privileges
-- ---------------------------------------------------------------------------
revoke all on public.discovery_rejections
from
  anon;

grant
select
  on public.discovery_rejections to authenticated;

-- service_role: all verbs. The adjudication service inserts fingerprints;
-- auth.users cascade issues deletes on account deletion (crypto-shredding).
grant
select
,
  insert,
update,
delete on public.discovery_rejections to service_role;

-- ============================================================
-- 4. digital_assets — wire the deferred candidate_id FK
-- ============================================================
-- ATL-200 added digital_assets.candidate_id as a nullable uuid column, noting
-- that the FK to discovery_candidates could not be added until that table
-- existed. discovery_candidates now exists; the FK is added here.
-- The cross-user composite form FOREIGN KEY (user_id, candidate_id) is required
-- (ADR-008 §10): a plain candidate_id FK would allow a digital_assets row owned
-- by user A to reference a discovery_candidates row owned by user B.
-- discovery_candidates_user_id_id_key (UNIQUE (user_id, id)) above satisfies
-- the PostgreSQL requirement for the referenced composite key to be unique.
alter table public.digital_assets
add constraint digital_assets_candidate_id_fkey foreign key (user_id, candidate_id) references public.discovery_candidates (user_id, id);
