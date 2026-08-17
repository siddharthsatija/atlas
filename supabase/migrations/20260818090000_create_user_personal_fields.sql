-- ATL-105 · user_personal_fields
--
-- The encrypted identity-field vault request drafting needs (ADR-002,
-- architecture §7.13).
--
-- APPEND-ONLY: this migration adds one table and touches nothing that came
-- before. Every existing table, policy, grant and trigger is untouched.
--
-- ## Why this table exists at all
--
-- ADR-002 states the problem it solves: "The draft flow references
-- 'user-approved fields' that have no source. Without a defined home for this
-- data, implementation would improvise — the worst outcome for the most
-- sensitive data in the product."
--
-- The AI policy layer already enforces the rule this data will be governed by:
-- ATL-050 intersects the field keys a model claims it used against the keys the
-- person approved **in the current flow** and fails closed on a superset. That
-- enforcement is real today; the storage it enforces against is what this adds.
--
-- ## Storage is not permission
--
-- Creating this table does not put personal fields into AI context. ADR-002
-- requires per-request approval, and that step is ATL-058. Nothing in ATL-105
-- retrieves a value for the assistant, and `policy-map.ts` still supplies no
-- stored values to `draft_request`.
--
-- ## Columns are architecture §7.13
--
-- `id`, `user_id`, `field_key`, `label`, `value_encrypted`, `last_used_at` — the
-- specified list, with no domain column added.
--
-- `created_at` and `updated_at` are infrastructure rather than product
-- structure, and they follow the convention `20260730120000_create_profiles.sql`
-- established: that migration ships `public.set_updated_at()` commented as
-- "Shared by user-owned tables", and ATL-113 attached it to the two tables that
-- had been missing it precisely because a timestamp maintained by callers "is a
-- timestamp that is wrong eventually". Omitting them here would make this the
-- one user-owned table whose rows cannot be aged, and would put the maintenance
-- back in application code the trigger exists to replace.
--
-- ## Retention and deletion
--
-- Security §14: "Personal fields (`user_personal_fields`): retained until the
-- user deletes the field or the account; individually deletable at any time."
-- Individual deletion is a hard `delete` from the service; account deletion
-- takes rows through the `auth.users` cascade **and** renders every value
-- unrecoverable by destroying the user's DEK first (ADR-003 crypto-shredding),
-- which is what makes the guarantee hold even in provider backups.
-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.user_personal_fields (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The kind of identity value (§7.13).
  --
  -- Enumerated rather than shape-checked, mirroring `consents.consent_type`
  -- rather than `ai_interactions.purpose`. The distinction is whether the list
  -- is expected to grow with feature work: purposes do, and §7.13's six keys are
  -- a closed set describing what a service can be asked to identify a person by.
  -- A seventh would be a product decision, and a check constraint makes that
  -- decision visible as a migration instead of a silent new value.
  field_key text not null check (field_key in ('full_name', 'email', 'phone', 'address', 'username', 'other')),
  -- The person's own name for this value, e.g. "Personal Gmail" (ADR-002).
  --
  -- Not restricted data and deliberately not encrypted: the settings list and
  -- the draft approval step both have to render it without a decrypt, and a
  -- label the user cannot see defeats the point of labelling. Length-capped as a
  -- backstop, the same way `activity_events.summary` is.
  label text not null check (char_length(label) between 1 and 100),
  -- AES-256-GCM envelope (ADR-003), AAD `user_personal_fields.value_encrypted:<id>`.
  --
  -- The AAD binds the ciphertext to this row and this column, so a value cannot
  -- be moved between fields or between columns. That requires the id to exist
  -- before the value is sealed, so the application generates it rather than
  -- relying on the default above — the pattern
  -- `digital_assets.account_identifier_encrypted` established.
  value_encrypted text not null,
  -- When this field was last included in a request draft (ADR-002: "tracked so
  -- users can see and prune unused fields").
  --
  -- Nullable, and null for every row today: the only thing that *uses* a field
  -- is a request draft, which is ATL-058/ATL-059. `PersonalFieldService.markUsed`
  -- exists and is tested; ATL-058 is its first production caller. No write is
  -- manufactured here to make the column look busy.
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_personal_fields is 'Encrypted identity fields for request drafting (ATL-105, ADR-002, architecture §7.13). Consent-gated on write via personal_fields_storage; values masked in reads by default.';

comment on column public.user_personal_fields.value_encrypted is 'AES-256-GCM envelope. Server-decryptable, NOT end-to-end encrypted — user-facing copy must not claim otherwise (ADR-003 tradeoffs).';

comment on column public.user_personal_fields.last_used_at is 'Last inclusion in an approved request draft. Null until ATL-058 supplies the first caller.';

-- The existing shared function, attached where every user-owned table attaches
-- it. After this, no caller supplies `updated_at` and none can get it wrong.
create trigger user_personal_fields_set_updated_at
before update on public.user_personal_fields for each row
execute function public.set_updated_at ();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- Listing one person's fields, newest first, with the `id` tiebreak ATL-114
-- documents: `created_at` can tie, and a tie makes cursor pagination able to
-- repeat or skip a row at a page boundary.
--
-- **No unique index on `(user_id, field_key)`.** ADR-002's own example —
-- `label` "Personal Gmail" — only makes sense if a person can hold more than one
-- `email`. Uniqueness there would forbid the second address, which is the case
-- the label exists to distinguish.
create index user_personal_fields_user_created_idx on public.user_personal_fields (user_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.user_personal_fields enable row level security;

-- Deny by default (security §7). `auth.uid()` comes from the verified JWT, never
-- from a client-supplied value (architecture §10).
--
-- `select` is the only client policy, and it is narrower than it looks: the
-- column it exposes is ciphertext. Plaintext is reachable only through the
-- service, which decrypts, masks by default, and audits an explicit reveal.
--
-- No insert policy, because a write has to pass the `personal_fields_storage`
-- consent gate first and a client-issued insert would bypass it. No update or
-- delete policy for the same reason — and because deletion of restricted data
-- should leave an audit trail the client cannot route around.
create policy "user_personal_fields_select_own" on public.user_personal_fields for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- GRANT then RLS: two independent gates, with grants matching the policies
-- exactly so neither is wider than the other. Stated explicitly rather than left
-- to Supabase's default privileges, which is the convention every other table
-- migration here follows.
revoke all on public.user_personal_fields
from
  anon;

grant
select
  on public.user_personal_fields to authenticated;

-- `service_role` — every write is server-side, behind the consent gate.
--
-- SELECT and INSERT for reads and saves; UPDATE for editing a label or value and
-- for `markUsed` stamping `last_used_at`; DELETE because ADR-002 requires each
-- field to be individually hard-deletable and security §14 repeats it. All four
-- verbs correspond to a method that exists.
grant
select
,
  insert,
update,
delete on public.user_personal_fields to service_role;
