-- ATL-027 · digital_assets
--
-- The record at the centre of the product: one row per online account a person
-- holds. Architecture §7.2, security §8 (encrypted-column inventory), §11 (the
-- rules engine that reads these rows).
--
-- APPEND-ONLY: this migration adds a table and touches nothing that came before.
-- The profiles, user_encryption_keys, audit_events, idempotency_keys, consents,
-- and activity_events migrations and their policies are untouched.
--
-- ## What is encrypted, and what is not
--
-- Security §3 classifies "Asset metadata" as Confidential and "Account
-- identifiers" as Restricted. The §8 inventory is authoritative and lists
-- exactly one column here: `account_identifier_encrypted`. So `service_name`,
-- `service_domain`, `notes`, and `metadata_json` are stored in plaintext
-- deliberately — they are Confidential, protected by RLS and provider-managed
-- encryption at rest, and §8 is explicit that encrypted columns are
-- non-searchable by design. Encrypting the fields the asset list must filter and
-- sort on would make the list page impossible to build without a blind-index
-- design that §8 says requires separate review.
create table public.digital_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The service this account is with, e.g. "Spotify". Confidential, not
  -- Restricted: it is what the asset list shows and sorts by.
  service_name text not null check (char_length(service_name) between 1 and 200),
  -- Bare hostname, e.g. "spotify.com". No scheme and no path — a URL here would
  -- invite a full profile link, which is a different and more identifying thing
  -- than the service a person uses.
  service_domain text check (
    service_domain is null
    or service_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  -- The **kind of service** — social, shopping, finance, and so on.
  --
  -- Shape-checked here, vocabulary enforced in the application
  -- (`src/lib/assets/categories.ts`). Not a check constraint listing the values,
  -- deliberately: that file is documented as the single definition ATL-027
  -- "inherits ... a later ticket may extend it, but it should not fork it", and
  -- an append-only migration would make every future addition a forward
  -- migration racing an application constant. Same reasoning as
  -- `activity_events.event_type`.
  --
  -- Distinct from §7.3's data categories: `social` is what a service **is**,
  -- `contact` is what it **stores**.
  category text not null check (category ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- Restricted (security §3) — the username, member number, or email the account
  -- is held under. Envelope-encrypted by the application (ADR-003), with the AAD
  -- bound to `digital_assets.account_identifier_encrypted:<row id>` so a
  -- ciphertext cannot be moved to another row or column.
  --
  -- Nullable because recording an account identifier is optional (ATL-032:
  -- "optional identifier"). A user can track that they have a Spotify account
  -- without telling Atlas which one.
  account_identifier_encrypted text,
  -- §7.2 status vocabulary. A check constraint here, unlike `category`, because
  -- these four are a closed state machine the rules engine and score depend on
  -- (§11: R-002 reads `inactive`, R-006 reads `archived`) — a fifth value
  -- appearing would silently change what those rules mean.
  status text not null default 'active' check (status in ('active', 'inactive', 'archived', 'removed')),
  -- §7.2 source vocabulary. Constrained for the same reason and one more:
  -- `demo` is the flag ATL-018 and ATL-083 key demo isolation on (§11.2 "Demo
  -- and real records never mix in one calculation"). A typo'd source value would
  -- put a demo row into a real user's score.
  source_type text not null default 'manual' check (source_type in ('manual', 'demo', 'connector', 'import')),
  -- Human-readable provenance, e.g. "Added during setup" or a connector name.
  source_label text check (
    source_label is null
    or char_length(source_label) between 1 and 120
  ),
  -- §11 confidence model: derived from source and degraded by staleness, never
  -- asserted by the user. Stored so a finding can inherit the minimum across its
  -- inputs without recomputing history.
  confidence text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  -- Drives R-001 (stale_review) and the score's verification-freshness factor.
  -- Null means never verified, which is different from verified long ago.
  last_verified_at timestamptz,
  -- The user's own free text about this account. Confidential, not Restricted,
  -- so not encrypted — but it is the one field here a user could type anything
  -- into, which is why it never appears in a log, a finding summary, or an AI
  -- prompt without passing the redaction path first.
  notes text check (
    notes is null
    or char_length(notes) <= 2000
  ),
  -- Structured, non-restricted extras. Schema-validated in the application
  -- (`src/lib/assets/asset-metadata.ts`), which is the ATL-027 acceptance
  -- criterion; the size cap here is a backstop against a caller that finds a way
  -- past it. Measured as serialised text rather than `pg_column_size`, which
  -- reports the post-TOAST-compression size and would make the effective limit
  -- depend on how compressible the payload happened to be.
  metadata_json jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata_json) = 'object'
    and length(metadata_json::text) <= 4096
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A verification date in the future is not a fact about the past. Cheap to
  -- reject here, and R-001/R-005 both do date arithmetic against it.
  constraint digital_assets_last_verified_not_future check (
    last_verified_at is null
    or last_verified_at <= now()
  )
);

comment on table public.digital_assets is 'One online account a user holds (ATL-027, architecture §7.2). Owner-scoped by RLS; account identifier is envelope-encrypted per ADR-003.';

comment on column public.digital_assets.account_identifier_encrypted is 'Restricted. AES-256-GCM envelope, AAD bound to digital_assets.account_identifier_encrypted:<id>. Never logged, never in a URL, masked on display (ATL-035).';

comment on column public.digital_assets.category is 'Kind of service (social, finance, ...). Vocabulary lives in src/lib/assets/categories.ts. Distinct from asset_data_categories.category, which is what the service stores.';

comment on column public.digital_assets.source_type is 'manual | demo | connector | import. `demo` is the isolation key for ATL-018/ATL-083 and §11.2 demo scoring.';

comment on column public.digital_assets.metadata_json is 'Non-restricted structured extras. Schema-validated in src/lib/assets/asset-metadata.ts.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The two the acceptance criteria name, plus the demo split.
--
-- `user_id` leads every one of them. Every query in the product is "this user's
-- assets, filtered somehow" (ATL-031), and an index that did not lead with the
-- owner would be useless for all of them.
-- Asset list filtered by status, and the rules engine's "active assets" scans
-- (§11 R-001, R-003, R-008). `created_at desc, id desc` carries the ordering so
-- a paginated list is a pure index scan — the same total-ordering lesson the
-- ATL-068 timeline index recorded: `created_at` alone can tie, and a tie makes
-- cursor pagination able to repeat or skip a row at a page boundary.
create index digital_assets_status_idx on public.digital_assets (user_id, status, created_at desc, id desc);

-- Asset list filtered by category (ATL-031 filters; onboarding's chosen
-- categories feed this view first).
create index digital_assets_category_idx on public.digital_assets (user_id, category, created_at desc, id desc);

-- Demo isolation (§11.2, ATL-018/ATL-083).
--
-- Partial on `source_type = 'demo'`: demo rows are a small minority of a real
-- user's data and always queried as a set — seed idempotency, demo-only scoring,
-- and one-action removal. A full index on `source_type` would be mostly
-- `manual` entries that no query asks for by source alone.
create index digital_assets_demo_idx on public.digital_assets (user_id, id)
where
  source_type = 'demo';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.digital_assets enable row level security;

-- Deny by default (security §7). Every policy compares against `auth.uid()`,
-- which comes from the verified JWT — never from a client-supplied value
-- (architecture §10).
--
-- These policies exist even though ATL-030's service layer will use the
-- service-role client, which bypasses RLS. That is the point: ATL-030's
-- acceptance criterion is that ownership is verified "in the service layer
-- **and** RLS". Two independent gates mean a service-layer bug cannot on its own
-- expose another user's assets.
create policy "digital_assets_select_own" on public.digital_assets for
select
  to authenticated using (auth.uid () = user_id);

create policy "digital_assets_insert_own" on public.digital_assets for insert to authenticated
with
  check (auth.uid () = user_id);

create policy "digital_assets_update_own" on public.digital_assets
for update
  to authenticated using (auth.uid () = user_id)
with
  check (auth.uid () = user_id);

-- No DELETE policy for clients, deliberately.
--
-- Removal is a status transition, not a row deletion: §7.2 defines `archived`
-- and `removed`, ATL-036 owns archive and restore, and architecture §8 permits
-- soft deletion exactly where user recovery requires it. A client DELETE would
-- also destroy the findings, permissions, and activity that reference the asset,
-- which is how a user loses the history that explains their own score.
--
-- Hard deletion happens in two places, both server-side: demo-data removal
-- (ATL-083) and the account cascade above.
-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- Postgres has two independent gates — GRANT, then RLS — and a row is returned
-- only if it passes both. The grants below match the policies exactly, so
-- neither gate is wider than the other.
revoke all on public.digital_assets
from
  anon;

grant
select
,
  insert,
update on public.digital_assets to authenticated;

-- `service_role` — the asset service (ATL-030) and demo removal (ATL-083).
--
-- DELETE is granted here and nowhere else, for the two server-side cases named
-- above.
grant
select
,
  insert,
update,
delete on public.digital_assets to service_role;
