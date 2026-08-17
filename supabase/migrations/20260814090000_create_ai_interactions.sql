-- Task #95 · ai_interactions
--
-- Metadata for every AI interaction. Architecture §7.11 (columns), security §10
-- (AI data handling), §14 (retention), §16 (deletion).
--
-- APPEND-ONLY MIGRATION: adds one table, one trigger, its policy, its grants and
-- one index. Nothing existing is altered.
--
-- ## Metadata only. Never content.
--
-- §7.11 opens with "Store metadata only unless conversation history is
-- explicitly enabled", and security §7 says "Store AI interaction metadata, not
-- raw prompt and response text". **There is deliberately no column capable of
-- holding a prompt, a completion, user text, or a provider message.** That is
-- the control: a `notes` or `payload` column would be filled within a quarter.
-- Conversation content has its own consent-gated, encrypted home in
-- `ai_conversations` / `ai_messages` (§7.18, ATL-109).
--
-- ## Identifiers ARE permitted here, and that is the one inversion
--
-- Every other surface in Atlas keeps entity identifiers out. §7.11 states the
-- opposite for `records_referenced`: "This is an authorized, RLS-protected
-- database table used for user-visible disclosure and audit — not a log. The §16
-- rule against identifiers applies to telemetry/log sinks, not to this table."
-- Written out here because a reviewer who knows the codebase will otherwise read
-- it as a mistake.
--
-- ## Append-only except feedback
--
-- A row records what happened; editing it destroys the evidence it exists to be.
-- The single exception is user feedback (AI behavior §12), which arrives after
-- the interaction. Rather than trust server code to touch only those columns, a
-- BEFORE UPDATE trigger refuses any update that changes anything else — so even
-- a bug cannot rewrite what the assistant was told.
create table public.ai_interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  /**
   * The classified purpose, e.g. `explain_finding` (ATL-049).
   *
   * Shape-checked in SQL, vocabulary owned by the application — the same split
   * `finding_type` and `score_version` use. A new purpose is then an application
   * change rather than a forward migration racing a constant.
   */
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_]{0,63}$'),
  /**
   * The model that produced the output, e.g. `claude-sonnet-5`.
   *
   * Recorded because security §10 requires model and prompt version logging, and
   * because an incident needs to be traceable to what actually generated the
   * text. ATL-048's gateway returns this on every completion.
   */
  model text not null check (model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  /**
   * The prompt generation (ATL-051).
   *
   * An integer rather than the full `explain-finding-v1` identifier, because
   * `purpose` already carries the slug: the pair reconstructs the identifier
   * exactly, and storing both would let them disagree.
   */
  prompt_version integer not null check (prompt_version > 0),
  /**
   * The system-policy generation the prompt pinned (ATL-051).
   *
   * **A documented extension to §7.11**, which lists only `prompt_version`.
   * Atlas versions the shared system policy separately from task templates, so
   * the prompt version alone does not identify the instructions that ran. Both
   * numbers together do, which is what makes a recorded interaction
   * reproducible.
   */
  policy_version integer not null check (policy_version > 0),
  /**
   * §7.11 lists this column and defines nothing about it.
   *
   * Nullable, and **its vocabulary is intentionally undefined**. No document in
   * the repository says what an input classification is; plausible readings
   * (sensitivity tier, purpose, demo state) contradict each other, and guessing
   * would bake one in. The ticket that owns classification defines the values
   * and backfills meaning; until then nothing writes it.
   */
  input_classification text check (
    input_classification is null
    or input_classification ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  /**
   * Entity IDs included in the AI context (§7.11).
   *
   * A JSON array rather than `uuid[]`: this records what was *sent*, and the
   * shape of a future context item is not this table's to constrain. Not a
   * foreign key, because the ids span findings, assets and permissions — §8's
   * "foreign keys must prevent cross-user relationships" is satisfied upstream
   * by ATL-049's retrieval, which selects only the caller's records. Stated
   * plainly because it is a real deviation.
   */
  records_referenced jsonb not null default '[]'::jsonb check (jsonb_typeof(records_referenced) = 'array'),
  /**
   * The output schema generation the result was validated against (ATL-050).
   *
   * This column is the one that closes ATL-050's outstanding acceptance clause,
   * "Schema versions recorded on `ai_interactions`".
   */
  output_schema_version integer not null check (output_schema_version > 0),
  /**
   * How the interaction ended.
   *
   * Shape-checked only; the vocabulary — `validated`, `fallback`,
   * `unavailable`, `provider_error`, `rate_limited`, `consent_denied` — lives in
   * `src/lib/ai/interaction-vocabulary.ts`. **Never a provider message**:
   * ATL-048's error type has no field capable of carrying one, and architecture
   * §10 requires typed codes rather than raw provider text.
   */
  status text not null check (status ~ '^[a-z][a-z0-9_]{0,31}$'),
  latency_ms integer not null check (latency_ms >= 0),
  /**
   * Feedback (AI behavior §12): helpful or not, plus an optional category.
   *
   * Two nullable columns rather than a JSON blob, so "no feedback yet" is
   * distinguishable from "marked unhelpful with no category" — a distinction a
   * blob loses. Both are null until the user acts.
   */
  helpful boolean,
  feedback_category text check (
    feedback_category is null
    or feedback_category ~ '^[a-z][a-z0-9_]{0,31}$'
  ),
  /**
   * From the DATABASE clock (ATL-113).
   *
   * `default now()` and never supplied by the application. `now()` is
   * `transaction_timestamp()`, so the defaulted value and the not-future
   * predicate share one clock inside one transaction and cannot fight.
   */
  created_at timestamptz not null default now() check (created_at <= now())
);

-- ---------------------------------------------------------------------------
-- Append-only except feedback
-- ---------------------------------------------------------------------------
create or replace function public.ai_interactions_reject_mutation () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  /**
   * Feedback is the only mutable part of a row (AI behavior §12). Every other
   * column records what happened and must not change afterwards.
   *
   * Comparing the row with its feedback columns normalised is the whole check:
   * if the rest of the record still matches, only feedback moved.
   */
  if (new.helpful is distinct from old.helpful
      or new.feedback_category is distinct from old.feedback_category)
     and (new.id, new.user_id, new.purpose, new.model, new.prompt_version,
          new.policy_version, new.input_classification, new.records_referenced,
          new.output_schema_version, new.status, new.latency_ms, new.created_at)
       is not distinct from
         (old.id, old.user_id, old.purpose, old.model, old.prompt_version,
          old.policy_version, old.input_classification, old.records_referenced,
          old.output_schema_version, old.status, old.latency_ms, old.created_at)
  then
    return new;
  end if;

  raise exception
    'ai_interactions is append-only except user feedback (architecture §7.11): % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function public.ai_interactions_reject_mutation () is 'Permits only helpful/feedback_category to change; refuses every other update, including for owner and superuser connections.';

create trigger ai_interactions_feedback_only_update
before update on public.ai_interactions for each row
execute function public.ai_interactions_reject_mutation ();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The one read this table has: a user's recent AI activity, for the disclosure
-- surface (ATL-053, ATL-076). `id` makes the ordering total so two interactions
-- recorded in the same microsecond cannot swap places between requests.
--
-- No `created_at`-only index: retention is "retain while the account exists"
-- (security §14, task #95 decision B6), so no purge job scans by age, and an
-- index with no query is cost without benefit.
create index ai_interactions_user_created_idx on public.ai_interactions (user_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.ai_interactions enable row level security;

-- Deny by default (security §7). `auth.uid()` comes from the verified JWT, never
-- from a client-supplied value (architecture §10).
--
-- `select` is the only client policy. A user who could insert could fabricate a
-- record of an interaction that never happened; one who could update could
-- rewrite what the assistant was told. Feedback is written server-side instead.
create policy "ai_interactions_select_own" on public.ai_interactions for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- GRANT then RLS: two independent gates, and the grants match the policies
-- exactly so neither is wider than the other.
revoke all on public.ai_interactions
from
  anon;

-- `authenticated` — read-only, matching the single policy exactly.
grant
select
  on public.ai_interactions to authenticated;

-- `service_role` — the recorder inserts; the feedback path updates.
--
-- **No DELETE.** Retention is "retain while the account exists" (§14), so there
-- is no purge job, and account deletion removes rows through the `auth.users`
-- cascade rather than through a grant. UPDATE is granted but narrowed by the
-- trigger above to the two feedback columns.
grant
select
,
  insert,
update on public.ai_interactions to service_role;
