/**
 * Monitoring transport (ATL-095).
 *
 * Provider-agnostic on purpose. **OQ-09 leaves the error-monitoring vendor
 * undecided**, and CLAUDE.md forbids assuming answers to open questions, so this
 * ticket delivers everything the acceptance criteria actually require — redacted
 * payload shape, release and environment tagging, per-environment credentials,
 * fail-safe delivery — without committing Atlas to a vendor or adding an
 * unreviewed third-party SDK to a privacy product.
 *
 * Architecture §3 already establishes this pattern for the AI provider: "provider
 * abstraction to support future replacement". Selecting the vendor becomes a
 * config change plus one adapter, not a rewrite.
 *
 * Failure policy: **telemetry never degrades the product.** Every failure mode —
 * unreachable collector, timeout, non-2xx, malformed URL, exception inside the
 * transport — is swallowed and reported through the return value. An error
 * boundary that threw while reporting an error would loop.
 */

import type { MonitoringEvent } from "./monitoring-event";

export type DeliveryStatus = "delivered" | "dropped" | "failed" | "disabled";

export interface DeliveryResult {
  status: DeliveryStatus;
  /** Populated on "dropped" — the keys redaction removed. Never contains values. */
  droppedKeys?: string[];
  redactedKeys?: string[];
}

export interface MonitoringTransport {
  send(event: MonitoringEvent): Promise<DeliveryResult>;
}

export interface HttpTransportConfig {
  /** Collector endpoint for THIS environment. Never shared across environments. */
  endpoint: string;
  /** Credential for this environment's project. Sent as a header, never in the URL. */
  apiKey?: string;
  /** Telemetry must not hold a request open. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Used wherever monitoring is unconfigured — local development, tests, CI. */
export const nullTransport: MonitoringTransport = {
  send: () => Promise.resolve({ status: "disabled" }),
};

/**
 * Posts events to a collector over HTTPS.
 *
 * The credential travels in a header rather than the URL: security §19 forbids
 * sensitive data in URLs, and URLs are the part most likely to end up in a proxy
 * log or an error message.
 */
export function createHttpTransport(config: HttpTransportConfig): MonitoringTransport {
  const { endpoint, apiKey, timeoutMs = 2000, fetchImpl } = config;

  return {
    async send(event: MonitoringEvent): Promise<DeliveryResult> {
      const doFetch = fetchImpl ?? globalThis.fetch;
      if (typeof doFetch !== "function") return { status: "failed" };

      // `AbortSignal.timeout` is not available in every runtime Atlas targets, so
      // the controller is created explicitly.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { "x-atlas-monitoring-key": apiKey } : {}),
          },
          body: JSON.stringify(event),
          signal: controller.signal,
          // Telemetry must never carry ambient credentials to a third party.
          credentials: "omit",
          cache: "no-store",
        });

        return { status: response.ok ? "delivered" : "failed" };
      } catch {
        // Network error, timeout, abort, malformed URL — all identical from the
        // product's point of view: the user is unaffected and nothing is retried.
        // A retry queue would risk unbounded memory growth during an outage,
        // which is a worse failure than a lost error report.
        return { status: "failed" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
