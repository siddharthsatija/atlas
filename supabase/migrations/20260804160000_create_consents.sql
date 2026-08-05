-- ATL-078 · consents
--
-- Consent record and history. Architecture §7.10, security §12 (consent changes
-- are audited), ADR-002 (`personal_fields_storage` gates the vault).
--
-- APPEND-ONLY: this migration adds a table and touches nothing that came before.
-- The profiles, user_encryption_keys, audit_events, and idempotency_keys
-- migrations and their policies are untouched.
--
-- SCHEMA CHANGE vs architecture §7.10: `revoked_at` is deliberately absent.
--
-- §7.10 listed `granted` and `revoked_at` together, which only makes sense if a
-- revocation UPDATEs the original grant row. ATL-078 requires each grant and each
-- revoke to write an **immutable** row, and the two cannot both hold: filling in
-- `revoked_at` means mutating a row that is supposed to be evidence of what was
-- agreed at a point in time. An append-only log also makes
-- grant -> revoke -> re-grant reconstructible, which a single mutable row cannot
-- represent at all. Architecture §7.10 is updated to match.
create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The four MVP consent types (ATL-078). A check constraint rather than an
  -- application-only rule: an unrecognised consent type would silently gate
  -- nothing, and a gate that fails open is worse than one that fails loudly.
  consent_type text not null check (
    consent_type in ('ai_processing', 'personal_fields_storage', 'ai_conversation_history', 'product_updates')
  ),
  -- Which version of the policy the user agreed to.
  --
  -- Recorded per row, not looked up later: consent is to the terms as they stood
  -- at that moment, so a policy change must not retroactively rewrite what
  -- somebody agreed to. Comparing this against the current version is how
  -- re-consent is detected.
  policy_version text not null check (policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  -- true = granted, false = revoked. Both are rows; neither is an update.
  granted boolean not null,
  recorded_at timestamptz not null default now()
);

comment on table public.consents is 'Append-only consent history (ATL-078, architecture §7.10). Each grant and revoke is an immutable row; current state is the latest row per (user_id, consent_type).';

comment on column public.consents.policy_version is 'Policy version in force when the decision was recorded. Never back-filled — consent is to the terms as they stood.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The consent gate's only question: what is the newest decision for this user
-- and this consent type? Descending on `recorded_at` so the answer is the first
-- row of the scan rather than a sort over the user's whole history.
create index consents_user_type_recorded_idx on public.consents (user_id, consent_type, recorded_at desc);

-- Foreign-key support (CLAUDE.md database rules — index foreign keys).
create index consents_user_id_idx on public.consents (user_id);

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------
--
-- UPDATE is refused for every role, including the table owner. A consent row is
-- evidence of what a user agreed to and when; editing one after the fact is
-- never a legitimate operation, so it is blocked in the database rather than
-- left to convention.
--
-- **DELETE is deliberately NOT blocked by a trigger**, unlike `audit_events`.
-- This table has a foreign key to `auth.users` with `on delete cascade`, and a
-- cascade issues a real DELETE against these rows. A BEFORE DELETE trigger that
-- raised would therefore make account deletion impossible — turning an
-- immutability guard into a privacy defect. DELETE is withheld by grant instead,
-- which the cascade does not consult.
create function public.consents_reject_update () returns trigger language plpgsql as $$
begin
  raise exception
    'consents is append-only (ATL-078): revoke by inserting a new row'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function public.consents_reject_update () is 'Enforces ATL-078 append-only semantics even for owner and superuser connections.';

create trigger consents_no_update
before update on public.consents for each row
execute function public.consents_reject_update ();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.consents enable row level security;

-- Deny by default (security §7). Unlike the internal tables added in ATL-084,
-- ATL-103, and ATL-104, this one IS user-facing: Settings renders consent
-- history (PRD §12, ATL-076), so the owner may read their own rows.
--
-- `auth.uid()` comes from the verified JWT, never from a client-supplied value.
create policy "consents_select_own" on public.consents for
select
  to authenticated using (auth.uid () = user_id);

-- No INSERT policy, deliberately.
--
-- A consent write must stamp the server's current policy version and emit an
-- audit event (security §12). A client that could insert directly would be able
-- to record consent to a version it chose, with no audit trail — so writes go
-- through the server-only consent service and nowhere else.
-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.consents
from
  anon;

-- `authenticated` — read-only, matching the single policy exactly. Writing,
-- editing, and deleting consent are all server-side operations.
grant
select
  on public.consents to authenticated;

-- `service_role` — the consent service.
--
-- No UPDATE (the trigger would refuse it anyway) and no DELETE: consent history
-- is removed only by deleting the auth user, via the cascade. Withholding DELETE
-- keeps "the user revoked this" distinguishable from "this never happened".
grant
select
,
  insert on public.consents to service_role;
