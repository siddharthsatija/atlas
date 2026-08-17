-- ATL-038 · privacy_findings
--
-- What Atlas has concluded about a user's own records. Architecture §7.5 and
-- §11.1 (the rule catalog and lifecycle), ADR-001 (the deterministic engine),
-- PRD FR-05, ADR-004 (the score's open-findings factor).
--
-- APPEND-ONLY: this migration adds one table and nothing else. The composite
-- foreign key below targets the `unique (user_id, id)` on `digital_assets` that
-- ATL-028 added; re-adding it would fail.
--
-- ## Nothing here is encrypted, and that is a decision with a source
--
-- Security §3 classifies findings as **Confidential**, not Restricted, and §8's
-- authoritative encrypted-column inventory names no column on this table. So
-- ADR-003 does not apply. What keeps restricted values out is §11.1's evidence
-- model — `evidence_summary` is rendered from a template using only service
-- names, categories, dates and counts — and that is the engine's obligation
-- (ATL-101), not something a check constraint can see.
--
-- ## Findings are not user-authored, and the grants say so
--
-- Every other user-owned table in Atlas lets the client write. This one does
-- not: `authenticated` gets `select` and nothing else. NFR-06 requires every
-- finding to be traceable to a rule, source, or model output; a client insert
-- would produce a finding traceable to nobody. §11.1 requires resolution and
-- dismissal to write activity events and feed score recalculation, which only
-- `FindingService` (ATL-040) does — a direct client update would change status
-- while skipping both. And `resolved_by = 'system'` is an assertion the system
-- makes about itself.
create table public.privacy_findings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  /**
   * The asset this finding is about, when it is about one.
   *
   * Nullable per §7.5, and genuinely so: R-008 (category_concentration) is a
   * statement about a user's whole footprint rather than any single service, and
   * forcing it to name one asset would make the finding say something it does
   * not mean.
   *
   * `on delete cascade` through the composite key below: ADR-001 requires every
   * finding to cite the records it evaluated, so a finding whose subject no
   * longer exists cannot be explained, only displayed.
   */
  asset_id uuid,
  /**
   * What kind of concern this is — §11.1's four rule categories.
   *
   * Not the rule's name. `rule_id` is null for demo-seeded findings (§7.5), so a
   * rule-named type would leave those findings typed after a rule that never
   * ran, and would duplicate `rule_id` for the ones where it is populated. The
   * category is also what groups findings for the user, which is what a type
   * column is for.
   *
   * Shape-checked here, vocabulary owned by `src/lib/findings/findings.ts` —
   * the same split `digital_assets.category` uses, so a fifth category is an
   * application change rather than a forward migration racing a constant.
   */
  finding_type text not null check (finding_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  /**
   * Which rule produced this, and at which catalog version.
   *
   * `rule_id` is null for demo-seeded findings (§7.5) — ATL-018's dataset
   * illustrates the experience without pretending a rule evaluated it. For
   * everything else ADR-001's explainability guarantee rests on this pair:
   * `source_reference` carries `rule_id@rule_version` for display, and these
   * columns carry it for querying.
   */
  rule_id text check (
    rule_id is null
    or rule_id ~ '^[A-Za-z][A-Za-z0-9._-]{0,63}$'
  ),
  rule_version text check (
    rule_version is null
    or rule_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'
  ),
  /**
   * Deterministic hash of the rule and the entity scope it evaluated (§11.1).
   *
   * The uniqueness below is what makes "a rule fires once per condition" true in
   * the database rather than only in the engine. ATL-102 owns generating it and
   * the dismissal-suppression rules that read it.
   */
  dedup_key text not null check (char_length(dedup_key) between 1 and 200),
  title text not null check (char_length(title) between 1 and 200),
  description text not null check (char_length(description) between 1 and 2000),
  -- §11.1. `critical` is deliberately reachable but rare: frontend §8 reserves
  -- critical styling for genuinely critical, verified findings.
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  /**
   * How much Atlas trusts this finding — §11.1's confidence model.
   *
   * Derived from the source and staleness of the inputs, never asserted by a
   * rule: inputs older than 180 days cap it at medium, older than 365 days at
   * low, and a finding's confidence is the minimum across its inputs. The same
   * three values as `digital_assets.confidence`, because it is the same scale.
   */
  confidence text not null default 'medium' check (confidence in ('low', 'medium', 'high')),
  /**
   * Where the finding came from, reusing `digital_assets.source_type`.
   *
   * §11.1 pins only `demo` — findings generated over demo records carry it and
   * are removed with the demo data (ATL-083), and §11.2 forbids demo and real
   * records mixing in one score. The remaining values are inherited rather than
   * invented: a second vocabulary for the same concept is how two tables drift.
   */
  source_type text not null default 'manual' check (source_type in ('manual', 'demo', 'connector', 'import')),
  -- §11.1: `rule_id@rule_version` for engine findings. Free-form because a
  -- future non-rule source (a connector's own assessment) would name itself
  -- differently, and this column exists to be shown, not parsed.
  source_reference text check (
    source_reference is null
    or char_length(source_reference) between 1 and 200
  ),
  -- Rendered from the rule's template using only non-restricted values (§11.1).
  evidence_summary text not null check (char_length(evidence_summary) between 1 and 2000),
  /**
   * IDs of the records the rule evaluated (§11.1).
   *
   * Identifiers only — never the values themselves. This is what lets a user ask
   * "why am I being told this?" and get an answer that points at their own
   * records rather than a restatement of the finding.
   */
  evidence_refs_json jsonb not null default '{}'::jsonb,
  recommended_action text not null check (char_length(recommended_action) between 1 and 500),
  -- §11.1's lifecycle: open → in_progress → resolved or dismissed.
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'dismissed')),
  /**
   * Who ended this finding's life, and `system` is the interesting one.
   *
   * §11.1: when a rule's predicate stops holding, the engine resolves the
   * finding itself with `resolved_by = 'system'`. That is the difference between
   * "you fixed it" and "it no longer applies", and ADR-004's protective-actions
   * factor counts resolutions, so conflating them would credit the user for
   * something they did not do.
   */
  resolved_by text check (
    resolved_by is null
    or resolved_by in ('user', 'system')
  ),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  /**
   * Cross-user protection, structural (architecture §8; the pattern ATL-028
   * established and ATL-029 reused).
   *
   * A plain `references digital_assets (id)` would satisfy referential integrity
   * while allowing a finding that claims one owner and points at another's
   * asset — invisible to both behind RLS, and visible to the rules engine and
   * the score, which read with service-role.
   *
   * `match simple` is the default and is what makes a null `asset_id` legal:
   * the constraint is satisfied when any referencing column is null, which is
   * exactly the user-scoped-finding case.
   */
  constraint privacy_findings_asset_fkey foreign key (user_id, asset_id) references public.digital_assets (user_id, id) on delete cascade,
  /**
   * One open condition, one finding (§11.1's deduplication).
   *
   * Unique per user rather than per user and status: re-firing a rule for a
   * condition that already has a dismissed finding would put the same sentence
   * on screen twice and deduct twice in ADR-004's open-findings factor.
   * ATL-102 owns the re-fire rules that live above this constraint.
   */
  constraint privacy_findings_dedup_unique unique (user_id, dedup_key),
  /**
   * Resolution is a fact with a time and an author, or it has not happened.
   *
   * A resolved finding with no `resolved_at` cannot be placed in the trailing
   * 180-day window ADR-004's protective-actions factor counts, and a
   * `resolved_by` on an open finding claims an ending that did not occur.
   */
  constraint privacy_findings_resolution_complete check (
    (
      status in ('resolved', 'dismissed')
      and resolved_by is not null
      and resolved_at is not null
    )
    or (
      status in ('open', 'in_progress')
      and resolved_by is null
      and resolved_at is null
    )
  ),
  -- Resolution dates feed a trailing-window calculation, so a future one would
  -- quietly change a score.
  constraint privacy_findings_resolved_not_future check (
    resolved_at is null
    or resolved_at <= now()
  ),
  -- Explainability is a pair: a finding that names a rule must name its version,
  -- because ADR-001 requires a rule change to be recorded on the findings it
  -- generated. Demo-seeded findings have neither.
  constraint privacy_findings_rule_versioned check (
    (
      rule_id is null
      and rule_version is null
    )
    or (
      rule_id is not null
      and rule_version is not null
    )
  )
);

comment on table public.privacy_findings is 'Deterministic rule-engine findings over a user''s own records (ATL-038, architecture §7.5/§11.1, ADR-001). Owner-scoped by RLS; cross-user links prevented by a composite foreign key. Read-only to clients — findings are generated and resolved server-side.';

comment on column public.privacy_findings.finding_type is 'hygiene | exposure | permissions | requests — §11.1''s rule categories. Vocabulary lives in src/lib/findings/findings.ts; constrained by shape here.';

comment on column public.privacy_findings.rule_id is 'Generating rule, null for demo-seeded findings (§7.5). Paired with rule_version by a check constraint.';

comment on column public.privacy_findings.dedup_key is 'hash(rule_id + sorted entity IDs in scope). Unique per user: a rule fires once per condition (§11.1).';

comment on column public.privacy_findings.confidence is 'low | medium | high. Derived from input source and staleness, never asserted by a rule (§11.1).';

comment on column public.privacy_findings.evidence_summary is 'Rendered from the rule''s template using only non-restricted values (§11.1). Findings are Confidential, not Restricted: no column here is in security §8''s encrypted inventory.';

comment on column public.privacy_findings.resolved_by is 'user | system. `system` means the rule predicate stopped holding and the engine auto-resolved (§11.1).';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- Frontend §8's Insights views (Recommended, All, Resolved, Dismissed) and
-- ADR-004's open-findings factor, which sums deductions by severity over open
-- findings. Status leads because every one of those queries fixes it.
create index privacy_findings_status_severity_idx on public.privacy_findings (user_id, status, severity);

-- Keyset pagination on `(created_at desc, id desc)`, the total ordering ATL-027
-- established for asset lists — so a filtered page is an index scan rather than
-- a scan plus sort.
create index privacy_findings_created_idx on public.privacy_findings (user_id, created_at desc, id desc);

-- The asset detail page's findings section (frontend §7): open findings for one
-- asset. Partial, because a resolved finding does not belong in that section and
-- open findings are the minority once a user has been active for a while.
create index privacy_findings_asset_open_idx on public.privacy_findings (user_id, asset_id)
where
  status in ('open', 'in_progress');

-- Demo isolation, mirroring ATL-027's partial index: ATL-083 removes demo data
-- in one action, and §11.2's demo scoring reads exactly this population.
create index privacy_findings_demo_idx on public.privacy_findings (user_id, created_at desc)
where
  source_type = 'demo';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.privacy_findings enable row level security;

-- Deny by default (security §7). The comparison is against `auth.uid()`, which
-- comes from the verified JWT — never a client-supplied value (architecture §10).
--
-- `select` is the only client policy. There is deliberately no insert, update or
-- delete policy: see the header. The absence is the design, not an omission.
create policy "privacy_findings_select_own" on public.privacy_findings for
select
  to authenticated using (auth.uid () = user_id);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- GRANT then RLS: two independent gates, and the grants match the policies
-- exactly so neither is wider than the other. Here that means `authenticated`
-- cannot write even if a policy were added by mistake.
revoke all on public.privacy_findings
from
  anon;

grant
select
  on public.privacy_findings to authenticated;

-- `service_role` — the rules engine (ATL-101), auto-resolution (ATL-102),
-- FindingService (ATL-040), and demo removal (ATL-083).
grant
select
,
  insert,
update,
delete on public.privacy_findings to service_role;
