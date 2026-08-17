-- ATL-045 · privacy_score_snapshots
--
-- The recorded history of a user's privacy score. Architecture §7.6 (columns),
-- §11.2 (write-on-change, retention), ADR-004 (the model, versioning, demo
-- isolation, 90-day retention then one snapshot per day), security §14.
--
-- APPEND-ONLY: this migration adds one table, its policy, its grants and its
-- indexes. Nothing existing is altered.
--
-- ## Snapshots are written by the system and never edited
--
-- ADR-004: "historical snapshots are never recomputed". A snapshot records what
-- the score WAS under a named version, so correcting one would destroy the only
-- evidence of what the user was actually shown. There is therefore no update
-- path anywhere: no update policy, no `update` grant even for `service_role`,
-- and no `updated_at` column or `set_updated_at` trigger — a column that can
-- never change would be a promise this table does not make.
--
-- This follows `activity_events` (ATL-069), the closest analogue: client
-- readable, system written, never rewritten. The one difference is that
-- `service_role` needs DELETE here, and only for two named jobs — retention
-- compaction (§14: "compact snapshots older than 90 days") and the demo purge
-- (ATL-083). Account deletion still goes through the `auth.users` cascade.
--
-- ## Nothing here is encrypted
--
-- Security §8's encrypted-column inventory names no column on this table. A
-- score is a derived integer, and the breakdown holds factor ids, weights and
-- counts — no personal value and no identifier. What keeps it that way is
-- ATL-044's breakdown shape, whose inputs are integers counted from records.
create table public.privacy_score_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  /**
   * The score the user was shown, 0–100.
   *
   * An integer, because ADR-004 rounds exactly once at the end of the
   * calculation. Storing a float here would reopen the precision question this
   * column sits downstream of.
   */
  score integer not null check (score between 0 and 100),
  /**
   * Which model produced it, e.g. `score-v1`.
   *
   * ADR-004: "every snapshot records the version ... changing any constant
   * requires a new version". Two snapshots are comparable only when this
   * matches, which is what stops a weight change silently rewriting history.
   *
   * Shape-checked here, vocabulary owned by `src/lib/score/score-config.ts` —
   * the same split `rule_version` uses.
   */
  score_version text not null check (score_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  /**
   * True when the calculation ran exclusively over demo records (§11.2).
   *
   * Demo and real records never mix in one calculation, so this describes the
   * whole snapshot rather than part of it. ATL-083 deletes these with the demo
   * data; a demo score surviving into a real history would be a number about
   * records that no longer exist.
   */
  is_demo boolean not null default false,
  /**
   * The factor breakdown: per-factor value, configured and normalised weight,
   * whether the factor was excluded, the countable inputs behind it, and the
   * coverage (§7.6, ADR-004's "factor-level inputs").
   *
   * Stored exactly as ATL-044's `ScoreResult` produced it. Constrained to an
   * object rather than any JSON: an array or a bare scalar would be unreadable
   * to ATL-046 and would only be discovered at render time.
   */
  factor_breakdown_json jsonb not null default '{}'::jsonb check (jsonb_typeof(factor_breakdown_json) = 'object'),
  /**
   * What triggered the recalculation, e.g. `asset.updated`, `finding.changed`.
   *
   * Shape-checked rather than an `IN` list, and the dot is deliberate — these
   * are dotted event names. The vocabulary lives in
   * `ScoreRecalculationRequest.reason`, so a new trigger (request completion at
   * M8, demo removal at ATL-083) is an application change rather than a forward
   * migration racing a constant. Same split as ATL-038's `finding_type`.
   */
  reason text not null check (reason ~ '^[a-z][a-z0-9_.]{0,63}$'),
  /**
   * When the score was recorded, from the DATABASE clock.
   *
   * `default now()`, and the application never supplies it (ATL-113). That
   * defect — an application timestamp judged by a constraint reading `now()` —
   * cost two tables and eleven rejected writes, and the fix is cheapest applied
   * before the first row exists rather than after.
   *
   * The not-future check still earns its place, and it cannot fight the
   * default: `now()` is `transaction_timestamp()`, so a defaulted value and the
   * predicate share one clock inside one transaction. What it catches is a
   * caller passing an explicit future value. Backdating stays legal — the
   * compaction tests depend on it.
   */
  recorded_at timestamptz not null default now() check (recorded_at <= now())
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The two reads this table has: "the latest snapshot", which write-on-change
-- compares against on every recalculation, and "this user's history" (ATL-046).
-- `id` makes the ordering total, so two snapshots recorded in the same
-- microsecond cannot swap places between requests.
create index privacy_score_snapshots_user_recorded_idx on public.privacy_score_snapshots (user_id, recorded_at desc, id desc);

-- Compaction scans by age across all users, so this one is deliberately not
-- user-scoped.
create index privacy_score_snapshots_recorded_idx on public.privacy_score_snapshots (recorded_at);

-- Demo isolation, mirroring ATL-027's and ATL-038's partial demo indexes:
-- ATL-083 removes demo data in one action and reads exactly this population.
create index privacy_score_snapshots_demo_idx on public.privacy_score_snapshots (user_id)
where
  is_demo;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.privacy_score_snapshots enable row level security;

-- Deny by default (security §7). The comparison is against `auth.uid()`, which
-- comes from the verified JWT — never a client-supplied value (architecture
-- §10).
--
-- `select` is the only client policy, and the absence of the others is the
-- design: a user who could insert a snapshot could write their own score, and
-- one who could update or delete could rewrite the history that score claims to
-- be evidence of.
create policy "privacy_score_snapshots_select_own" on public.privacy_score_snapshots for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- GRANT then RLS: two independent gates, and the grants match the policies
-- exactly so neither is wider than the other.
revoke all on public.privacy_score_snapshots
from
  anon;

-- `authenticated` — read-only, matching the single policy exactly.
grant
select
  on public.privacy_score_snapshots to authenticated;

-- `service_role` — PrivacyScoreService writes snapshots (ATL-045), retention
-- compaction and the demo purge (ATL-083) delete them.
--
-- **No UPDATE**, deliberately: ADR-004 says snapshots are never recomputed, and
-- withholding the privilege means even a bug in server code cannot rewrite one.
-- DELETE is granted, unlike `activity_events`, because §14 requires compaction
-- and ATL-083 requires the demo purge — both of which remove rows rather than
-- change them.
grant
select
,
  insert,
  delete on public.privacy_score_snapshots to service_role;
