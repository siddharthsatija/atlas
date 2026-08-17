-- What the user did about a finding (ATL-042).
--
-- ATL-042: "resolution requires selecting or confirming the action taken".
-- `privacy_findings` already records *that* a user resolved a finding
-- (`resolved_by = 'user'`) and *when* (`resolved_at`, written by ATL-113's
-- trigger from the database clock). It records nothing about *what they did*,
-- so "recording the action taken" had nowhere truthful to live.
--
-- ## A closed vocabulary, not free text
--
-- The same split §7.2 uses everywhere else: the shape is constrained in SQL and
-- the values are owned by the application, in
-- `src/lib/findings/resolution-actions.ts`. Free text was rejected — §11.1
-- keeps user-typed values out of anything a rule or a score reads, and this
-- column is intended to be the source for later reporting, which a free-text
-- column cannot be.
--
-- The five values are the minimum ATL-042 needs, chosen to cover what the seven
-- live rules can actually produce: `reviewed` (R-001/R-002 hygiene),
-- `permission_revoked` (R-004/R-005), `data_removed` (R-003/R-006/R-008),
-- `account_closed`, and `other` for anything else. ATL-043 reuses the same
-- vocabulary rather than inventing a parallel one.
--
-- ## Only on resolution
--
-- Paired with `status` the same way `privacy_findings_resolution_complete`
-- pairs `resolved_by` and `resolved_at`: an action on an open finding claims a
-- decision that has not been made, and a dismissal is not a resolution — ADR-004
-- keeps a dismissed finding's deduction until the underlying condition clears,
-- so recording an "action taken" against one would misdescribe it.
--
-- Nullable, because every row that exists predates this column and because a
-- finding auto-resolved by the engine (`resolved_by = 'system'`) records no
-- user action — nobody took one.
alter table public.privacy_findings
add column resolution_action text;

alter table public.privacy_findings
add constraint privacy_findings_resolution_action_known check (
  resolution_action is null
  or resolution_action in ('reviewed', 'permission_revoked', 'data_removed', 'account_closed', 'other')
);

alter table public.privacy_findings
add constraint privacy_findings_resolution_action_scoped check (
  resolution_action is null
  or status = 'resolved'
);

comment on column public.privacy_findings.resolution_action is 'What the user did about the finding, from the closed vocabulary in src/lib/findings/resolution-actions.ts (ATL-042). Null for open, dismissed, and engine auto-resolved findings.';
