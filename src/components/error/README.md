# Error boundaries (ATL-010)

Three boundaries, each catching what the one below it cannot.

| Boundary                    | Catches                                                     | Recovery                             |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| `app/global-error.tsx`      | Failures in the root layout                                 | Reload — nothing above it survives   |
| `app/error.tsx`             | Root-segment routes and the `(product)` layout itself       | `reset()` + link home                |
| `app/(product)/error.tsx`   | Any product view, rendered inside the shell                 | `reset()` + link to Overview         |
| `<ErrorBoundary>`           | A single component subtree                                  | Local retry; the page keeps working  |

`(product)/error.tsx` sits inside `ProductLayout` deliberately: a boundary catches
only what is below it, so the sidebar and top bar stay mounted and the user keeps
full navigation while one view is broken.

## What a report may contain

`src/lib/telemetry/error-report.ts` builds reports **by construction, not by
redaction**. `ErrorReport` has no field capable of holding a message, stack, or
component stack, so no future caller can add one by accident. The four things
recorded are the boundary level, a parameterised route template, an
allowlist-shaped error name, and Next.js's `digest` — a hash, not text.

Route redaction uses an allowlist of known segments. An unrecognised segment
becomes `:id`, so an unforeseen identifier format costs debugging precision rather
than leaking. Query strings are dropped entirely.

The user-visible reference code is the digest and nothing else. When there is no
digest, no code is shown — a fabricated identifier that resolves to nothing wastes
the user's time.

## Using the component boundary

```tsx
<ErrorBoundary component="PrivacyScoreCard" resetKeys={[assetId]}>
  <PrivacyScoreCard />
</ErrorBoundary>
```

`component` must be a static label. It is validated against an identifier shape
before it is recorded — never interpolate user data into it. `resetKeys` lets the
panel recover on its own when the input that failed is replaced.

## Transport (ATL-095)

The sink is now wired. Two registrations, because the sink registry is
module-level and the server and client bundles are separate module instances:

| Where | Registered by | Path to the collector |
| --- | --- | --- |
| Server | `src/instrumentation.ts` at boot | Direct, using the server-only credential |
| Browser | `MonitoringProvider` in `src/providers` | `POST /api/monitoring/error`, then the server forwards |

The browser never talks to the collector directly. A `NEXT_PUBLIC` monitoring key
would be readable by anyone loading the page, so client events go through a
first-party route that adds release, environment, and a server-minted request ID.

The vendor is deliberately unchosen — **OQ-09** leaves error-monitoring provider
selection open, so the transport is an interface (`MonitoringTransport`) and
selecting a provider is a config change plus one adapter.

Redaction runs a second time, immediately before the network call, in
`redactMonitoringEvent`. Not redundant: the envelope adds fields the boundary never
saw (request ID from a proxy header, release from the build), and those are the
plausible ways restricted data enters a payload that was previously safe.

General log redaction across the rest of the logging surface is still **ATL-085**;
`redactMonitoringEvent` should delegate to it when it lands.
