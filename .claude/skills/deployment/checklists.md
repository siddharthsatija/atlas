# Deployment Checklist

## Environment integrity

- [ ] Separate Supabase project, keys, database, and storage per environment
- [ ] No production data in local, preview, or staging
- [ ] No preview or staging deployment pointing at production resources
- [ ] Local environment builds from migrations applied from scratch
- [ ] CI has no access to production secrets

## Secrets

- [ ] All secrets in an approved store, distinct per environment
- [ ] No `.env` committed; secret scan green
- [ ] Environment KEK, audit HMAC key, service-role key, and AI provider key are server-side only
- [ ] Client-bundle assertion proves no server secret is shipped
- [ ] Production secret access restricted and logged where supported
- [ ] KEK re-wrap and DEK rotation procedures documented and rehearsed
- [ ] Any exposed credential rotated, old value invalidated, exposure documented

## Pre-merge gates

- [ ] Format, lint, typecheck pass
- [ ] Unit and integration tests pass
- [ ] Production build succeeds
- [ ] Migration validation passes (no edits to deployed migrations)
- [ ] Dependency and secret scanning clean of unresolved critical findings
- [ ] Two-user RLS matrix passes, including new tables
- [ ] Accessibility smoke checks pass
- [ ] Performance budgets pass
- [ ] No gate bypassed or suppressed

## Migration readiness

- [ ] Append-only; no modification of deployed migrations
- [ ] Backward-compatible with the currently deployed application version
- [ ] Expand/contract used for otherwise-breaking changes
- [ ] Backfill idempotent, resumable, and batched
- [ ] New tables include RLS and all policies in the same migration
- [ ] Indexes for new foreign keys and known filters included
- [ ] Failure aborts the deploy and leaves the previous version serving

## Staging validation

- [ ] Full E2E suite passes on staging
- [ ] AI-unavailable variant passes
- [ ] Export generation, signed URL, and expiry verified
- [ ] Account deletion verified end to end, including DEK destruction
- [ ] Security headers verified (nonce-based CSP, HSTS, frame-ancestors, Referrer-Policy, Permissions-Policy)
- [ ] Rate limits verified against the shared store
- [ ] Notifications and follow-up jobs verified

## Production deploy

- [ ] Target tickets complete with testing requirements met
- [ ] Migrations applied before the new application version serves traffic
- [ ] Post-deploy smoke: health, sign-in, dashboard, one mutation, one job completion
- [ ] Error rate, p95 latency, provider availability, and job success observed for the agreed window
- [ ] Release recorded: version, migrations, tickets, residual risk

## Rollback readiness

- [ ] Previous build identified and redeployable
- [ ] Rollback rehearsed at least once before first production release
- [ ] Rolling back the app is safe with the new schema in place
- [ ] Feature flag available for the risky surface, where applicable
- [ ] Rollback criteria agreed in advance (error spike, authorization anomaly, data-integrity concern, suspected exposure)
- [ ] Suspected exposure of restricted data escalates to incident response, not just rollback

## Monitoring and health

- [ ] Health endpoint reports app and dependency status without leaking internals
- [ ] Alerts configured for error rate, latency regression, provider outage, AI schema failures, job failures, RLS denial spikes, budget regressions
- [ ] Monitoring and alert payloads contain no personal data
- [ ] Incident correlation by request ID only
- [ ] On-call contacts and escalation path documented

## Launch-only (ATL-099 / ATL-100)

- [ ] Security §21 checklist fully evidenced
- [ ] Threat model T1–T8 controls confirmed
- [ ] Accessibility audit complete
- [ ] Legal and privacy copy reviewed
- [ ] Demo claims clearly labeled
- [ ] Export and deletion tested end to end
- [ ] AI-unavailable state tested
- [ ] `docs/open-questions.md` reviewed with no launch-blocking decision outstanding
- [ ] Residual risks documented and signed off
