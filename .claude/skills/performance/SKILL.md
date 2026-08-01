---
name: performance
description: Atlas performance guidance covering rendering strategy, caching rules for sensitive data, Suspense and streaming, lazy loading, bundle optimization, database performance, and monitoring. Use when building data-heavy views, investigating slowness, or reviewing anything on a hot path.
---

# Atlas Performance

**Sources of truth:** `docs/01-product-requirements.md` NFR-01, `docs/04-frontend-specification.md` §22, `docs/02-technical-architecture.md` §15 (caching) and §16 (observability).

## Purpose

Meet the product's speed commitments — dashboard usable within 2.5 s, interaction feedback within 100 ms — without ever trading privacy for speed. In Atlas, caching is a security concern first and a performance technique second.

## Core principles

1. **Never cache user-specific sensitive responses in a shared cache.** This is a hard rule, not a tradeoff.
2. Render on the server by default; ship less JavaScript.
3. Stream what is slow; do not block a whole page on the slowest query.
4. Reserve layout space so nothing shifts.
5. Decrypt and fetch only what is displayed.
6. Measure with realistic data volumes, not seed rows.
7. Budgets are enforced in CI, not aspirations.

## Budgets

| Metric                      | Target                               | Source  |
| --------------------------- | ------------------------------------ | ------- |
| Dashboard usable after auth | ≤ 2.5 s on typical broadband         | NFR-01  |
| Interaction feedback        | ≤ 100 ms                             | NFR-01  |
| Long AI operations          | show progress and allow cancellation | NFR-01  |
| LCP / CLS / bundle          | thresholds enforced in CI            | ATL-093 |

Budget failures block merge (ATL-093). If a change legitimately needs more budget, that is a documented decision, not a silent regression.

## Rendering strategy

- **Server Components by default** for data-heavy read views: asset list, asset detail, insights, requests, activity (frontend §22).
- **Client Components only at interactive leaves** — see the `architecture` skill. Every unnecessary `"use client"` ships more JavaScript and delays interactivity.
- **No client-side data fetching for protected data.** It costs a round trip, duplicates authorization, and risks leaking data into client caches.
- **One aggregated dashboard query** (ATL-019) rather than several parallel fetches. Aggregate server-side, pass plain props.
- Static rendering is available only for genuinely public pages (marketing, privacy, terms). Everything under `(product)` is dynamic and user-specific.

## Caching rules

Ordered by strictness:

1. **Never** cache responses containing user data in a CDN or any shared cache. Set `Cache-Control: private, no-store` on authenticated responses.
2. **Never** cache decrypted values anywhere — not in memory across requests, not in a client store, not in `localStorage`.
3. Private, short-lived caching is acceptable for non-sensitive derived summaries within a single request lifecycle.
4. Invalidate dashboard and list data after mutations (architecture §15) — a stale privacy view is a correctness bug, not a cosmetic one.
5. Public service-directory content (Phase 2) may use standard CDN caching.
6. Request-scoped memoization is the safe default: dedupe identical reads within one render pass, discard afterward.

When in doubt: do not cache. A slightly slower page is recoverable; a cross-user cache leak is not.

## Suspense and streaming

- Use `loading.tsx` for route-level structural skeletons and `<Suspense>` boundaries around independently slow sections.
- Stream the shell and fast content first; let the score card or activity list arrive separately rather than blocking the page.
- Boundaries must wrap sections whose skeleton matches the final structure — a Suspense boundary with a mismatched fallback causes layout shift.
- Do not put a Suspense boundary around something that resolves in single-digit milliseconds; the flash costs more than the wait.
- Keep the number of streamed boundaries modest; each one adds coordination overhead and visual noise.

## Lazy loading

Lazy-load by default (frontend §22):

- **Charts** (Recharts) — heavy and below the fold on most views.
- **Assistant panel** — not needed until invoked.
- **Command palette** — load on first open or shortcut.
- **Request modal and draft editor** — only when the flow starts.
- Service icons — optimized, sized, with a neutral fallback for missing logos.

Rules: always reserve the container's height, always provide a skeleton, never lazy-load something in the critical render path.

## Bundle optimization

- Import narrowly: named imports from `lucide-react`, no barrel files that pull in a library's entirety.
- Avoid heavy animation libraries for transitions the design system specifies in CSS (design system §14).
- Keep validation schemas shared but tree-shakeable; do not import a whole feature's schema module into an unrelated client component.
- Watch for accidental client inclusion of server-only utilities — `server-only` markers prevent this at build time.
- Track bundle size in CI; a new dependency that meaningfully moves the number needs justification.

## Database performance

Detail lives in the `database` skill. Performance-critical points:

- **Keyset pagination** for activity, notifications, requests, and findings. Offset pagination degrades and can duplicate rows.
- **Index the filters the product uses**: `(user_id, status)`, `(user_id, occurred_at desc)`, partial index for unread notifications.
- **Never query, filter, sort, or index an encrypted column** — it cannot work, and a "searchable copy" defeats the control.
- **Avoid N+1** across repository calls: batch with a single join or an `in` lookup.
- **Decrypt lazily**: render a request list from statuses and service names; decrypt a body only when the editor opens.
- Verify plans with `explain analyze` against realistic row counts.
- Keep transactions short; enqueue follow-up work after commit.
- Set statement timeouts on user-facing paths so pathological queries fail fast.

## Background work and jobs

- Move anything slow, retryable, or fan-out off the request path: findings recompute, score recalculation, export generation, notification creation.
- Batch and bound job work so one large account cannot starve the queue.
- Track job duration and failure rates (ATL-096); a job whose duration is trending up is a capacity signal.
- Long AI operations must show progress and support cancellation rather than silently occupying a request.

## Monitoring

Capture (architecture §16): request ID, route and operation, status code, latency, error code, provider availability, AI schema failures, job status, RLS denial counts.

Never capture: names, addresses, phone numbers, emails, account identifiers, request bodies, prompts, draft bodies, tokens.

Practices:

- Watch p95 and p99, not averages — the slow tail is what users notice.
- Alert on budget regressions, error-rate increases, provider unavailability, and repeated job failure.
- Correlate by request ID; never by personal identifiers.
- Track AI latency separately, since it dominates the surfaces it touches and has a fallback path worth measuring.

## Common mistakes

- Caching an authenticated response in a shared cache — the highest-severity performance mistake possible here.
- Holding decrypted values in a module-level variable across requests.
- Fetching protected data from a Client Component for "instant" interactions.
- Several parallel dashboard fetches instead of the aggregated query.
- Offset pagination on a growing timeline.
- Decrypting a page of request bodies to render a list of statuses.
- Adding an index for a query nobody runs, or indexing an encrypted column.
- Measuring performance against ten seed rows.
- Lazy-loading something in the critical path, then wondering why LCP got worse.
- Suspense fallbacks that do not match final structure, causing layout shift.
- Optimizing render time by shipping more JavaScript.

## Decision framework

**Can I cache this?** Does it contain user data? Then no shared cache, ever. Non-sensitive and derived? Private and short-lived only. Unsure? Do not cache.

**Server or client fetch?** Server, unless the data is non-sensitive and genuinely needs to change without navigation.

**Suspense boundary here?** Only if this section is meaningfully slower than the page and its skeleton matches the final layout.

**Lazy-load this?** Yes if it is heavy and not in the initial viewport or initial interaction. No if it is in the critical path.

**Index or query change?** Read the plan first. Fix the query shape before adding an index; then index what remains.

**Is this fast enough?** Compare against the budget with realistic data. "Feels fine locally" is not a measurement.

## Review checklist

Full version in `checklists.md`. Fast pass:

- [ ] No user data in a shared cache; authenticated responses `private, no-store`
- [ ] No decrypted value cached or held across requests
- [ ] Protected reads happen server-side; dashboard uses the aggregated query
- [ ] Keyset pagination and supporting indexes for growing collections
- [ ] No encrypted-column query, filter, or index; decryption limited to displayed values
- [ ] Charts, assistant, palette, and modals lazy-loaded with reserved space
- [ ] Skeletons match final structure; no layout shift
- [ ] Budgets met with realistic data; plans verified via `explain analyze`
- [ ] Monitoring captures the allowlist only
