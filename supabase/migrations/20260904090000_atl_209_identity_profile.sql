-- ATL-209: Identity Profile step completion marker
--
-- A nullable TIMESTAMPTZ on profiles, stamped once when the user presses Continue
-- on the Identity Profile onboarding step. First-write semantics: the repository
-- method only writes when the column IS NULL, so a repeat submission or a
-- concurrent request can never move the timestamp forward.
--
-- Pre-M13 users arrive with onboarding_completed_at IS NOT NULL and this column
-- IS NULL. The product layout gate (ATL-209) detects that combination and routes
-- them to the Identity Profile upgrade step before they reach any product surface.
-- Once they complete the step, both columns are non-null and the gate passes
-- permanently — no re-check of field content, no clearing on deletion.
alter table public.profiles
add column identity_profile_step_completed_at timestamptz;

comment on column public.profiles.identity_profile_step_completed_at is 'Stamped once when the user completes the Identity Profile onboarding step (ATL-209). NULL means the step has not been completed. First-write semantics: never overwritten.';
