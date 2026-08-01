-- ---------------------------------------------------------------------------
-- RLS policy template
--
-- Baseline pattern from docs/03-security-and-access.md §7. Copy into a migration
-- and replace {{table}}. Do not deviate without security review.
--
-- RLS is defense in depth, NOT the only authorization layer: every service method
-- also verifies ownership server-side (security §6).
-- ---------------------------------------------------------------------------

-- 1. Standard user-owned table -------------------------------------------------

alter table public.{{table}} enable row level security;

create policy "users_read_own"
  on public.{{table}}
  for select
  using (auth.uid() = user_id);

create policy "users_insert_own"
  on public.{{table}}
  for insert
  with check (auth.uid() = user_id);

create policy "users_update_own"
  on public.{{table}}
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users_delete_own"
  on public.{{table}}
  for delete
  using (auth.uid() = user_id);


-- 2. profiles — the documented exception --------------------------------------
-- Its primary key IS the owner, so policies compare against `id`.
--
-- create policy "users_read_own_profile" on public.profiles
--   for select using (auth.uid() = id);


-- 3. Internal tables — deny all client access ---------------------------------
-- audit_events and user_encryption_keys are written only by server-only modules
-- using the service role (ADR-003, ADR-006).
--
-- alter table public.audit_events enable row level security;
-- -- Deliberately NO policies: RLS with no policy denies everything.
-- revoke update, delete on public.audit_events from authenticated, anon;
-- grant insert, select on public.audit_events to atlas_app_role;


-- 4. Cross-user foreign key safety --------------------------------------------
-- A child table must not be able to reference another user's parent row.
--
-- alter table public.digital_assets
--   add constraint digital_assets_id_user_unique unique (id, user_id);
--
-- alter table public.{{table}}
--   add constraint {{table}}_parent_same_user
--   foreign key (asset_id, user_id)
--   references public.digital_assets (id, user_id) on delete cascade;
