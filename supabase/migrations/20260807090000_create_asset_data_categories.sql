-- ATL-028 · asset_data_categories
--
-- What a service stores about the user. Architecture §7.3, §11 (R-002, R-003,
-- R-008 all read these rows), ADR-004 (the score's data-sensitivity factor).
--
-- APPEND-ONLY: this migration adds a table and one constraint. It edits no
-- existing migration. The `unique` added to `digital_assets` below is additive —
-- a forward migration, which is the sanctioned way to extend a shipped table.
--
-- ## Distinct from §7.2's asset category
--
-- `digital_assets.category` is what a service **is** (social, finance).
-- `asset_data_categories.category` is what it **stores** (contact, financial).
-- The two are easy to confuse and are never interchangeable — a `social` service
-- commonly holds `contact`, `content`, and `behavioral` data.
-- ---------------------------------------------------------------------------
-- Cross-user foreign key protection
-- ---------------------------------------------------------------------------
--
-- Architecture §8: "Foreign keys must prevent cross-user relationships."
--
-- A plain `references digital_assets (id)` would satisfy referential integrity
-- and still allow a row that claims one owner while pointing at another's asset.
-- RLS would hide the row from both of them, which looks like safety but is
-- actually a silent corruption: the data is wrong, nobody can see it, and the
-- rules engine reading with service-role would count it.
--
-- The composite reference below makes that unrepresentable. It needs a unique
-- key on the parent's `(user_id, id)` — `id` is already unique on its own, so
-- this adds no new restriction, only the target the composite FK requires.
alter table public.digital_assets
add constraint digital_assets_user_id_id_key unique (user_id, id);

create table public.asset_data_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  asset_id uuid not null,
  -- §7.3 vocabulary, enumerated in full there — so a check constraint is right
  -- here, unlike `digital_assets.category`, which §7.2 leaves open and which is
  -- therefore constrained by shape and owned by the application.
  category text not null check (
    category in (
      'identity',
      'contact',
      'location',
      'financial',
      'behavioral',
      'biometric',
      'content',
      'device',
      'professional',
      'health',
      'other'
    )
  ),
  /**
   * Derived from `category`, never supplied.
   *
   * ADR-004 defines the high-sensitivity set as exactly financial, health,
   * biometric, and location, and the score's sensitivity factor counts
   * active-asset × high-sensitivity-category pairs from that list. A writable
   * column would let a stored value disagree with the ADR the score reads —
   * two sources of truth for one fact, and the user could downgrade a
   * `financial` category to keep it out of their own score.
   *
   * A generated column rather than a check constraint: a check would still
   * require every caller to compute and pass the right value, and would only
   * catch the ones that got it wrong. Generated means there is nothing to pass.
   */
  sensitivity text generated always as (
    case
      when category in ('financial', 'health', 'biometric', 'location') then 'high'
      else 'standard'
    end
  ) stored,
  -- What the user knows about this data. Confidential, not Restricted, so not
  -- encrypted — but free text, so it never reaches a log, a finding summary, or
  -- an AI prompt without passing the redaction path first.
  description text check (
    description is null
    or char_length(description) between 1 and 1000
  ),
  -- Where the claim came from. Shape-checked here and enforced in the
  -- application against §7.2's source vocabulary, which this inherits rather
  -- than forks — a data category learned from a connector has the same
  -- provenance kinds an asset does.
  source text check (
    source is null
    or source ~ '^[a-z][a-z0-9_]{0,31}$'
  ),
  -- §11's confidence model, same three levels as `digital_assets.confidence`.
  confidence text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The composite reference described above. `on delete cascade` because a data
  -- category has no meaning without its asset.
  constraint asset_data_categories_asset_fkey foreign key (user_id, asset_id) references public.digital_assets (user_id, id) on delete cascade,
  -- One row per category per asset.
  --
  -- ADR-004 counts "active-asset × high-sensitivity-category pairs", and R-008
  -- counts assets holding the same category. A duplicate row would inflate both
  -- — the user's score would drop because the same fact was recorded twice.
  constraint asset_data_categories_unique_per_asset unique (user_id, asset_id, category)
);

comment on table public.asset_data_categories is 'What a service stores about the user (ATL-028, architecture §7.3). Owner-scoped by RLS; cross-user links prevented by a composite foreign key.';

comment on column public.asset_data_categories.category is 'What the service STORES. Distinct from digital_assets.category, which is what the service IS.';

comment on column public.asset_data_categories.sensitivity is 'Generated from category. `high` for ADR-004''s set (financial, health, biometric, location), `standard` otherwise. Never supplied by a caller.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The asset detail page's "information held" section (frontend §7): every
-- category for one asset.
create index asset_data_categories_asset_idx on public.asset_data_categories (user_id, asset_id, category);

-- R-008 category_concentration: "same high-sensitivity category held by 5+
-- active assets". The rule scans by category across a user's assets, which the
-- asset-leading index above cannot serve.
create index asset_data_categories_category_idx on public.asset_data_categories (user_id, category, asset_id);

-- The score's data-sensitivity factor (ADR-004) and R-003, both of which ask
-- only for the high-sensitivity rows. Partial, because `standard` rows are the
-- majority and no query filters on them alone.
create index asset_data_categories_sensitive_idx on public.asset_data_categories (user_id, asset_id)
where
  sensitivity = 'high';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.asset_data_categories enable row level security;

-- Deny by default (security §7). Every policy compares against `auth.uid()`,
-- which comes from the verified JWT — never a client-supplied value.
create policy "asset_data_categories_select_own" on public.asset_data_categories for
select
  to authenticated using (auth.uid () = user_id);

create policy "asset_data_categories_insert_own" on public.asset_data_categories for insert to authenticated
with
  check (auth.uid () = user_id);

create policy "asset_data_categories_update_own" on public.asset_data_categories
for update
  to authenticated using (auth.uid () = user_id)
with
  check (auth.uid () = user_id);

-- DELETE **is** granted here, unlike `digital_assets`.
--
-- Removing a category from an asset is ordinary editing (ATL-033 "Edit ... data
-- categories"), not the destruction of a record with its own history. An asset
-- carries findings, permissions, and activity that explain a user's score, which
-- is why deleting one is a status transition instead; a data category carries
-- none of that, and a user who mistakenly recorded that a service holds their
-- health data must be able to take it back rather than leave a false claim
-- standing.
--
-- Findings referencing a removed category auto-resolve, because §11's engine
-- resolves a finding when its predicate no longer holds.
create policy "asset_data_categories_delete_own" on public.asset_data_categories for delete to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- GRANT then RLS: two independent gates, and the grants match the policies
-- exactly so neither is wider than the other.
revoke all on public.asset_data_categories
from
  anon;

grant
select
,
  insert,
update,
delete on public.asset_data_categories to authenticated;

-- `service_role` — the asset service (ATL-030) and demo removal (ATL-083).
grant
select
,
  insert,
update,
delete on public.asset_data_categories to service_role;
