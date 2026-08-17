-- ATL-056 · data_requests, request_events
--
-- The record a person creates when they ask a service to delete or correct what
-- it holds (architecture §7.7–7.8, §13, PRD FR-08, §9.3).
--
-- APPEND-ONLY: this migration adds two tables and touches nothing that came
-- before. Every existing table, policy, grant, index and trigger is untouched.
--
-- ## Why this is the keystone of M8
--
-- Findings and the score describe what a service holds; a request is how a
-- person does something about it. Its absence is the most-referenced gap in the
-- codebase — R-007 is unregistered in the rules catalog, R-006 evaluates only
-- its first conjunct, ADR-004's "+20 per completed request" has nothing to
-- count, the `request` AI conversation anchor has no producer, and the asset
-- detail page renders an empty Requests section that says so. This migration is
-- what makes those statements convertible into behaviour.
--
-- ## Scope: schema and storage only
--
-- ATL-056 owns the tables, the vocabularies (`src/lib/requests/requests.ts`) and
-- the declarative §13 transition table. **ATL-057 owns execution** — validating
-- a proposed move, idempotency, writing `request_events`, and emitting audit and
-- activity events. Nothing here performs or records a transition, and no
-- consumer is wired: the rules catalog, the score's `completedRequests` call
-- site, `anchorFor`, and the asset detail copy all stay as they are, each owned
-- by its own ticket.
--
-- ## The name
--
-- `data_requests`, not `deletion_requests`. §7.7 records the reason: the MVP
-- supports deletion **and** correction, and "migrations are append-only after
-- shared deployment, so the name must be right from the first migration".
-- ---------------------------------------------------------------------------
-- data_requests
-- ---------------------------------------------------------------------------
create table public.data_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The service this request is about.
  --
  -- Not null: a request with no subject is not a request. The composite foreign
  -- key below carries `on delete cascade`, so deleting a service removes the
  -- requests about it — a request that can no longer say who it was sent to
  -- cannot be explained, only displayed.
  asset_id uuid not null,
  -- §7.7's two kinds (FR-08). A check constraint rather than a shape check:
  -- these are a closed set that the draft templates (ATL-059) and R-007 read,
  -- and a third kind would be a product decision, visible as a migration.
  request_type text not null check (request_type in ('deletion', 'correction')),
  -- Architecture §13's eight-state lifecycle.
  --
  -- Constrained here *and* listed in `src/lib/requests/requests.ts` — the §7.2
  -- split, for the reason `digital_assets.status` gives: the constraint stops an
  -- unrecognised value reaching storage and the union stops one being written in
  -- the first place. ADR-004's protective-actions factor counts `completed`, and
  -- R-007 reads `rejected`, so a ninth value appearing would silently change
  -- what the score and the rules engine mean.
  --
  -- **The transition graph is not enforced here.** A check constraint sees one
  -- row's new value, not the value it replaced, so `draft -> completed` is
  -- indistinguishable from a legitimate write at this layer. §13 requires
  -- transitions to be "validated server-side, protected by idempotency keys, and
  -- recorded in `request_events` and `audit_events`" — four obligations a
  -- constraint cannot discharge. ATL-057 owns all of them; the table stores the
  -- state, and `ALLOWED_REQUEST_TRANSITIONS` declares which moves are legal.
  status text not null default 'draft' check (
    status in ('draft', 'ready', 'sent', 'awaiting_response', 'follow_up_due', 'completed', 'rejected', 'canceled')
  ),
  -- Restricted (security §3, §8 inventory). AES-256-GCM envelope (ADR-003), AAD
  -- `data_requests.recipient_encrypted:<row id>`.
  --
  -- §7.7: "recipient addresses are Restricted data (email addresses) and are
  -- encrypted like the body; list views show the associated service name and a
  -- masked recipient". Nullable because a draft exists before the person has
  -- entered or confirmed an address (frontend §10, Step 1) — and FR-08 is
  -- explicit that the address is user-entered and "clearly marked unverified"
  -- in the MVP, since there is no service directory until Phase 2.
  recipient_encrypted text,
  -- Restricted. AAD `data_requests.subject_encrypted:<row id>`.
  --
  -- §7.7: "subjects frequently contain personal identifiers and receive the same
  -- protection". Nullable for the same reason as the recipient: Step 2 produces
  -- it, and a draft can exist before Step 2.
  subject_encrypted text,
  -- Restricted. AAD `data_requests.body_encrypted:<row id>`.
  body_encrypted text,
  /**
   * Restricted third-party free text. AAD `data_requests.last_status_note:<row id>`.
   *
   * **Encrypted, extending security §8's inventory.** §7.7 listed this column
   * without classifying it, and §3 classifies request recipients, subjects and
   * bodies but is silent on notes. It holds what the *service* said back —
   * frontend §9 offers "Add response note" and §13 makes a recorded note one of
   * the two triggers for `sent -> awaiting_response` — which routinely carries
   * case references, agent names and identifiers. Third-party prose about a
   * person is exactly what §3 classifies as Restricted when it appears in the
   * request body, and it does not become less so for arriving in a reply.
   *
   * Nothing searches or filters it (frontend §4 and §9 filter on service, type
   * and status), so encryption costs nothing the product needs. The column name
   * keeps §7.7's `last_status_note` rather than gaining an `_encrypted` suffix
   * would have — see the note below on why that suffix is not used here.
   */
  last_status_note text,
  /**
   * How the person sent it (§7.7): copy, mailto, or manual.
   *
   * Every value describes something the **user** did. Atlas drafts and never
   * sends (security §11; frontend §9: "No control may imply Atlas sent the
   * request unless it actually did"), so there is no value meaning "Atlas sent
   * it" — its absence is what makes that promise structural.
   *
   * Null until the request is actually sent, which is why there is no default:
   * a draft has no delivery method, and defaulting to `copy` would assert one.
   */
  delivery_method text check (delivery_method in ('copy', 'mailto', 'manual')),
  /**
   * Which personal-field **keys** the person approved for this request.
   *
   * Keys only, never values (ADR-002, FR-08, ticket acceptance criterion). The
   * values live encrypted in `user_personal_fields` and reach a draft only
   * through the per-request approval step (ATL-058) — copying them here would
   * create a second, unencrypted home for the most sensitive data in the
   * product.
   *
   * Constrained to a JSON **array**, mirroring how
   * `privacy_score_snapshots.factor_breakdown_json` is constrained to an object:
   * a scalar or object here would be unreadable to the surfaces that render the
   * included-fields summary, and would surface only at render time. The keys
   * themselves are validated against `PERSONAL_FIELD_KEYS` at the repository
   * boundary — the database is the second gate, not the first.
   */
  included_fields_json jsonb not null default '[]'::jsonb check (jsonb_typeof(included_fields_json) = 'array'),
  -- When the person told Atlas they sent it. Null while `draft` or `ready`.
  --
  -- §13 measures the 3-day `sent -> awaiting_response` delay from this, and
  -- `follow_up_due -> sent` records a **new** `sent_at` for a follow-up.
  sent_at timestamptz,
  /**
   * When a follow-up becomes due (§13, ATL-066).
   *
   * Nullable with **no default**, deliberately. ATL-066 owns the follow-up
   * scheduling policy and the interval; no document states one, and inventing a
   * default here would be a product rule expressed as a column default, where
   * nobody would look for it. This ticket stores the value.
   */
  follow_up_at timestamptz,
  completed_at timestamptz,
  /**
   * The service's own case or ticket number.
   *
   * Bounded metadata, not prose — the cap is what keeps "reference" from
   * becoming a second notes field. Security §3 does not classify it, so it is
   * stored in plaintext under RLS like the other non-restricted columns here;
   * that assumption is recorded rather than left implicit, and the value stays
   * out of logs regardless. Not indexed: no document asks for it to be
   * searchable, and frontend §4's search operates on service, category and
   * status.
   */
  external_reference text check (
    external_reference is null
    or char_length(external_reference) between 1 and 120
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  /**
   * Cross-user protection, the pattern ATL-028 established.
   *
   * A plain `references digital_assets (id)` would satisfy referential integrity
   * while allowing a request owned by one person to point at another person's
   * service. Keying on `(user_id, asset_id)` against the parent's
   * `unique (user_id, id)` makes that combination unrepresentable rather than
   * merely refused by RLS.
   */
  constraint data_requests_asset_fkey foreign key (user_id, asset_id) references public.digital_assets (user_id, id) on delete cascade,
  /**
   * The target `request_events`' own composite foreign key needs.
   *
   * `data_requests` is a parent as well as a child: `request_events` keys on
   * `(user_id, request_id)` for the same cross-user reason this table keys on
   * `(user_id, asset_id)`, and Postgres requires the referenced columns to carry
   * a unique constraint. Without this, the `request_events` foreign key below
   * fails at migration time with "there is no unique constraint matching given
   * keys for referenced table".
   *
   * `id` is already unique on its own as the primary key, so this adds **no new
   * restriction** — only the target the composite reference requires. ATL-028
   * added the equivalent constraint to `digital_assets` in the child's own
   * migration, because the parent already existed; here both tables arrive
   * together, so it is declared inline on the parent. The constraint name
   * follows that precedent (`digital_assets_user_id_id_key`).
   */
  constraint data_requests_user_id_id_key unique (user_id, id),
  /**
   * A terminal state carries its timestamp, and only a terminal one does.
   *
   * ADR-004 credits "+20 per completed request in the trailing 180 days", which
   * a completion with no timestamp cannot enter — the same arithmetic
   * `privacy_findings` encodes for `resolved_at`. `canceled` is terminal too but
   * earns no credit and needs no timestamp, so it is not required to carry one.
   */
  constraint data_requests_completed_at_pairing check (
    (
      status = 'completed'
      and completed_at is not null
    )
    or (
      status <> 'completed'
      and completed_at is null
    )
  ),
  -- A request cannot have been sent in the future, and cannot be completed
  -- before it existed. Both are database-clock comparisons against
  -- database-clock values (ATL-113), so no second clock can lose the race.
  constraint data_requests_sent_at_not_future check (
    sent_at is null
    or sent_at <= now()
  ),
  constraint data_requests_completed_at_not_future check (
    completed_at is null
    or completed_at <= now()
  )
);

-- The column names keep §7.7's spelling exactly: `recipient_encrypted`,
-- `subject_encrypted` and `body_encrypted` carry the suffix because the
-- architecture names them that way, and `last_status_note` does not because the
-- architecture names *it* that way. Renaming the fourth to match the first three
-- would be tidier and would contradict the specification, and §7.7 is the
-- authority a later reader will check. The `comment on column` below is what
-- tells that reader the column is an envelope.
comment on table public.data_requests is 'Deletion and correction requests (ATL-056, architecture §7.7, §13, FR-08). Drafted by the user; Atlas never sends. Recipient, subject, body and status note are envelope-encrypted (ADR-003).';

comment on column public.data_requests.recipient_encrypted is 'AES-256-GCM envelope. User-entered and unverified in MVP (FR-08) — no service directory until Phase 2.';

comment on column public.data_requests.last_status_note is 'AES-256-GCM envelope, despite the column name. Restricted third-party free text: what the service replied. Added to security §8''s encrypted-column inventory by ATL-056.';

comment on column public.data_requests.included_fields_json is 'Approved personal-field KEYS only, never values (ADR-002, FR-08). Values stay in user_personal_fields.';

-- The shared function, attached where every mutable user-owned table attaches
-- it. A request is edited repeatedly while `draft`, so ATL-113 applies directly:
-- "a timestamp maintained by callers is a timestamp that is wrong eventually".
create trigger data_requests_set_updated_at
before update on public.data_requests for each row
execute function public.set_updated_at ();

-- ---------------------------------------------------------------------------
-- data_requests · indexes
-- ---------------------------------------------------------------------------
--
-- The request list (frontend §9), newest first, with the `id` tiebreak ATL-114
-- documents: `created_at` can tie, and a tie makes cursor pagination able to
-- repeat or skip a row at a page boundary.
create index data_requests_user_created_idx on public.data_requests (user_id, created_at desc, id desc);

-- The asset detail page's Requests section, and R-006's "has no deletion
-- request" conjunct when ATL-057 makes it evaluable. Also the foreign-key
-- support CLAUDE.md requires.
create index data_requests_user_asset_idx on public.data_requests (user_id, asset_id);

-- ATL-066's due-follow-up sweep, and the ADR-004 completed-request count.
-- Partial, so the index holds only rows a job can act on: a completed or
-- canceled request is never due a follow-up, and most rows end up in one of
-- those states.
create index data_requests_follow_up_due_idx on public.data_requests (follow_up_at)
where
  follow_up_at is not null
  and status not in ('completed', 'canceled');

-- ---------------------------------------------------------------------------
-- data_requests · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.data_requests enable row level security;

-- Deny by default (security §7). `auth.uid()` comes from the verified JWT, never
-- from a client-supplied value (architecture §10).
--
-- `select` is the only client policy, and it is narrower than it looks: four of
-- the columns it exposes are ciphertext. Plaintext is reachable only through the
-- repository, which decrypts server-side.
--
-- **No insert, update or delete policy.** A request is heavily user-edited, so
-- this deserves stating rather than asserting: the encrypted columns cannot be
-- written by a client at all, because the client has no access to the user's
-- DEK. A client write path could therefore only produce rows whose recipient,
-- subject and body were absent or unencrypted — which is not a request, it is a
-- leak. Every mutation goes through the server-side service, which is also where
-- §13's transitions, their idempotency keys and their audit events live.
create policy "data_requests_select_own" on public.data_requests for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- data_requests · privileges
-- ---------------------------------------------------------------------------
--
-- GRANT then RLS: two independent gates, with grants matching the policies
-- exactly so neither is wider than the other.
revoke all on public.data_requests
from
  anon;

grant
select
  on public.data_requests to authenticated;

-- `service_role` — every write is server-side.
--
-- SELECT, INSERT and UPDATE for drafting, editing and (in ATL-057) transitions.
-- Three verbs, three methods.
--
-- **No DELETE**, deliberately. ATL-056 has no delete operation and no caller, and
-- least privilege means a capability is granted when the behaviour and its
-- authorization rules exist, not in anticipation of them. The product's own
-- answer to an abandoned request is `canceled` — a state a person can still read
-- — rather than removal. The `auth.users` cascade needs no grant, so account
-- deletion is unaffected. If a later ticket needs request deletion (ATL-037's
-- permanent asset deletion, or a demo purge that ever seeds requests), it adds
-- the privilege alongside the rules that govern it.
grant
select
,
  insert,
update on public.data_requests to service_role;

-- ---------------------------------------------------------------------------
-- request_events
-- ---------------------------------------------------------------------------
--
-- ## Why a third log
--
-- Three logs record a transition, and they answer to different readers:
--
--   - `request_events` — the **request-scoped, user-facing timeline** frontend
--     §9 renders in the request detail view ("Status timeline"). Scoped to one
--     request, so it is read by a page that already knows which request it is
--     about.
--   - `activity_events` — the **global feed** (ATL-069, frontend §12), which
--     mixes assets, findings, requests and consent into one chronological
--     stream.
--   - `audit_events` — the **security and compliance record** (ADR-006), pseudo-
--     nymous, hash-chained, 90-day retention, no client access at all. Security
--     §12 lists "Request state transitions" among the events it must hold.
--
-- Deriving the first from the second was considered and rejected: §7.8 and §13
-- both specify `request_events`, and a request timeline built by filtering the
-- global feed would inherit that feed's retention, its metadata allowlist and
-- its ordering, none of which are chosen for this purpose.
create table public.request_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  request_id uuid not null,
  /**
   * What happened, from a closed vocabulary
   * (`src/lib/requests/request-events.ts`).
   *
   * Shape-checked here rather than enumerated, the split
   * `activity_events.event_type` uses: this vocabulary grows as the request
   * flow gains steps (ATL-058–067 each add one or two), and an `IN` list would
   * make every addition a forward migration racing an application constant.
   */
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Null for events that are not transitions — a draft edit changes no status.
  from_status text check (
    from_status is null
    or from_status in ('draft', 'ready', 'sent', 'awaiting_response', 'follow_up_due', 'completed', 'rejected', 'canceled')
  ),
  to_status text check (
    to_status is null
    or to_status in ('draft', 'ready', 'sent', 'awaiting_response', 'follow_up_due', 'completed', 'rejected', 'canceled')
  ),
  /**
   * The sentence the timeline shows.
   *
   * **Composed from a template, never accepted as free text.**
   * `REQUEST_EVENT_TEMPLATES` builds it from an event type and at most two
   * statuses; there is no free-text parameter anywhere in the write path. That
   * matters more here than anywhere else in the product: a `request_events` row
   * is written at the moment the caller holds the recipient, the subject and the
   * body — three Restricted values — so a free-text summary would make "no
   * restricted value lands here" a rule every future caller has to remember, and
   * an address in a timeline reads perfectly normally.
   *
   * Length-capped as a backstop, exactly as `activity_events.summary` is.
   */
  summary text not null check (char_length(summary) between 1 and 500),
  -- §7.8's two actors. `system` is the interesting one: §13's `sent ->
  -- awaiting_response` after three days and `awaiting_response ->
  -- follow_up_due` are performed by jobs, and the timeline has to be able to say
  -- "Atlas did this" rather than implying the person did.
  --
  -- No `operator`: §7.8 specifies two values and nothing in the MVP acts as an
  -- operator on a request. ADR-006's audit log has a wider actor vocabulary
  -- because operator elevation is an audited security event there.
  actor_type text not null check (actor_type in ('user', 'system')),
  occurred_at timestamptz not null default now(),
  /** Cross-user protection, keyed on the parent's `(user_id, id)`. */
  constraint request_events_request_fkey foreign key (user_id, request_id) references public.data_requests (user_id, id) on delete cascade,
  -- A transition names both ends or neither. Half a transition is unreadable:
  -- "changed to sent" from an unrecorded state cannot be placed in a timeline,
  -- and the pairing is what lets ATL-057's matrix test assert against §13.
  constraint request_events_status_pair check (
    (
      from_status is not null
      and to_status is not null
    )
    or (
      from_status is null
      and to_status is null
    )
  ),
  constraint request_events_occurred_at_not_future check (occurred_at <= now())
);

comment on table public.request_events is 'Request-scoped user-facing timeline (ATL-056, architecture §7.8). Distinct from activity_events (global feed) and audit_events (security record). Summaries are template-composed and carry no restricted values.';

-- No `updated_at`, and no trigger.
--
-- An event is a fact about a moment; nothing about it changes afterwards. The
-- same reasoning `notifications` and `privacy_score_snapshots` record, and it is
-- backed by privilege below rather than left to convention.
-- ---------------------------------------------------------------------------
-- request_events · indexes
-- ---------------------------------------------------------------------------
--
-- The status timeline for one request, newest first, with the `id` tiebreak.
create index request_events_request_occurred_idx on public.request_events (user_id, request_id, occurred_at desc, id desc);

-- ---------------------------------------------------------------------------
-- request_events · Row Level Security
-- ---------------------------------------------------------------------------
alter table public.request_events enable row level security;

-- `select` only, matching `activity_events`' client access and for the same
-- reason ATL-068 recorded: a selectively-erasable timeline is a weaker record,
-- including for the person who later wants to know when something actually
-- happened.
create policy "request_events_select_own" on public.request_events for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- request_events · privileges
-- ---------------------------------------------------------------------------
revoke all on public.request_events
from
  anon;

grant
select
  on public.request_events to authenticated;

-- `service_role` — SELECT and INSERT only.
--
-- **No UPDATE and no DELETE, for any role.** An event that could be edited is
-- not a record of what happened, and rows leave only by the cascade from their
-- request or from `auth.users`. A missing repository method is not a guarantee;
-- the withheld privilege is.
grant
select
,
  insert on public.request_events to service_role;
