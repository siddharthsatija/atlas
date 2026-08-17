-- Evidence for ATL-114 · timeline cursor predicate and plan stability.
--
-- Shows, on a copy of `activity_events` holding representative data, that the
-- disjunctive cursor the repository sends today leaves the plan shape
-- undetermined, while the row-comparison form compiles to a true index seek.
--
-- Run it from the repository root:
--
--   docker exec -i supabase_db_atlas-local psql -U postgres -d postgres \
--     < supabase/snippets/timeline-plan-probe.sql
--
-- NON-DESTRUCTIVE. Everything happens inside a transaction that ends in
-- `rollback`, in a scratch schema, on a copy of the table. `public.activity_events`
-- is read for its column definitions only — never written to, never analyzed.
-- The copy carries no foreign key, so no `auth.users` rows are needed or touched.
--
-- ## What it prints
--
-- Two data shapes, each holding 12,000 rows and each freshly analyzed, differing
-- only in how those rows are distributed across users. For each shape it prints
-- the plan for the OR form and for the row-comparison form, over the same table,
-- the same statistics and the same cursor.
--
-- Expected, and the whole point:
--
--   * 12 users x 1000 rows — OR form chooses an ordered Index Scan.
--   * 40 users x 300 rows  — OR form chooses BitmapOr -> Bitmap Heap Scan -> Sort.
--   * The row-comparison form chooses an ordered Index Scan in BOTH.
--
-- `A OR B` is not a range, so the cursor cannot become a btree boundary; the
-- planner must instead guess how many rows the disjunction rejects before it can
-- fill the LIMIT. That guess is wrong by construction — a cursor is perfectly
-- correlated with the sort order and PostgreSQL has no way to represent that —
-- so the shape flips with the distribution. `(occurred_at, id) < (ts, id)` is a
-- single lexicographic range qual, so it becomes `Index Cond`, no BitmapOr is a
-- candidate, no Sort is possible, and the scan starts at the cursor rather than
-- at the newest row.
--
-- This is why the keyset case in tests/integration/activity-events-rls.test.ts
-- does not assert the absence of `Sort`, and why ATL-114 is the fix rather than
-- an index or statistics change. Note that both plans use the same index: the
-- index is correct as written, including its `id` tiebreak and its `desc`
-- directions, which is precisely what makes the row comparison seekable.
begin;

create schema plan_probe;

-- Same columns, defaults and check constraints as the real table. `like` does
-- not copy foreign keys, which is what keeps this independent of auth.users.
create table plan_probe.activity_events (like public.activity_events including defaults including constraints);

-- The ATL-068 timeline index, renamed so the plan output is unambiguous about
-- which table it is describing. Definition is otherwise identical.
create index probe_timeline_idx on plan_probe.activity_events (user_id, occurred_at desc, id desc);

do $probe$
declare
  shape record;
  owner uuid;
  ats timestamptz;
  aid uuid;
  line text;
  or_sql text;
  row_sql text;
begin
  for shape in
    select *
    from (
      values (12, 1000), (40, 300)
    ) as s (users, per_user)
  loop
    delete from plan_probe.activity_events;

    -- `occurred_at` scattered across a year, so physical order carries no
    -- correlation with timeline order — as in production and in the test seed.
    insert into plan_probe.activity_events
      (user_id, event_type, summary, occurred_at, entity_type, entity_id)
    select
      u.id,
      (array['asset.created', 'asset.updated', 'finding.opened'])[1 + floor(random() * 3)],
      'Seeded timeline event',
      now() - (random() * interval '365 days'),
      'asset',
      gen_random_uuid()
    from (
      select gen_random_uuid() as id, generate_series(1, shape.users)
    ) u,
    generate_series(1, shape.per_user);

    analyze plan_probe.activity_events;

    -- The user carrying the cursor, and the 201st newest of their rows.
    select user_id into owner from plan_probe.activity_events limit 1;

    select occurred_at, id into ats, aid
    from plan_probe.activity_events
    where user_id = owner
    order by occurred_at desc, id desc
    offset 200
    limit 1;

    -- Literal-substituted rather than parameterised, so the planner sees the
    -- same values a custom plan would.
    or_sql := format(
      'explain select * from plan_probe.activity_events
         where user_id = %L and (occurred_at < %L or (occurred_at = %L and id < %L))
         order by occurred_at desc, id desc limit 50',
      owner, ats, ats, aid);

    row_sql := format(
      'explain select * from plan_probe.activity_events
         where user_id = %L and (occurred_at, id) < (%L::timestamptz, %L::uuid)
         order by occurred_at desc, id desc limit 50',
      owner, ats, aid);

    raise notice '';
    raise notice '################ % users x % rows = % total ################',
      shape.users, shape.per_user, shape.users * shape.per_user;
    raise notice '';
    raise notice '--- OR form (what the repository sends today) ---';
    for line in execute or_sql loop
      raise notice '%', line;
    end loop;

    raise notice '';
    raise notice '--- row-comparison form (ATL-114) ---';
    for line in execute row_sql loop
      raise notice '%', line;
    end loop;
  end loop;
  raise notice '';
end
$probe$;

rollback;
