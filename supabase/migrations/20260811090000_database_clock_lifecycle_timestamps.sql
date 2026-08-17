-- Lifecycle timestamps move to the database clock (ATL-113).
--
-- ## The defect, with evidence
--
-- `digital_assets.last_verified_at` and `privacy_findings.resolved_at` were
-- written from the *application* clock and checked against the *database* clock
-- by their own not-future constraints. Those are two clocks, and a value from
-- one compared against the other is a race that fires whenever the round trip
-- is short enough. It was observed, repeatedly, in a local E2E run:
--
--   ERROR: new row for relation "digital_assets" violates check constraint
--          "digital_assets_last_verified_not_future"
--   DETAIL: Failing row contains (..., 2026-08-09 10:12:18.117+00, ...)
--                                       ^ application clock, 3 decimals (JS ms)
--          created_at 2026-08-09 10:12:17.513194+00
--                                       ^ database clock, 6 decimals
--   at 2026-08-09 10:12:18.117 UTC
--
-- Both clocks agreed to within a millisecond, so this is not drift: `now()` is
-- `transaction_timestamp()`, and the transaction need only begin a few
-- microseconds before the client's already-truncated millisecond for the check
-- to reject. Eleven such rejections were logged across two runs, in both tables.
-- In production, where the application servers and the database genuinely do not
-- share a clock, the window is wider, not narrower.
--
-- The fix removes the second clock rather than tolerating the gap: no tolerance,
-- no skew window, no retry. The value and the constraint that judges it are now
-- produced by the same `now()`, in the same transaction, so the predicate cannot
-- fail for timing reasons.
--
-- ## Why triggers
--
-- `20260730120000_create_profiles.sql` already states the principle — "enforced
-- by trigger rather than by application code: a timestamp that depends on every
-- caller remembering it is a timestamp that is wrong eventually" — and ships
-- `public.set_updated_at()`, commented as shared by user-owned tables. These two
-- tables simply never had it attached, and
-- `src/server/repositories/digital-asset-repository.ts` says so in as many
-- words: "`updated_at` is set here rather than left to a trigger: no trigger
-- exists". This migration closes that gap and extends the same mechanism to the
-- two lifecycle timestamps. The codebase contains no RPC call sites, so a
-- database function invoked from the application would have been a new mutation
-- style introduced for two writes.
--
-- Constraints are untouched. Authorization is untouched: every trigger below is
-- `security invoker` and performs no privileged work, so ownership continues to
-- be enforced by the repository predicate and by RLS exactly as before.
-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
--
-- The existing shared function, attached where it was always meant to be. After
-- this, no caller supplies `updated_at` and none can get it wrong.
create trigger digital_assets_set_updated_at
before update on public.digital_assets for each row
execute function public.set_updated_at ();

create trigger privacy_findings_set_updated_at
before update on public.privacy_findings for each row
execute function public.set_updated_at ();

-- ---------------------------------------------------------------------------
-- digital_assets.last_verified_at
-- ---------------------------------------------------------------------------
--
-- ## Why a sentinel rather than "the column changed"
--
-- A review has no status transition to key on: it is defined solely by the act
-- of setting the column. Keying on `new.last_verified_at is distinct from
-- old.last_verified_at` looks like the answer and is subtly broken — the first
-- review of a never-reviewed asset is `null` → `null`, which is *not* distinct,
-- so the trigger would not fire on precisely the case that matters most.
--
-- So the caller states intent with a value that carries no clock at all.
-- `infinity` is the natural choice: it is always distinct from any stored value,
-- it cannot be mistaken for a real observation, and it is self-describing —
-- "later than any time" is exactly what "I have no timestamp, you supply one"
-- means here.
--
-- It also fails closed. If this trigger were ever dropped, `infinity` is
-- rejected by `digital_assets_last_verified_not_future` and the write errors
-- loudly, rather than silently persisting a bogus review date that R-001 and
-- ADR-004's freshness factor would then reason from.
--
-- Any other value passes through untouched, so INSERT-time backdating — demo
-- seeding (ATL-018) and the rule-engine fixtures that need an aged asset —
-- continues to work. This trigger is `before update` only; inserts never see it.
create or replace function public.set_asset_review_time () returns trigger language plpgsql
-- `security invoker` (the default): the function reads no privileged data and
-- must not gain any rights the caller lacks.
set
  search_path = '' as $$
begin
  if new.last_verified_at = 'infinity'::timestamptz then
    new.last_verified_at = now();
  end if;
  return new;
end;
$$;

comment on function public.set_asset_review_time is 'Resolves the review sentinel to the database clock, so last_verified_at and its not-future constraint share one clock (ATL-113).';

create trigger digital_assets_set_review_time
before update on public.digital_assets for each row
execute function public.set_asset_review_time ();

-- ---------------------------------------------------------------------------
-- privacy_findings.resolved_at
-- ---------------------------------------------------------------------------
--
-- Here the transition *is* the key, so no sentinel is needed: a finding acquires
-- a resolution time exactly when its status becomes `resolved` or `dismissed`.
-- Writing it from the transition also makes the timestamp impossible to
-- disagree with the status it belongs to.
--
-- Deliberately silent about `resolved_by`. §11.1 distinguishes a user closing a
-- finding from the engine auto-resolving one, ADR-004 credits only the former,
-- and that value stays exactly as the caller supplies it — this trigger sets a
-- clock and nothing else.
--
-- Reopening (ATL-102) moves the status back to `open` and clears both columns;
-- that is not a transition into a closed state, so this does not fire and the
-- caller's `null` stands.
create or replace function public.set_finding_resolution_time () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  if new.status is distinct from old.status
     and new.status in ('resolved', 'dismissed') then
    new.resolved_at = now();
  end if;
  return new;
end;
$$;

comment on function public.set_finding_resolution_time is 'Stamps resolved_at from the database clock on the transition into a closed status, so it and its not-future constraint share one clock (ATL-113).';

create trigger privacy_findings_set_resolution_time
before update on public.privacy_findings for each row
execute function public.set_finding_resolution_time ();
