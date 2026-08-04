/**
 * Browser-side monitoring sink (ATL-095).
 *
 * The ATL-010 sink registry is module-level, so the server registration in
 * `instrumentation.ts` does not apply to the client bundle — the browser needs its
 * own. This one posts the already-redacted `ErrorReport` to the first-party ingest
 * route, which attaches release, environment, and a request ID before forwarding.
 *
 * Nothing about the boundary's behaviour changes: `ErrorSink` stays synchronous,
 * so the recovery UI never waits on the network.
 */

import { setErrorSink, type ErrorSink } from "./error-reporter";

export const MONITORING_INGEST_PATH = "/api/monitoring/error";

export interface ClientMonitoringOptions {
  ingestPath?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Installs the browser sink. Returns a teardown function.
 *
 * `keepalive` lets the report survive the page unload that often follows a
 * navigation away from a broken view — without it, the errors most worth seeing
 * are the ones most likely to be cancelled in flight.
 */
export function initClientErrorMonitoring(options: ClientMonitoringOptions = {}): () => void {
  const { ingestPath = MONITORING_INGEST_PATH, fetchImpl } = options;

  const sink: ErrorSink = (report) => {
    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== "function") return;

    try {
      void doFetch(ingestPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
        keepalive: true,
        cache: "no-store",
      }).catch(() => {
        // Telemetry never degrades the product: a failed report is dropped, not
        // retried and not surfaced. The user is already looking at a recovery UI.
      });
    } catch {
      // `fetch` throwing synchronously (malformed input, blocked by policy) must
      // not propagate into `componentDidCatch`.
    }
  };

  setErrorSink(sink);
  return () => setErrorSink(null);
}
