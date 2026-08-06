-- ATL-029 · asset_permissions
--
-- What a service is allowed to do. Architecture §7.4, §11 (R-004 broad_permission,
-- R-005 stale_permission), ADR-004 (the score's permission-exposure factor).
--
-- APPEND-ONLY: this migration adds one table and nothing else. Unlike ATL-028 it
-- needs no forward constraint on `digital_assets` — the `unique (user_id, id)`
-- that the composite foreign key below targets already exists, added by
-- ATL-028's migration. Re-adding it would fail.
--
-- ## Vocabularies, and why they are the size they are
--
-- §7.4 names the columns and enumerates none of them. Only two values appear
-- anywhere in the documentation: `broad` (R-004, ADR-004) and `active` (R-004,
-- R-005). Every vocabulary below was therefore settled as a product decision
-- rather than inferred, and each is the smallest set that satisfies the rules
-- which read it. Widening any of them later is additive; narrowing is not.
create table public.asset_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  asset_id uuid not null,
  -- What kind of permission this is, e.g. `oauth_access`, `marketing`.
  --
  -- Shape-checked here, vocabulary owned by the application
  -- (`src/lib/assets/permissions.ts`) and settled by ATL-032/033 when the
  -- add-asset form first needs it. The same reasoning as
  -- `digital_assets.category`: an append-only migration would turn every future
  -- permission kind into a forward migration racing an application constant, and
  -- no document enumerates these.
  permission_type text not null check (permission_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  /**
   * How much the permission grants.
   *
   * A closed two-value classification, not a description of the grant. ADR-004's
   * permission factor is `1 − broad-scope active ÷ total recorded`, and R-004
   * asks only "is this broad?" — so a binary is exactly what both consumers
   * read, and `broad` is the one value the documentation actually names.
   *
   * Storing the provider's raw scope string instead would put free text on a
   * child table, which is where restricted values land; deriving breadth from a
   * richer vocabulary would mean inventing both the vocabulary and the mapping.
   * A wider scope list can be added later without changing what the score reads,
   * because the score reads this classification and not the grant.
   */
  scope text not null check (scope in ('broad', 'limited')),
  /**
   * Where the permission stands.
   *
   * `active` is documented — R-004 and R-005 both scope themselves to it, and
   * ADR-004 counts "broad *active*" over "total recorded", so a revoked or
   * unverifiable permission still counts in the denominator while never counting
   * in the numerator. That asymmetry is the point: revoking a permission should
   * improve the factor, not erase the evidence that it once existed.
   *
   * `unknown` exists because Atlas's honesty rules do not let the product force
   * a user to assert a definite state about something they cannot check. It is
   * not `active`, so it never raises R-004 or R-005.
   */
  status text not null default 'active' check (status in ('active', 'revoked', 'unknown')),
  -- Drives R-005 (stale_permission: active and not verified in 365 days). Null
  -- means never verified, which is different from verified long ago — the rule
  -- must be able to tell those apart.
  --
  -- There is deliberately no expiry column. §7.4 lists none, no rule or score
  -- factor reads one, and R-005 measures staleness from this field instead. A
  -- column nothing populates and nothing reads would be invented behaviour.
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Cross-user protection, structural (architecture §8, and the pattern ATL-028
  -- established). A plain `references digital_assets (id)` would satisfy
  -- referential integrity while still allowing a row that claims one owner and
  -- points at another's asset — hidden from both by RLS, and counted by the
  -- rules engine reading with service-role.
  constraint asset_permissions_asset_fkey foreign key (user_id, asset_id) references public.digital_assets (user_id, id) on delete cascade,
  -- One row per permission kind per asset.
  --
  -- ADR-004 divides by "total recorded permissions", so a duplicate would move
  -- the denominator and change the user's score without anything about their
  -- actual exposure changing. Scope and status describe a permission; they do
  -- not make it a second one.
  constraint asset_permissions_unique_per_asset unique (user_id, asset_id, permission_type),
  -- A verification date in the future is not a fact about the past, and R-005
  -- does date arithmetic against it.
  constraint asset_permissions_last_verified_not_future check (
    last_verified_at is null
    or last_verified_at <= now()
  )
);

comment on table public.asset_permissions is 'What a service is allowed to do (ATL-029, architecture §7.4). Owner-scoped by RLS; cross-user links prevented by a composite foreign key.';

comment on column public.asset_permissions.scope is 'broad | limited. A classification, not the raw grant. ADR-004''s permission factor and R-004 both read it.';

comment on column public.asset_permissions.status is 'active | revoked | unknown. Only `active` raises R-004/R-005; all statuses count in ADR-004''s "total recorded" denominator.';

comment on column public.asset_permissions.permission_type is 'Kind of permission. Vocabulary lives in src/lib/assets/permissions.ts; constrained by shape here.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The asset detail page's permissions section (frontend §7): every permission
-- for one asset.
create index asset_permissions_asset_idx on public.asset_permissions (user_id, asset_id, permission_type);

-- R-004 and ADR-004's numerator: broad *and* active. Partial on both, because
-- that is the exact population both consumers ask for and it is a small subset
-- of a user's permissions.
create index asset_permissions_broad_active_idx on public.asset_permissions (user_id, asset_id)
where
  scope = 'broad'
  and status = 'active';

-- R-005: active permissions ordered by how long since they were verified.
-- Partial on `active` because the rule never looks at the others; `last_verified_at`
-- leads the sort so the staleness sweep is a range scan rather than a filter.
create index asset_permissions_stale_idx on public.asset_permissions (user_id, last_verified_at)
where
  status = 'active';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.asset_permissions enable row level security;

-- Deny by default (security §7). Every policy compares against `auth.uid()`,
-- which comes from the verified JWT — never a client-supplied value
-- (architecture §10).
create policy "asset_permissions_select_own" on public.asset_permissions for
select
  to authenticated using (auth.uid () = user_id);

create policy "asset_permissions_insert_own" on public.asset_permissions for insert to authenticated
with
  check (auth.uid () = user_id);

create policy "asset_permissions_update_own" on public.asset_permissions
for update
  to authenticated using (auth.uid () = user_id)
with
  check (auth.uid () = user_id);

-- DELETE is granted, as it is for `asset_data_categories` and unlike
-- `digital_assets`.
--
-- Revoking a permission is a status change and keeps the record — that is what
-- makes ADR-004's denominator meaningful. Deleting is for the different case of
-- a permission recorded by mistake, where leaving a false claim standing would
-- both mislead the user and skew their own score. An asset, by contrast, carries
-- findings and activity that explain the score, which is why its removal is a
-- status transition instead.
create policy "asset_permissions_delete_own" on public.asset_permissions for delete to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- GRANT then RLS: two independent gates, and the grants match the policies
-- exactly so neither is wider than the other.
revoke all on public.asset_permissions
from
  anon;

grant
select
,
  insert,
update,
delete on public.asset_permissions to authenticated;

-- `service_role` — the asset service (ATL-030) and demo removal (ATL-083).
grant
select
,
  insert,
update,
delete on public.asset_permissions to service_role;
