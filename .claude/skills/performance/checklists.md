# Performance Review Checklist

## Caching safety (highest priority)

- [ ] No authenticated response cached in a CDN or shared cache
- [ ] Authenticated responses set `Cache-Control: private, no-store`
- [ ] No decrypted value cached in memory across requests, in a client store, or in web storage
- [ ] Private caching, where used, is short-lived and covers non-sensitive derived data only
- [ ] Dashboard and list data invalidated after mutations
- [ ] Request-scoped memoization discarded at request end
- [ ] No user-specific data in a statically rendered route

## Rendering

- [ ] Data-heavy read views are Server Components
- [ ] `"use client"` limited to interactive leaves
- [ ] No client-side fetching of protected data
- [ ] Dashboard served by the single aggregated query
- [ ] Only genuinely public pages are statically rendered

## Streaming and loading

- [ ] Route-level `loading.tsx` provides a structural skeleton
- [ ] Suspense boundaries wrap genuinely slow, independent sections
- [ ] Fallback skeletons match final structure (no layout shift)
- [ ] No Suspense boundary around trivially fast content
- [ ] Layout space reserved for async content, images, and charts
- [ ] Long AI operations show progress and allow cancellation

## Bundle and assets

- [ ] Charts, assistant panel, command palette, and request modal lazy-loaded
- [ ] Nothing in the critical path is lazy-loaded
- [ ] Narrow named imports; no barrel imports pulling in whole libraries
- [ ] No heavy animation library for CSS-expressible transitions
- [ ] No server-only utility leaked into the client bundle
- [ ] New dependency's bundle impact measured and justified
- [ ] Service icons optimized with a neutral missing-logo fallback

## Database

- [ ] Keyset pagination for activity, notifications, requests, findings
- [ ] Indexes exist for the filters actually used
- [ ] No query, filter, sort, or index on an encrypted column
- [ ] No N+1 across repository calls
- [ ] Decryption limited to values that are displayed
- [ ] `explain analyze` verified against realistic row counts
- [ ] Transactions short; follow-up work enqueued after commit
- [ ] Statement timeout applies on user-facing paths

## Jobs

- [ ] Slow, retryable, or fan-out work moved off the request path
- [ ] Job work batched and bounded per user
- [ ] Duration and failure rate tracked
- [ ] Trending duration treated as a capacity signal

## Budgets and measurement

- [ ] Dashboard usable within 2.5 s on typical broadband
- [ ] Interaction feedback within 100 ms
- [ ] LCP, CLS, and bundle budgets pass in CI
- [ ] Measured with realistic data volumes, not seed rows
- [ ] p95/p99 reviewed, not just averages
- [ ] Any budget increase documented as a deliberate decision

## Monitoring

- [ ] Captures request ID, route, status, latency, error code, provider availability, AI schema failures, job status, RLS denials
- [ ] Captures none of: names, addresses, phones, emails, account identifiers, bodies, prompts, drafts, tokens
- [ ] Correlation by request ID, never by personal identifiers
- [ ] AI latency tracked separately, including fallback rate
- [ ] Alerts configured for budget regression, error-rate spikes, provider outage, repeated job failure
