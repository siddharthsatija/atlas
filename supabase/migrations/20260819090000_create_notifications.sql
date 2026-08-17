-- ATL-107 · notifications, notification_preferences
--
-- In-app notifications and the per-type preference overrides that govern them
-- (ADR-005, architecture §7.14, FR-14).
--
-- APPEND-ONLY: this migration adds two tables and touches nothing that came
-- before. Every existing table, policy, grant, index and trigger is untouched.
--
-- ## Why these tables exist
--
-- ADR-005 states the gap: "The top bar has a notification control, Settings
-- manages notification preferences, and follow-up reminders depend on notifying
-- users — yet no notifications data model, unread state, or delivery channel
-- existed anywhere." Three tickets are blocked on this one: ATL-108 (badge and
-- panel), ATL-077 (preference UI), and ATL-066 (follow-up reminders, promoted to
-- P0 because of it).
--
-- ## Scope: no creators are wired yet
--
-- Every future creator is a later ticket — the follow-up job (ATL-066), the
-- findings sweep, and security events. This migration and its service make the
-- seam real and tested; no write is manufactured to make the table look busy.
-- The same discipline `user_personal_fields.last_used_at` records for ATL-058.
--
-- ## SCHEMA ADDITION vs architecture §7
--
-- §7.14 specifies `notifications`. It specifies no preference storage, and none
-- existed anywhere in the product: `profiles` has no such column, `consents` is
-- an append-only history of user agreements rather than a mutable toggle, and
-- `src/lib/preferences/` held only a client cookie for sidebar collapse. ATL-077
-- depends on ATL-107 for it, so this ticket owns it.
--
-- `notification_preferences` is a dedicated table rather than a JSON column on
-- `profiles`: a toggle per (user, type) is relational, and a blob would
-- reintroduce the parse-defensively problem `profiles.onboarding_state_json`
-- documents at length. Architecture §7 is updated to describe it.
--
-- ## Overrides only. Defaults are code.
--
-- A row here means "this person changed their mind about this type". Absence
-- means "use the default declared in `src/lib/notifications/notification-types.ts`".
-- The alternative — a row per user per type, written at signup — would make the
-- default a stored value, requiring a backfill and leaving accounts created
-- before a default changed permanently disagreeing with accounts created after,
-- with nothing in the schema recording which is which. Defaults are a product
-- decision, so they change through a code review and a diff.
-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The five ADR-005 types, enumerated (§7.14).
  --
  -- A check constraint rather than an application-only rule, mirroring
  -- `consents.consent_type` and `user_personal_fields.field_key`: the constraint
  -- stops an unrecognised value reaching storage and the TypeScript union stops
  -- one being written in the first place. Both exist on purpose. An unknown type
  -- would render as a blank panel row and would be invisible to preference
  -- checks — a notification that cannot be read or governed.
  --
  -- A sixth value is a product decision, and a check constraint makes that
  -- decision visible as a migration instead of a silent new string.
  type text not null check (type in ('follow_up_due', 'request_status', 'security', 'finding_new', 'system')),
  -- Composed server-side from the type's template; never accepted as free text.
  --
  -- `NotificationService` builds both strings from
  -- `NOTIFICATION_DEFINITIONS[type]` over a closed parameter type with no
  -- free-text member, then scans the result for restricted patterns and refuses
  -- to store it if any survive (ATL-085). That is why these columns are plain
  -- text and unencrypted: ADR-005 permits service names and statuses only, so
  -- there is deliberately nothing here worth encrypting. Length caps are a
  -- backstop, exactly as on `activity_events.summary`.
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 400),
  -- What the panel row links to (frontend §4.1). Both or neither.
  --
  -- Shape-checked rather than enumerated, matching `activity_events.entity_type`:
  -- the set of linkable entities grows with feature work, so a closed list here
  -- would need a migration for every new surface that can be notified about.
  entity_type text check (entity_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  entity_id uuid,
  -- Unread state is the absence of a timestamp (ADR-005), not a boolean.
  --
  -- A `read` flag would answer "is it read" and nothing else; a timestamp also
  -- answers "when", which is what lets a panel order or group by it later
  -- without a second column and a migration.
  read_at timestamptz,
  created_at timestamptz not null default now(),
  -- Paired, so a row can never claim a link it cannot complete. `activity_events`
  -- carries the same constraint for the same reason: half a link renders as a
  -- dead control.
  constraint notifications_entity_pair check (
    (
      entity_type is not null
      and entity_id is not null
    )
    or (
      entity_type is null
      and entity_id is null
    )
  )
);

-- No `updated_at`, and no `set_updated_at` trigger.
--
-- Deliberate, and architecture §7.14 says so explicitly ("`created_at` (no
-- `updated_at`)"). A notification is a fact about a moment; `read_at` is the only
-- column that ever changes and it is itself a timestamp, so a second one would
-- record nothing the first does not. This is the one user-owned table that
-- legitimately omits the shared trigger.
comment on table public.notifications is 'In-app notifications (ATL-107, ADR-005, architecture §7.14). Created server-side only; title and body are composed from templates and carry no personal values or draft text.';

comment on column public.notifications.body is 'Template-composed and redaction-scanned. ADR-005 permits service names and statuses only — never a personal value, never draft text.';

comment on column public.notifications.read_at is 'Null means unread. The unread count is a count of nulls.';

-- ---------------------------------------------------------------------------
-- notifications · indexes
-- ---------------------------------------------------------------------------
--
-- The panel: one person's notifications, newest first, with the `id` tiebreak
-- ATL-114 documents — `created_at` can tie, and a tie makes cursor pagination
-- able to repeat or skip a row at a page boundary.
create index notifications_user_created_idx on public.notifications (user_id, created_at desc, id desc);

-- The badge (frontend §4.1, D7: the service returns a true count).
--
-- Partial, so the index holds only unread rows. It stays small no matter how much
-- history a person accumulates, and it shrinks as they read — which is the
-- opposite of how the full index above behaves, and the reason this is a second
-- index rather than a prefix of the first.
create index notifications_unread_idx on public.notifications (user_id)
where
  read_at is null;

-- Marking a linked entity's notification read when the entity is opened
-- (ADR-005: "Opening a linked entity marks its notification read").
create index notifications_entity_idx on public.notifications (user_id, entity_type, entity_id)
where
  entity_type is not null;

-- ---------------------------------------------------------------------------
-- notifications · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.notifications enable row level security;

-- Deny by default (security §7). `auth.uid()` comes from the verified JWT, never
-- from a client-supplied value (architecture §10).
--
-- `select` is the only client policy.
--
-- **No insert policy**: ADR-005 requires creation to be server-side only, and a
-- client that could insert could forge a security notification — the one type
-- nobody can switch off — or bypass the preference check and the redaction scan
-- that make a notification safe to render.
--
-- **No update policy**, even for `read_at`. Column-level grants could have
-- narrowed it to that one column, and marking your own notification read is
-- harmless in itself; the reason not to is that ATL-108's read-state actions run
-- server-side regardless, so a client policy would add a second write path with
-- no caller. A path nobody uses is a path nobody tests.
--
-- **No delete policy**: retention is the 90-day purge (security §14) and the
-- account cascade. A person deleting individual notifications is not a behaviour
-- any document describes, and inventing it here would be product design in a
-- migration.
create policy "notifications_select_own" on public.notifications for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- notifications · privileges
-- ---------------------------------------------------------------------------
--
-- GRANT then RLS: two independent gates, with grants matching the policies
-- exactly so neither is wider than the other. Stated explicitly rather than left
-- to Supabase's defaults, which is the convention every other table migration
-- here follows.
revoke all on public.notifications
from
  anon;

grant
select
  on public.notifications to authenticated;

-- `service_role` — every write is server-side.
--
-- SELECT for the panel and the badge; INSERT for creation; UPDATE for the
-- read-state operations (`markRead`, `markAllRead`); DELETE for the 90-day purge
-- (security §14). All four verbs correspond to a method that exists.
grant
select
,
  insert,
update,
delete on public.notifications to service_role;

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------
create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Constrained twice, on purpose, because the two constraints say different
  -- things and one of them is a privacy guarantee.
  --
  -- The vocabulary check is the same rule `notifications.type` carries: a value
  -- outside the five is not a type, and a preference for a type that does not
  -- exist governs nothing.
  notification_type text not null,
  -- true = the person wants this type, false = they turned it off. Not nullable:
  -- a null would be a third state meaning "no opinion", which is what the
  -- **absence of the row** already means. Two encodings of one fact is how they
  -- come to disagree.
  enabled boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_preferences_type_known check (notification_type in ('follow_up_due', 'request_status', 'security', 'finding_new', 'system')),
  -- `security` has no switch (ADR-005, FR-14, PRD §12: "security notifications
  -- cannot be disabled").
  --
  -- Enforced in the schema, not only in the service, because the alternative is a
  -- privacy guarantee that holds *as long as no row says otherwise*. With
  -- configurability declared in code and this constraint in the database, a row
  -- that would disable security notifications cannot be written by any path —
  -- service bug, migration, psql session, or future ticket that forgot. The
  -- service refuses first and returns `INVALID_REQUEST`; this is the gate behind
  -- it, and `NotificationService` never consults a preference for `security`
  -- anyway, so even a row that somehow existed could not change the outcome.
  constraint notification_preferences_security_not_configurable check (notification_type <> 'security')
);

-- One row per (user, type). D1's whole shape: an override exists or it does not.
--
-- A unique constraint rather than a convention, because two rows for one pair
-- would make "is this type enabled" depend on which row a query happened to read
-- first, and the upsert in `NotificationPreferenceRepository` targets exactly
-- this pair to update in place rather than accumulate history. Preferences are
-- current state; `consents` is the table that keeps history, and it does so
-- because a consent is evidence of an agreement while a toggle is not.
create unique index notification_preferences_user_type_idx on public.notification_preferences (user_id, notification_type);

comment on table public.notification_preferences is 'Per-type notification overrides (ATL-107, ADR-005, D1). Absence of a row means the default declared in src/lib/notifications/notification-types.ts. No row may exist for the security type.';

comment on column public.notification_preferences.enabled is 'The person''s explicit choice. Absence of the row — not a null here — is what means "no choice made".';

-- The existing shared function, attached where every user-owned table with an
-- `updated_at` attaches it. After this, no caller supplies the column and none
-- can get it wrong (ATL-113: "a timestamp maintained by callers is a timestamp
-- that is wrong eventually").
create trigger notification_preferences_set_updated_at
before update on public.notification_preferences for each row
execute function public.set_updated_at ();

-- ---------------------------------------------------------------------------
-- notification_preferences · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.notification_preferences enable row level security;

-- `select` only, matching every other user-owned table here.
--
-- Writes go through the service because it is the layer that knows `security` is
-- not configurable. A client insert policy would let a person write a preference
-- row for a type the product does not let them configure — the check constraint
-- above would still refuse `security`, but the service is where the refusal is
-- explainable, and one write path is easier to reason about than two.
create policy "notification_preferences_select_own" on public.notification_preferences for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- notification_preferences · privileges
-- ---------------------------------------------------------------------------
revoke all on public.notification_preferences
from
  anon;

grant
select
  on public.notification_preferences to authenticated;

-- `service_role` — the preference service.
--
-- SELECT to resolve an effective preference; INSERT and UPDATE for the upsert
-- when a person changes a toggle; DELETE so a person can return a type to its
-- declared default rather than pinning the current default's value forever — if
-- a default changes later, a cleared preference follows it and a stored `true`
-- would not.
grant
select
,
  insert,
update,
delete on public.notification_preferences to service_role;
