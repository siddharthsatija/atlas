-- ATL-015 · profiles
--
-- The first production migration. Implements architecture §7.1 and the RLS
-- baseline in security §7.
--
-- APPEND-ONLY: once this is applied to a shared environment it is never edited.
-- Corrections arrive as new forward migrations (CLAUDE.md, database rules).
-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.profiles (
  -- The primary key IS the owner column. This is the one documented exception
  -- to the "every user-owned table has user_id" rule (architecture §8,
  -- security §7): a profile is 1:1 with an auth user, so a separate user_id
  -- would allow two rows to disagree about who owns the profile.
  --
  -- `on delete cascade` makes account deletion remove the profile as a
  -- consequence of removing the identity, rather than depending on application
  -- code remembering to (ADR-003 account deletion).
  id uuid primary key references auth.users (id) on delete cascade,
  -- Chosen by the user during onboarding. Nullable: onboarding collects nothing
  -- until the user offers it, and a display name is never required.
  -- Length-bounded so a pathological value cannot be stored.
  display_name text check (
    display_name is null
    or (char_length(display_name) between 1 and 80)
  ),
  -- IANA zone identifier, e.g. "Europe/London". Defaulted rather than nullable
  -- so timestamp rendering always has a basis; the user can correct it later.
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  -- BCP 47 language tag. Same reasoning as timezone.
  locale text not null default 'en' check (char_length(locale) between 2 and 35),
  -- Null until onboarding finishes. Doubles as the "has onboarded" flag, so
  -- there is no separate boolean that could disagree with it.
  onboarding_completed_at timestamptz,
  -- Resumable onboarding progress: step index and choices only.
  -- NO SENSITIVE VALUES (architecture §7.1). Onboarding deliberately collects
  -- nothing restricted, so this column is not encrypted — if that ever changes,
  -- the value moves to an encrypted column rather than this one gaining
  -- exceptions.
  onboarding_state_json jsonb not null default '{}'::jsonb check (jsonb_typeof(onboarding_state_json) = 'object'),
  -- Free-text goal chosen during onboarding, from a product-defined list.
  -- Stored as text rather than an enum so ATL-016 can adjust the options
  -- without a schema migration; the allowed values are enforced in the service.
  privacy_goal text check (
    privacy_goal is null
    or (char_length(privacy_goal) between 1 and 120)
  ),
  -- Asset categories chosen during onboarding. A text array rather than a join
  -- table: it is a small, unordered set of product-defined labels with no
  -- attributes of its own, and nothing references it.
  selected_categories text[] not null default '{}'::text[] check (
    array_length(selected_categories, 1) is null
    or array_length(selected_categories, 1) <= 32
  ),
  -- Demo data must be clearly marked and separable from real data
  -- (CLAUDE.md database rules). This flag is what ATL-018 keys that separation on.
  demo_data_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'One row per authenticated user (architecture §7.1). Owner column is the primary key; RLS uses auth.uid() = id.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The primary key already indexes `id`, which is both the foreign key to
-- auth.users and the RLS predicate column, so no additional index is needed for
-- lookups or authorization. Adding one would be dead weight on every write.
--
-- A partial index on unfinished onboarding: the onboarding resume check runs on
-- every product page load until it completes, and this keeps that lookup off a
-- sequential scan as the table grows. Partial because completed profiles — the
-- eventual majority — are never the subject of that query.
create index profiles_onboarding_incomplete_idx on public.profiles (id)
where
  onboarding_completed_at is null;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
--
-- Enforced by trigger rather than by application code: a timestamp that depends
-- on every caller remembering it is a timestamp that is wrong eventually.
create or replace function public.set_updated_at () returns trigger language plpgsql
-- `security invoker` (the default) is correct here: the function performs no
-- privileged work and must not gain any.
set
  search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at is 'Maintains updated_at on row modification. Shared by user-owned tables.';

create trigger profiles_set_updated_at
before update on public.profiles for each row
execute function public.set_updated_at ();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- Deny by default (security §7): RLS is enabled and only the policies below
-- grant access. Every policy compares against auth.uid(), which comes from the
-- verified JWT — never from a client-supplied value.
create policy "profiles_select_own" on public.profiles for
select
  to authenticated using (auth.uid () = id);

create policy "profiles_insert_own" on public.profiles for insert to authenticated
with
  check (auth.uid () = id);

create policy "profiles_update_own" on public.profiles
for update
  to authenticated using (auth.uid () = id)
with
  check (auth.uid () = id);

-- No DELETE policy, deliberately.
--
-- A profile is deleted only as a consequence of deleting the auth user, which
-- the cascade above handles as part of the account-deletion workflow (ATL-081).
-- Granting clients DELETE would let a user destroy their profile while their
-- identity and all its owned records remain, leaving orphaned data with no
-- profile to govern it.
-- ---------------------------------------------------------------------------
-- Profile creation on first sign-in
-- ---------------------------------------------------------------------------
--
-- A trigger on auth.users rather than application code.
--
-- Sign-in can complete through the magic-link callback or the OAuth callback,
-- and later through any provider added. Creating the row in the database means
-- there is exactly one place it happens and no code path can forget — a profile
-- missing because one branch skipped it would surface much later as a
-- confusing null.
--
-- `security definer` is required: the trigger runs in the context of the auth
-- system inserting the user, which has no rights on public.profiles. The
-- function is therefore written to do exactly one thing, with an empty
-- search_path so it cannot be redirected by a caller-controlled path.
create or replace function public.handle_new_user () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  insert into public.profiles (id)
  values (new.id)
  -- Idempotent: a provider that re-runs the trigger, or an identity linked to
  -- an existing user, must not fail the sign-in.
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user is 'Creates the profile row when an auth user is created (ATL-015). Idempotent.';

create trigger on_auth_user_created
after insert on auth.users for each row
execute function public.handle_new_user ();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- Postgres authorization has TWO independent gates, and a row is returned only
-- if it passes both:
--
--   1. GRANT  — may this role touch this table at all?
--   2. RLS    — which rows may it touch?
--
-- RLS policies do not imply a grant. A role with a permissive policy and no
-- grant gets `42501 permission denied`, which is what happened here: every
-- policy below was correct, but `service_role` had no grant, so PostgREST
-- refused before RLS was ever evaluated.
--
-- These grants are written explicitly rather than inherited from Supabase's
-- `alter default privileges`, which does not reliably cover tables created by
-- the role the CLI applies migrations as. Relying on it is how the omission went
-- unnoticed. Every future table states its grants in its own migration.
-- `anon` — the unauthenticated PostgREST role. Granted nothing, and the grant is
-- revoked explicitly rather than merely omitted, so an inherited default cannot
-- quietly reintroduce it. Anonymous access is denied at the grant gate, before
-- RLS is consulted at all.
revoke all on public.profiles
from
  anon;

-- `authenticated` — a signed-in user acting on their own behalf. SELECT, INSERT
-- and UPDATE only, matching the three policies exactly.
--
-- DELETE is withheld deliberately, and this is the second half of the "no DELETE
-- policy" decision above: with neither a grant nor a policy, a client cannot
-- delete a profile even if a policy were added by mistake. A profile is removed
-- only by deleting the auth user, via the cascade.
grant
select
,
  insert,
update on public.profiles to authenticated;

-- `service_role` — server-only modules (security §6). It bypasses RLS by role
-- attribute, so its grant is the *only* thing standing between server code and
-- this table; that is why it is stated rather than assumed.
--
-- DELETE is included: account deletion and the retention jobs (ATL-081, ATL-103)
-- operate server-side, and withholding it would surface later as the same
-- 42501 this migration exists to fix. TRUNCATE, REFERENCES and TRIGGER are not
-- granted — no server operation needs them, and `grant all` would hand over
-- schema-shaping rights a data role has no use for.
grant
select
,
  insert,
update,
delete on public.profiles to service_role;
