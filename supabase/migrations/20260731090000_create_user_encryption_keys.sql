-- ATL-084 · user_encryption_keys
--
-- Per-user wrapped data-encryption keys for the ADR-003 envelope scheme.
-- Architecture §7.16, security §8.
--
-- APPEND-ONLY: this migration adds a table and touches nothing that came before.
-- The profiles migration and its policies are untouched.
--
-- rls: deny-all
--
-- This table has **no client policies at all**. Wrapped key material is never
-- readable by `anon` or `authenticated`, even for the owning user: a user has no
-- operation that requires their own wrapped DEK, and exposing it would put
-- KEK-encrypted material in reach of any RLS mistake. Only server-side
-- service-role modules touch it (security §7, architecture §7.16).
create table public.user_encryption_keys (
  id uuid primary key default gen_random_uuid(),
  -- Owner. `user_id` rather than reusing the primary key, because a user may hold
  -- several key rows over time: one active, retired predecessors after a DEK
  -- rotation, and destroyed tombstones after crypto-shredding.
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The DEK, encrypted under the environment KEK. Never the raw key.
  --
  -- Nullable only so crypto-shredding can destroy the material in place while
  -- keeping the row as evidence that a key once existed and was destroyed. The
  -- constraint below makes "null material" and "destroyed" inseparable.
  wrapped_dek text check (
    wrapped_dek is null
    or (char_length(wrapped_dek) between 1 and 1024)
  ),
  -- Which KEK generation wrapped this DEK. KEK rotation re-wraps and bumps this;
  -- rows on the previous version stay readable until the sweep completes.
  kek_version integer not null check (kek_version > 0),
  -- active   — the key new writes use. At most one per user.
  -- retired  — superseded by a DEK rotation; still needed to read old rows.
  -- destroyed — crypto-shredded. Material is gone and cannot be recovered.
  status text not null default 'active' check (status in ('active', 'retired', 'destroyed')),
  destroyed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Destruction is all-or-nothing.
  --
  -- Without this, a partially-shredded row — status destroyed but material still
  -- present, or material cleared while the row still reads as active — would be
  -- indistinguishable from a healthy one. Crypto-shredding is the deletion
  -- guarantee (security §16 step 5), so its record must not be ambiguous.
  constraint user_encryption_keys_destruction_is_complete check (
    (
      status = 'destroyed'
      and wrapped_dek is null
      and destroyed_at is not null
    )
    or (
      status <> 'destroyed'
      and wrapped_dek is not null
      and destroyed_at is null
    )
  )
);

comment on table public.user_encryption_keys is 'Per-user DEKs wrapped by the environment KEK (ADR-003). Service-role only; no client policies.';

comment on column public.user_encryption_keys.wrapped_dek is 'DEK encrypted under the KEK. Null only for destroyed (crypto-shredded) keys.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- At most one active key per user. A unique partial index rather than
-- application logic: two active DEKs would silently split a user's data across
-- keys, and half of it would survive a crypto-shred that only destroyed one.
create unique index user_encryption_keys_one_active_per_user on public.user_encryption_keys (user_id)
where
  status = 'active';

-- Foreign-key and sweep support: rotation and shredding both scan by user
-- (CLAUDE.md database rules — index foreign keys).
create index user_encryption_keys_user_id_idx on public.user_encryption_keys (user_id);

-- KEK rotation selects every DEK still wrapped by an older generation.
create index user_encryption_keys_kek_version_idx on public.user_encryption_keys (kek_version)
where
  status <> 'destroyed';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
--
-- Reuses the trigger function created with `profiles`, which was written to be
-- shared. No new function, and the existing one is not altered.
create trigger user_encryption_keys_set_updated_at
before update on public.user_encryption_keys for each row
execute function public.set_updated_at ();

-- ---------------------------------------------------------------------------
-- Row Level Security — deny all
-- ---------------------------------------------------------------------------
--
-- RLS is enabled and **no policy is created**. With RLS on and no policy, every
-- client role is denied every row: there is nothing to get wrong, because there
-- is no predicate to get wrong.
--
-- This is the internal-table pattern from security §7, the same one
-- `audit_events` will use (ADR-006).
alter table public.user_encryption_keys enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- The grant gate is the primary control here, not a backstop. `anon` and
-- `authenticated` are revoked explicitly so a future policy added by mistake
-- still cannot expose key material — a policy without a grant grants nothing.
revoke all on public.user_encryption_keys
from
  anon;

revoke all on public.user_encryption_keys
from
  authenticated;

-- `service_role` gets exactly what the key lifecycle needs:
--   select — read the wrapped DEK to unwrap it
--   insert — create a DEK on first restricted write
--   update — re-wrap during KEK rotation, retire during DEK rotation, and
--            destroy during crypto-shredding
--
-- DELETE is withheld deliberately. A destroyed key row is retained as evidence
-- that the material existed and was destroyed; final removal happens through the
-- `auth.users` cascade at account deletion, which does not consult this grant.
grant
select
,
  insert,
update on public.user_encryption_keys to service_role;
