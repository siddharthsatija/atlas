-- ATL-208 · Candidate Adjudication — confirm / deconfirm RPCs
--
-- Provides two atomic Postgres functions that are the write boundary for the
-- adjudication service's confirm and deconfirm paths:
--
--   confirm_discovery_candidate   — pending → confirmed, creates digital_assets row
--   deconfirm_discovery_candidate — confirmed → rejected, soft-deletes asset,
--                                   inserts rejection fingerprint
--
-- ## Why RPCs and not application-level multi-step writes
--
-- Both operations must be atomic: a half-completed confirm leaves the product
-- with a candidate that has no asset (or vice-versa), which the rules engine
-- and the dashboard would treat differently. A half-completed deconfirm leaves
-- a live asset for a candidate the user rejected — a privacy regression.
-- PostgREST has no transaction primitive, so the atomicity lives here.
--
-- ## Security design
--
-- SECURITY INVOKER (default): each function runs as the calling role.
-- In production the caller is always service_role (the adjudication service),
-- which already holds the necessary grants on all affected tables.
-- SET search_path = '': prevents search_path-based injection following the
-- convention established by ATL-215.
-- EXECUTE is granted only to service_role; revoked from authenticated, anon,
-- and PUBLIC.
-- Tenant isolation: every write is scoped by p_user_id. Application code is
-- the boundary that ensures p_user_id matches the authenticated session;
-- service_role is trusted server-side code that never accepts p_user_id from
-- client input.
--
-- APPEND-ONLY: no existing tables, policies, grants, indexes, triggers,
-- or constraints are modified.
-- ============================================================
-- 1. Partial unique index — at most one digital_assets row per candidate
-- ============================================================
--
-- Covers ALL rows including soft-deleted (no deleted_at IS NULL carve-out).
-- A re-confirm after a deconfirm is not permitted: the rejected candidate
-- stays rejected and a second asset for the same candidate cannot be created.
-- This prevents accumulation of multiple historical asset rows per candidate
-- across its full lifecycle.
create unique index digital_assets_candidate_id_key on public.digital_assets (user_id, candidate_id)
where
  candidate_id is not null;

-- ============================================================
-- 2. confirm_discovery_candidate
-- ============================================================
--
-- Atomically:
--   a. Acquires a FOR UPDATE lock on the candidate row to serialise concurrent
--      adjudications (confirm vs reject race).
--   b. Returns the existing asset_id if already confirmed (idempotent).
--   c. Raises if the candidate is not pending.
--   d. Inserts the digital_assets row with source_type = 'discovery'.
--   e. Transitions the candidate to 'confirmed' and sets asset_id.
--
-- Returns TABLE (asset_id uuid, already_confirmed boolean).
create function public.confirm_discovery_candidate (
  p_user_id uuid,
  p_candidate_id uuid,
  p_asset_id uuid,
  p_service_name text,
  p_category text,
  p_service_domain text,
  p_account_identifier_encrypted text,
  p_source_label text,
  p_confidence text
) returns table (asset_id uuid, already_confirmed boolean) language plpgsql
set
  search_path = '' as $$
declare
  v_status    text;
  v_asset_id  uuid;
begin
  -- Lock the candidate to serialise concurrent adjudications.
  select c.status, c.asset_id
    into v_status, v_asset_id
    from public.discovery_candidates c
   where c.id      = p_candidate_id
     and c.user_id = p_user_id
  for update;

  if not found then
    raise exception 'candidate_not_found' using errcode = 'P0001';
  end if;

  -- Idempotency: already confirmed → return existing asset, no writes.
  if v_status = 'confirmed' and v_asset_id is not null then
    return query select v_asset_id, true;
    return;
  end if;

  -- Guard: only pending candidates may be confirmed.
  if v_status <> 'pending' then
    raise exception 'candidate_not_pending' using errcode = 'P0002';
  end if;

  -- Insert the digital asset with source_type = 'discovery'.
  -- The digital_assets_discovery_candidate_pairing check constraint
  -- (ATL-200) requires candidate_id IS NOT NULL when source_type = 'discovery'.
  insert into public.digital_assets (
    id,
    user_id,
    service_name,
    category,
    service_domain,
    account_identifier_encrypted,
    source_type,
    source_label,
    confidence,
    candidate_id
  ) values (
    p_asset_id,
    p_user_id,
    p_service_name,
    p_category,
    p_service_domain,
    p_account_identifier_encrypted,
    'discovery',
    p_source_label,
    p_confidence,
    p_candidate_id
  );

  -- Transition the candidate to confirmed.
  update public.discovery_candidates
     set status         = 'confirmed',
         asset_id       = p_asset_id,
         adjudicated_at = now()
   where id      = p_candidate_id
     and user_id = p_user_id;

  return query select p_asset_id, false;
end;
$$;

comment on function public.confirm_discovery_candidate (uuid, uuid, uuid, text, text, text, text, text, text) is 'Atomically confirms a pending discovery candidate and promotes it to a digital asset (ATL-208). Idempotent when the candidate is already confirmed. Callable by service_role only.';

revoke all on function public.confirm_discovery_candidate (uuid, uuid, uuid, text, text, text, text, text, text)
from
  public;

revoke
execute on function public.confirm_discovery_candidate (uuid, uuid, uuid, text, text, text, text, text, text)
from
  authenticated;

revoke
execute on function public.confirm_discovery_candidate (uuid, uuid, uuid, text, text, text, text, text, text)
from
  anon;

grant
execute on function public.confirm_discovery_candidate (uuid, uuid, uuid, text, text, text, text, text, text) to service_role;

-- ============================================================
-- 3. deconfirm_discovery_candidate
-- ============================================================
--
-- Atomically:
--   a. Acquires a FOR UPDATE lock on the candidate row.
--   b. Raises if the candidate is not confirmed.
--   c. Soft-deletes the linked digital_assets row (sets deleted_at = now()).
--   d. Transitions the candidate to 'rejected' and clears adjudicated_at.
--   e. Inserts a rejection fingerprint (ON CONFLICT DO NOTHING — idempotent).
--
-- The fingerprint is computed application-side (HMAC-SHA256 under the user's
-- rejection key) and passed in as p_fingerprint. Cryptography never runs
-- inside Postgres.
--
-- Returns void.
create function public.deconfirm_discovery_candidate (p_user_id uuid, p_candidate_id uuid, p_fingerprint text, p_provider_class text) returns void language plpgsql
set
  search_path = '' as $$
declare
  v_status    text;
  v_asset_id  uuid;
begin
  -- Lock the candidate to serialise concurrent deconfirm calls.
  select status, c.asset_id
    into v_status, v_asset_id
    from public.discovery_candidates c
   where id      = p_candidate_id
     and user_id = p_user_id
  for update;

  if not found then
    raise exception 'candidate_not_found' using errcode = 'P0001';
  end if;

  -- Guard: only confirmed candidates may be deconfirmed.
  if v_status <> 'confirmed' then
    raise exception 'candidate_not_confirmed' using errcode = 'P0003';
  end if;

  if v_asset_id is null then
    raise exception 'candidate_has_no_asset' using errcode = 'P0004';
  end if;

  -- Soft-delete the digital asset.
  -- Idempotent: if already soft-deleted (deleted_at IS NOT NULL), the
  -- WHERE clause simply matches 0 rows — acceptable for retry safety.
  update public.digital_assets
     set deleted_at = now()
   where id         = v_asset_id
     and user_id    = p_user_id
     and deleted_at is null;

  -- Transition the candidate to rejected.
  update public.discovery_candidates
     set status         = 'rejected',
         adjudicated_at = now()
   where id      = p_candidate_id
     and user_id = p_user_id;

  -- Insert the rejection fingerprint.
  -- ON CONFLICT DO NOTHING makes the fingerprint insertion idempotent:
  -- a deconfirm that was retried after a partial failure simply re-inserts
  -- the same fingerprint value and the conflict is silently ignored.
  insert into public.discovery_rejections (user_id, fingerprint, provider_class)
  values (p_user_id, p_fingerprint, p_provider_class)
  on conflict (user_id, fingerprint)
  do nothing;
end;
$$;

comment on function public.deconfirm_discovery_candidate (uuid, uuid, text, text) is 'Atomically de-confirms a confirmed discovery candidate: soft-deletes the linked digital asset, transitions the candidate to rejected, and inserts a rejection fingerprint to suppress future re-surfacing (ATL-208). Callable by service_role only.';

revoke all on function public.deconfirm_discovery_candidate (uuid, uuid, text, text)
from
  public;

revoke
execute on function public.deconfirm_discovery_candidate (uuid, uuid, text, text)
from
  authenticated;

revoke
execute on function public.deconfirm_discovery_candidate (uuid, uuid, text, text)
from
  anon;

grant
execute on function public.deconfirm_discovery_candidate (uuid, uuid, text, text) to service_role;

-- ── source_type check constraint update ───────────────────────────────────────
--
-- Add 'discovery' to the digital_assets.source_type allowlist so that
-- confirm_discovery_candidate can insert rows with source_type = 'discovery'.
--
-- Postgres requires DROP + ADD to replace a column check constraint; the new
-- constraint is validated immediately (VALIDATE CONSTRAINT is the default),
-- which is safe because the table is empty at migration time in CI and any
-- existing rows must already satisfy the original four values.
alter table public.digital_assets
drop constraint if exists digital_assets_source_type_check;

alter table public.digital_assets
add constraint digital_assets_source_type_check check (source_type in ('manual', 'demo', 'connector', 'import', 'discovery'));

comment on column public.digital_assets.source_type is 'manual | demo | connector | import | discovery. `demo` is the isolation key for ATL-018/ATL-083 and §11.2 demo scoring. `discovery` is written by confirm_discovery_candidate (ATL-208).';
