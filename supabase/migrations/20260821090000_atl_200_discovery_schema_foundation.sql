-- ATL-200 · Discovery schema foundation
--
-- Additive ALTER TABLE changes to five existing tables. No new tables are
-- created; new discovery tables (discovery_runs, discovery_candidates, etc.)
-- are introduced by ATL-201 and ATL-202.
--
-- Every change is append-only. Existing rows are unaffected: the new columns
-- have defaults or are nullable, the CHECK extensions only add vocabulary, and
-- the index replacement is handled atomically within this migration.
--
-- Tables touched (in dependency order):
--   1. digital_assets       — source_type + candidate_id + deleted_at + pairing
--   2. privacy_findings     — source_type + C1-D + evidence_refs_json contract
--   3. user_encryption_keys — key_purpose column + index replacement
--   4. user_personal_fields — include_in_discovery preference column
--   5. consents             — three discovery consent_type values
-- ============================================================
-- 1. digital_assets
-- ============================================================
-- 1a. Extend source_type CHECK to include 'discovery'.
--
-- The original inline constraint is unnamed; look it up by predicate content
-- and drop it before adding a named replacement that covers the full
-- vocabulary. Using pg_get_constraintdef ensures we match the right constraint
-- regardless of its auto-generated name.
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'public.digital_assets'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%source_type%manual%';
  if v_name is not null then
    execute format('alter table public.digital_assets drop constraint %I', v_name);
  end if;
end $$;

alter table public.digital_assets
add constraint digital_assets_source_type_check check (source_type in ('manual', 'demo', 'connector', 'import', 'discovery'));

-- 1b. Add nullable candidate_id.
--
-- Populated only for source_type = 'discovery'. The FK to
-- discovery_candidates (id) is deferred: that table does not exist until
-- ATL-202. ATL-202 adds the FK via a separate ALTER TABLE once
-- discovery_candidates is present.
alter table public.digital_assets
add column candidate_id uuid;

comment on column public.digital_assets.candidate_id is 'FK to discovery_candidates (id), populated only when source_type = ''discovery''. The foreign key constraint itself is added by ATL-202 once discovery_candidates exists (deferred forward reference per ATL-200 ticket). The pairing constraint below enforces that discovery rows carry a non-null value and non-discovery rows carry null.';

-- 1c. Add deleted_at for soft-deletion in the de-confirmation flow (ADR-007 §9).
--
-- Hard-deletion of a confirmed-then-de-confirmed asset is prohibited while
-- privacy_findings (ON DELETE CASCADE / RESTRICT) and data_requests reference
-- it. The de-confirmation service (ATL-208) sets deleted_at; all asset-listing,
-- score, and request-origination queries must exclude rows where this is NOT NULL.
alter table public.digital_assets
add column deleted_at timestamptz;

comment on column public.digital_assets.deleted_at is 'Soft-deletion timestamp set by the de-confirmation flow (ATL-208, ADR-007 §9). NULL means the asset row is live. Score computation, asset listing, and the request-origination flow must filter out rows where deleted_at IS NOT NULL.';

-- 1d. Conditional pairing constraint (ADR-007 §7).
--
-- Every discovery row must carry candidate_id; every non-discovery row must not.
-- This enforces the data model invariant at the DB layer and complements the
-- FK that ATL-202 will add.
alter table public.digital_assets
add constraint digital_assets_discovery_candidate_pairing check (
  (
    source_type = 'discovery'
    and candidate_id is not null
  )
  or (
    source_type != 'discovery'
    and candidate_id is null
  )
);

-- ============================================================
-- 2. privacy_findings
-- ============================================================
-- 2a. Extend source_type CHECK to include 'discovery'.
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'public.privacy_findings'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%source_type%manual%';
  if v_name is not null then
    execute format('alter table public.privacy_findings drop constraint %I', v_name);
  end if;
end $$;

alter table public.privacy_findings
add constraint privacy_findings_source_type_check check (source_type in ('manual', 'demo', 'connector', 'import', 'discovery'));

-- 2b. C1-D enforcement constraint (ADR-007 §7).
--
-- A discovery-source finding must be associated with a confirmed digital asset.
-- Non-discovery findings may still carry asset_id = NULL (e.g. R-008
-- category_concentration, which describes a user's whole footprint).
alter table public.privacy_findings
add constraint privacy_findings_discovery_requires_asset check (
  source_type != 'discovery'
  or asset_id is not null
);

-- 2c. evidence_refs_json typed-entry constraint (source-type-scoped).
--
-- For source_type = 'discovery':
--   - must be a JSONB array (not object, not scalar)
--   - array length >= 1 (a discovery finding must cite at least one piece of evidence)
--   - every element must have a non-null 'type' in the closed ADR-007 vocabulary
--     (discovery_evidence | digital_asset) and a non-null 'id'
--
-- For all other source types (including existing rows with evidence_refs_json = '{}'):
--   - no constraint applied; existing rows pass unconditionally.
--
-- A CASE expression guarantees jsonb_path_exists is only called on a
-- non-empty array. The ELSE branch uses jsonb_path_exists (a scalar
-- expression, no subquery) because PostgreSQL CHECK constraints do not
-- permit subqueries. The JSONPath filter matches any element that violates
-- the contract; NOT jsonb_path_exists returns true only when every element
-- is valid (non-null type in closed vocabulary, non-null id).
alter table public.privacy_findings
add constraint privacy_findings_discovery_refs_valid check (
  case
    when source_type != 'discovery' then true
    when jsonb_typeof(evidence_refs_json) != 'array' then false
    when jsonb_array_length(evidence_refs_json) < 1 then false
    else not jsonb_path_exists(
      evidence_refs_json,
      '$[*] ? (!exists(@.type) || @.type == null || (@.type != "discovery_evidence" && @.type != "digital_asset") || !exists(@.id) || @.id == null)'
    )
  end
);

-- ============================================================
-- 3. user_encryption_keys
-- ============================================================
-- 3a. Add key_purpose column.
--
-- Existing rows acquire key_purpose = 'content' automatically via the DEFAULT,
-- preserving all existing DEK behavior unchanged. The 'rejection' purpose is
-- introduced here at the schema layer so ATL-203 can store rejection keys
-- without a schema migration of its own; ATL-203 owns creating the
-- RejectionKeyService that actually writes rejection-purpose rows.
--
-- Vocabulary is closed: additional purposes require a new or amended ADR.
alter table public.user_encryption_keys
add column key_purpose text not null default 'content' check (key_purpose in ('content', 'rejection'));

comment on column public.user_encryption_keys.key_purpose is 'content = AES-256-GCM DEK (original behavior, all existing rows). rejection = HMAC-SHA256 key for rejection fingerprints (ATL-203, ADR-008 §8). Additional purposes require a new or amended ADR. destroyAllForUser must remain purpose-agnostic and destroy all purposes.';

-- 3b. Replace the one-active-per-user index with one-active-per-(user_id, key_purpose).
--
-- The original index user_encryption_keys_one_active_per_user enforces at most
-- one active key per user. After this migration, each (user_id, key_purpose)
-- pair may have exactly one active key, which is what allows a content key and
-- a rejection key to coexist for the same user without violating uniqueness.
drop index if exists user_encryption_keys_one_active_per_user;

create unique index user_encryption_keys_one_active_per_purpose on public.user_encryption_keys (user_id, key_purpose)
where
  status = 'active';

-- ============================================================
-- 4. user_personal_fields
-- ============================================================
-- 4a. Add include_in_discovery preference column.
--
-- The repository audit confirmed that the ATL-105 migration does not contain
-- include_in_discovery or use_for_discovery. Adding as a new column.
--
-- This is a user-controlled preference (not consent, not eligibility) that
-- gates whether a specific stored field is offered to discovery providers
-- (ADR-007 §5). Defaults to false: supplying a field does not automatically
-- include it in discovery.
alter table public.user_personal_fields
add column include_in_discovery boolean not null default false;

comment on column public.user_personal_fields.include_in_discovery is 'User preference: whether this specific field may be offered to discovery providers (ADR-007 §5). Not a consent substitute — the relevant discovery consent must also be active and the field type must be eligible for the provider. Defaults to false: supply is not automatic inclusion.';

-- ============================================================
-- 5. consents
-- ============================================================
-- 5a. Extend consent_type CHECK to include three discovery consent types.
--
-- ADR-007 §5 defines three discovery consent types. ADR-008 §12 renames
-- discovery_nonidentifying → discovery_hashed_query. All three are added here.
-- The existing four MVP consent types are preserved.
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'public.consents'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%consent_type%ai_processing%';
  if v_name is not null then
    execute format('alter table public.consents drop constraint %I', v_name);
  end if;
end $$;

alter table public.consents
add constraint consents_consent_type_check check (
  consent_type in (
    -- original MVP consent types (ATL-078)
    'ai_processing',
    'personal_fields_storage',
    'ai_conversation_history',
    'product_updates',
    -- discovery consent types (ADR-007 §5, ADR-008 §12)
    'discovery_hashed_query',
    'discovery_identifying',
    'discovery_connected_sources'
  )
);
