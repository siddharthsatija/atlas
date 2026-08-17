-- ATL-102 · privacy_findings.input_hash
--
-- Re-fire suppression for dismissed findings. Architecture §11.1 ("a dismissed
-- finding is not re-raised for the same `dedup_key` unless the rule inputs
-- materially change — input hash changes"), ADR-001.
--
-- APPEND-ONLY: this migration adds one nullable column and nothing else. No
-- constraint, index, policy, or grant changes — `privacy_findings` keeps
-- ATL-038's shape, including `select`-only access for `authenticated`.
--
-- ## Why a column rather than a corner of `evidence_refs_json`
--
-- §7.5 documents that jsonb as "IDs of the records the rule evaluated", and
-- ATL-038's own column comment says "identifiers only — never the values
-- themselves". A derived hash is neither, and putting it there would make both
-- statements false and force every future reader of evidence refs to know which
-- keys to skip.
--
-- Adding a column beyond §7.5's original list follows the precedent ADR-001 set:
-- its Consequences section already amended that list once, adding `rule_id`,
-- `rule_version`, `dedup_key`, `evidence_refs_json` and `resolved_by`. §7.5 is
-- updated alongside this migration.
--
-- ## Nullable, deliberately
--
-- ATL-101 has already written findings without one, and there is no honest
-- backfill: the hash summarises the records *as they were when the rule fired*,
-- and that snapshot no longer exists. A default value would be worse than null —
-- it would assert an input state nobody observed, and the first evaluation after
-- this migration would read it as "unchanged" and suppress a finding that should
-- have re-fired.
--
-- Null therefore means "not recorded", and the engine treats it as *unknown
-- rather than unchanged*: a dismissed finding with no stored hash is left
-- dismissed and given a hash on the next evaluation, so the ambiguity resolves
-- itself once and never silently overrides a user's dismissal.
alter table public.privacy_findings
add column input_hash text check (
  input_hash is null
  or input_hash ~ '^[0-9a-f]{64}$'
);

comment on column public.privacy_findings.input_hash is 'SHA-256 of the material field values of the records the rule evaluated (ATL-102, §11.1). Null for findings written before ATL-102, and for demo-seeded findings. Compared on re-fire: a dismissed finding returns only when this changes.';
