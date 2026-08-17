-- ATL-109 · ai_conversations and ai_messages
--
-- Consent-gated conversation history, per architecture §7.18.
--
-- APPEND-ONLY: this migration adds two tables and touches nothing that came
-- before. `ai_interactions`, `consents`, `user_encryption_keys` and every other
-- existing table and policy are untouched.
--
-- ## Not `ai_interactions`
--
-- §7.11 opens with "Store metadata only unless conversation history is
-- explicitly enabled", and these are the tables that "unless" refers to. The
-- separation is the point, not an accident of sequencing:
--
--   * `ai_interactions` holds metadata about a request Atlas made — purpose,
--     model, versions, which record ids were sent. No content. It exists for
--     every interaction regardless of consent, and is the user's disclosure
--     surface.
--   * These tables hold the words. They exist only when the person has granted
--     `ai_conversation_history`, and disabling the feature destroys them.
--
-- Folding content into `ai_interactions` would put restricted plaintext behind a
-- table whose whole design premise is that it holds none, and would tie two
-- different retention rules to one row.
--
-- ## Columns are exactly §7.18
--
-- No column here is inferred, and the list is deliberately not extended. A link
-- to `ai_interactions` was considered and rejected during planning: §7.18 does
-- not authorize it, and no other source-of-truth document does either. Adding a
-- relationship the specification does not describe would be this migration
-- inventing product structure — and migrations are append-only, so an invented
-- column is permanent.
--
-- ## Retention
--
-- Security §14: "AI conversation history: only stored when explicitly enabled;
-- disabling hard-deletes all conversations." Enforced in the service (ATL-109's
-- `AiHistoryService.disable`), and by `on delete cascade` from `auth.users` for
-- account deletion. Content is additionally crypto-shredded when the user's DEK
-- is destroyed (ADR-003), which is what makes deletion hold even in provider
-- backups.
-- ---------------------------------------------------------------------------
-- ai_conversations
-- ---------------------------------------------------------------------------
create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Where the conversation is anchored (§7.18). Shape-checked here, vocabulary
  -- owned by the application — the same split `ai_interactions.purpose` uses, so
  -- adding a surface is an application change rather than a forward migration.
  context_type text not null check (context_type in ('global', 'asset', 'finding', 'request')),
  -- The record the conversation is about. Null only for `global`.
  --
  -- Not a foreign key: the target spans findings, assets and requests, and §8's
  -- "foreign keys must prevent cross-user relationships" is satisfied upstream —
  -- ATL-049's retrieval only ever resolves the caller's own records, and the
  -- unique index below is scoped by `user_id`. Stated plainly because it is a
  -- real deviation, and the same one `ai_interactions.records_referenced` makes.
  entity_id uuid,
  created_at timestamptz not null default now(),
  -- An anchor is all-or-nothing, mirroring
  -- `activity_events_entity_reference_is_complete`. A non-global conversation
  -- with no entity could never be reopened from the record it belongs to, and a
  -- global one carrying an entity would claim an anchor it does not have.
  constraint ai_conversations_anchor_is_complete check (
    (
      context_type = 'global'
      and entity_id is null
    )
    or (
      context_type <> 'global'
      and entity_id is not null
    )
  )
);

comment on table public.ai_conversations is 'Consent-gated AI conversation history (ATL-109, architecture §7.18). Exists only while `ai_conversation_history` consent is granted; hard-deleted when it is revoked.';

-- One conversation per anchor, enforced by the database rather than by a service
-- that could forget. Asking twice about the same finding appends to the existing
-- conversation, which is what makes `context_type`/`entity_id` meaningful rather
-- than decorative.
--
-- Partial, because `global` carries no entity and Postgres treats nulls as
-- distinct — without the split, every global conversation would be unique and
-- the constraint would silently do nothing for the one surface most likely to
-- accumulate them.
create unique index ai_conversations_anchor_idx on public.ai_conversations (user_id, context_type, entity_id)
where
  entity_id is not null;

create unique index ai_conversations_global_idx on public.ai_conversations (user_id, context_type)
where
  entity_id is null;

-- Newest first, with the `id` tiebreak ATL-114 documents: `created_at` can tie,
-- and a tie makes cursor pagination able to repeat or skip a row at a page
-- boundary.
create index ai_conversations_user_created_idx on public.ai_conversations (user_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- ai_messages
-- ---------------------------------------------------------------------------
create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  -- Denormalised from the conversation so RLS is a column comparison rather than
  -- a join (§8). A policy that has to join is a policy that can be defeated by a
  -- planner change or a view.
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  -- AES-256-GCM envelope (ADR-003), AAD `ai_messages.content_encrypted:<id>`.
  --
  -- The AAD binds the ciphertext to this row and this column, so a value cannot
  -- be moved between messages or between columns. That requires the id to exist
  -- before the value is sealed, so the application generates it rather than
  -- relying on the default above — the pattern `digital_assets.
  -- account_identifier_encrypted` already established.
  content_encrypted text not null,
  created_at timestamptz not null default now()
);

comment on table public.ai_messages is 'Encrypted conversation turns (ATL-109, architecture §7.18, ADR-003). Content is AES-256-GCM with AAD bound to the row; crypto-shredded when the user DEK is destroyed.';

comment on column public.ai_messages.content_encrypted is 'AES-256-GCM envelope. Server-decryptable, NOT end-to-end encrypted — user-facing copy must not claim otherwise (ADR-003 tradeoffs).';

-- Reading one conversation in order. The `id` tiebreak is here for the same
-- reason as above: two turns of one exchange can share a timestamp.
create index ai_messages_conversation_idx on public.ai_messages (conversation_id, created_at, id);

-- Deleting everything for one user, which is the operation security §14 requires
-- to be immediate when consent is revoked.
create index ai_messages_user_idx on public.ai_messages (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.ai_conversations enable row level security;

alter table public.ai_messages enable row level security;

-- Deny by default (security §7). `auth.uid()` comes from the verified JWT, never
-- from a client-supplied value (architecture §10).
--
-- `select` is the only client policy on either table, matching `ai_interactions`
-- for the same reasons. A user who could insert could fabricate a record of
-- something the assistant never said; one who could update could rewrite it
-- afterwards. Every write is server-side, through the service-role client, after
-- the consent gate.
--
-- Deletion is server-side too, deliberately: revoking consent must remove
-- *every* conversation atomically, and a client-issued delete could remove some
-- and stop.
create policy "ai_conversations_select_own" on public.ai_conversations for
select
  to authenticated using (auth.uid () = user_id);

create policy "ai_messages_select_own" on public.ai_messages for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- GRANT then RLS: two independent gates, with grants matching the policies
-- exactly so neither is wider than the other.
revoke all on public.ai_conversations
from
  anon;

revoke all on public.ai_messages
from
  anon;

grant
select
  on public.ai_conversations to authenticated;

grant
select
  on public.ai_messages to authenticated;

-- `service_role` — every write in ATL-109 is server-side, so every write verb
-- this feature performs has to be granted here explicitly. This project does not
-- rely on Supabase's default privileges: each table migration states its grants,
-- so the privilege surface is reviewable in one place per table.
--
-- ## Why these verbs and no others
--
-- `ai_conversations` needs SELECT (find the anchor, list), INSERT (create on the
-- first turn) and DELETE (`AiHistoryService.clearAll`, which security §14
-- requires to be immediate when consent is revoked). **No UPDATE:** a
-- conversation's anchor and creation time are settled when it is created, and
-- nothing in the feature rewrites them.
--
-- `ai_messages` needs SELECT and INSERT only. **No UPDATE**, because a stored
-- turn is a record of what was said and rewriting it would make the transcript
-- untrustworthy — the same reason `authenticated` has no update policy. **No
-- DELETE**, because messages are removed by the `on delete cascade` from their
-- conversation, and a referential action runs with the referencing table's
-- owner's rights rather than the caller's. Granting DELETE here would widen the
-- surface for an operation that never issues one.
grant
select
,
  insert,
  delete on public.ai_conversations to service_role;

grant
select
,
  insert on public.ai_messages to service_role;
