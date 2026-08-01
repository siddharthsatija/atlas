---
name: deployment
description: Atlas deployment guidance covering environments, secrets management, CI/CD gates, the release process, rollback, monitoring, and health checks. Use when configuring environments, changing CI, running a release, or responding to a bad deploy.
---

# Atlas Deployment

**Sources of truth:** `docs/02-technical-architecture.md` §18–19 (environments, CI/CD gates), `docs/03-security-and-access.md` §9 (secrets), §20 (incident response), §21 (launch checklist).

## Purpose

Ship safely and reversibly. Atlas holds sensitive personal data under an append-only migration rule, so deployment discipline is a data-integrity concern, not just an operational nicety.

## Core principles

1. Four isolated environments; production data never moves downward.
2. Secrets are per-environment, never in the repository or a client bundle.
3. CI gates are blocking, not advisory.
4. Migrations are append-only and forward-only.
5. Every release has a rehearsed rollback path.
6. Deploy behind monitoring you already trust.
7. An exposed credential is a compromised credential.

## Environments

| Environment | Purpose                                | Data                                            |
| ----------- | -------------------------------------- | ----------------------------------------------- |
| Local       | Development                            | Synthetic only; local Supabase                  |
| Preview     | Per-PR verification                    | Synthetic; isolated project or ephemeral schema |
| Staging     | Production-like validation, E2E target | Synthetic only                                  |
| Production  | Real users                             | Real data; strictest access                     |

Rules:

- Separate Supabase project, keys, database, and storage per environment (architecture §18).
- **Production data must never be copied to a lower environment.** Not for debugging, not "just this table". Reproduce with synthetic fixtures.
- Preview environments are not permitted to point at production anything.
- Local development uses the local Supabase instance with migrations applied from scratch.

## Secrets

- Stored in Vercel/Supabase/approved secret stores; separate values per environment.
- Never committed (`.env` excluded), never in client bundles, never logged.
- Atlas-specific secrets requiring extra care: the **environment KEK** (ADR-003), the **audit HMAC key** (ADR-006), the Supabase service-role key, and the AI provider key. None may ever appear client-side — CI asserts this via bundle analysis.
- Production secret visibility is restricted to the minimum set of people; access logged where supported.
- Rotation: documented and rehearsed procedures for KEK re-wrap and per-user DEK rotation before launch. Any exposed credential is rotated immediately and the exposure documented.
- CI has no access to production secrets.

## CI/CD gates

All of these block merge (architecture §19):

- Formatting, lint, type check
- Unit tests, integration tests
- Production build
- Migration validation (detects non-append-only edits)
- Dependency and secret scanning (ATL-090)
- Security tests for changed policies (two-user RLS matrix, ATL-088)
- Accessibility smoke tests (ATL-091)
- Performance budgets (ATL-093)
- Client-bundle secret assertion

A red gate is never bypassed. If a gate is wrong, fix the gate in its own change.

## Migration deployment

Because migrations are append-only after shared deployment:

- Migrations run as part of the deploy pipeline, before the new application version serves traffic.
- Every migration must be backward-compatible with the currently deployed application version — the old code keeps running while the migration lands.
- Use **expand/contract**: add, backfill idempotently, switch reads, stop writing the old path, and only later contract in a separate deliberate change.
- Backfills are idempotent, resumable, and batched so they do not lock hot tables.
- New tables ship with RLS and policies in the same migration; a table without RLS reaching production is a security incident, not a bug.
- Migration failure aborts the deploy and leaves the previous version serving.

## Release process

1. Confirm the target tickets are complete with their testing requirements satisfied.
2. Verify all CI gates green on the merge commit.
3. Deploy to staging; run the E2E suite (ATL-092) including the AI-unavailable variant.
4. Verify staging security headers, rate limits, and export/deletion flows.
5. Review the migration plan: backward-compatible, reversible-by-expand, backfill bounded.
6. Deploy to production with migrations first, application second.
7. Run post-deploy smoke checks (health, sign-in, dashboard, one mutation, one job).
8. Watch error rate, p95 latency, provider availability, and job success for the agreed window.
9. Record the release: version, migrations included, tickets, and any residual risk.

For launch specifically, ATL-099 (security review) and ATL-100 (readiness review) gate release, and the security §21 checklist must be fully evidenced.

## Rollback

- **Application rollback** is the primary lever: redeploy the previous build. Must be rehearsed before production launch (ATL-098).
- **Migrations do not roll back.** This is why every migration is backward-compatible with the previous app version — rolling the app back must remain safe with the new schema in place.
- If a migration causes harm, the remedy is a new forward migration, not an edit or a down-migration.
- Feature flags are the preferred way to disable a misbehaving feature without a redeploy.
- Rollback decision criteria, defined in advance: error-rate spike, authorization anomaly, data-integrity concern, or any suspected exposure of restricted data. Suspected exposure triggers incident response (security §20), not just a rollback.

## Monitoring and health checks

- **Health endpoint** reports application liveness plus dependency reachability (database, storage, AI provider, rate-limit store) without leaking configuration or version internals to unauthenticated callers.
- Post-deploy smoke: sign-in, dashboard load, one authenticated mutation, one background job completion.
- Alert on: error-rate increase, p95/p99 regression, provider unavailability, AI schema-failure rate, repeated job failure, RLS denial spikes (a possible probing signal), and budget regressions.
- Monitoring payloads follow the same redaction allowlist as application logs — no personal data in alerts, dashboards, or error reports.
- Correlate incidents by request ID.

## Common mistakes

- Copying a production table into staging to reproduce a bug.
- A preview deployment pointed at production Supabase.
- Reusing one API key across environments.
- Editing a deployed migration instead of writing a forward one.
- A migration that breaks the currently running app version.
- Deploying with a gate skipped "because it's urgent".
- Shipping a new table without RLS policies in the same migration.
- Assuming a down-migration exists as a rollback plan.
- No rehearsed rollback before the first production release.
- Alert payloads containing user emails or identifiers.
- Rotating a leaked key but leaving the old one valid.

## Decision framework

**Is this change safe to deploy?** Gates green, migration backward-compatible, rollback path known, monitoring in place. Any "no" stops the deploy.

**Migration now or with the feature?** Schema first (backward-compatible), feature after. Never simultaneously breaking.

**Rollback or forward-fix?** Rollback for a broken deploy with a clean previous version. Forward-fix for anything schema-related. Suspected data exposure escalates to incident response immediately.

**Feature flag or deploy gate?** Flag when you want to ship code dark or disable quickly without redeploying. Gate when the code should not exist in production yet.

**Can I debug this with production data?** No. Reproduce with synthetic fixtures; if you cannot, improve observability rather than copying data.

## Review checklist

Full version in `checklists.md`. Fast pass:

- [ ] Environment isolation intact; no production data or keys in lower environments
- [ ] Secrets per-environment; KEK, audit HMAC, service-role, and AI keys server-side only
- [ ] All CI gates green, none bypassed
- [ ] Migration append-only and backward-compatible with the running app version
- [ ] New tables include RLS policies in the same migration
- [ ] Rollback path known and rehearsed
- [ ] Post-deploy smoke checks and alerts in place
- [ ] Monitoring payloads free of personal data
