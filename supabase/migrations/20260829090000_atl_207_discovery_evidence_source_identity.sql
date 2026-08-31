-- ATL-207: HIBP discovery provider — evidence idempotency columns.
--
-- Adds `field_id` (which personal field was queried) and `source_identifier`
-- (provider-normalised breach/source key) to `discovery_evidence`.
--
-- These two columns let the result writer use ON CONFLICT DO NOTHING, making
-- concurrent evidence writes safe and idempotent without a SELECT-then-INSERT.
-- For HIBP, source_identifier = breach_name.trim().toLowerCase().
--
-- Backfill: existing rows receive a random field_id and the sentinel 'legacy'.
-- Both satisfy the length constraint; they carry no useful deduplication
-- meaning for rows written before this migration.  Forward: every insert must
-- supply explicit values (defaults are dropped immediately after backfill).
alter table public.discovery_evidence
add column field_id uuid not null default gen_random_uuid(),
add column source_identifier text not null default 'legacy';

-- Drop the backfill defaults so that future inserts must supply explicit values.
alter table public.discovery_evidence
alter column field_id
drop default,
alter column source_identifier
drop default;

-- source_identifier must be non-empty and at most 255 chars.
alter table public.discovery_evidence
add constraint discovery_evidence_source_identifier_length check (char_length(source_identifier) between 1 and 255);

-- Deduplication key: one evidence row per (user, invocation, provider, field, source).
-- The result writer issues ON CONFLICT DO NOTHING against this constraint.
alter table public.discovery_evidence
add constraint discovery_evidence_field_source_key unique (user_id, invocation_id, provider_class, field_id, source_identifier);
