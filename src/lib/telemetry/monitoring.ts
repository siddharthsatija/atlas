/**
 * Monitoring wiring (ATL-095).
 *
 * Connects the ATL-010 reporting seam (`setErrorSink`) to a transport, inserting
 * deployment metadata and the final redaction pass in between.
 *
 * Configuration is **injected, never read from `process.env` here**. `env.ts` is
 * `server-only`, and importing it would make this module — and therefore the
 * telemetry package — unusable from the client and awkward to unit test. The
 * caller that knows the environment (`instrumentation.ts` on the server, the API
 * route for client-originated events) supplies it.
 */

import { setErrorSink, type ErrorSink } from "./error-reporter";
import type { ErrorReport } from "./error-report";
import {
  buildMonitoringEvent,
  redactMonitoringEvent,
  type AtlasEnvironment,
  type MonitoringEvent,
} from "./monitoring-event";
import {
  nullTransport,
  type DeliveryResult,
  type MonitoringTransport,
} from "./monitoring-transport";

export interface MonitoringConfig {
  transport: MonitoringTransport;
  release: string;
  environment: AtlasEnvironment;
}

/**
 * Release identifier for tagging (architecture §16).
 *
 * Explicit `ATLAS_RELEASE` wins; otherwise the deployment platform's commit SHA,
 * shortened. `"unknown"` is returned rather than omitting the field, so an
 * untagged deploy is visible in the data instead of being indistinguishable from
 * a tagged one.
 *
 * Pure and source-injected so it can be unit-tested — it lives here rather than
 * beside the server-only env module for exactly that reason. The platform value is
 * shape-checked because it arrives unvalidated: `redactMonitoringEvent` would drop
 * a malformed release anyway, but a bad value caught here has an obvious cause.
 */
export function resolveRelease(source: Record<string, string | undefined>): string {
  const explicit = source.ATLAS_RELEASE?.trim();
  if (explicit) return explicit;

  const commit = source.VERCEL_GIT_COMMIT_SHA?.trim() ?? source.GITHUB_SHA?.trim();
  if (commit && /^[A-Fa-f0-9]{7,40}$/.test(commit)) return commit.slice(0, 12);

  return "unknown";
}

/**
 * Redacts and delivers a single event.
 *
 * Exported so both entry points — the server sink and the client-ingest route —
 * go through the same code path. Two implementations of "redact then send" would
 * be two places for the rule to drift.
 */
export async function captureMonitoringEvent(
  config: MonitoringConfig,
  input: {
    report: ErrorReport;
    requestId?: string;
    status?: number;
    errorCode?: string;
  },
): Promise<DeliveryResult> {
  const candidate: MonitoringEvent = buildMonitoringEvent({
    report: input.report,
    release: config.release,
    environment: config.environment,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });

  // Redaction runs here — after every contributor has added its fields, and
  // immediately before the only call that leaves the process.
  const { event, droppedKeys, redactedKeys } = redactMonitoringEvent(candidate);

  const result = await config.transport.send(event);

  return droppedKeys.length > 0 || redactedKeys.length > 0
    ? { ...result, droppedKeys, redactedKeys }
    : result;
}

/**
 * Installs the monitoring sink. Returns a teardown function.
 *
 * The sink is synchronous (ATL-010's `ErrorSink` returns `void`) because an error
 * boundary must not await telemetry before rendering a recovery UI. Delivery is
 * therefore fire-and-forget, with the rejection handler present so a transport
 * failure can never surface as an unhandled rejection.
 */
export function initErrorMonitoring(config: MonitoringConfig): () => void {
  const sink: ErrorSink = (report) => {
    void captureMonitoringEvent(config, { report }).catch(() => {
      // `captureMonitoringEvent` already swallows transport failures; this is the
      // belt-and-braces guard for anything thrown during event construction.
    });
  };

  setErrorSink(sink);
  return () => setErrorSink(null);
}

/**
 * Builds a config from already-validated values.
 *
 * When no endpoint is configured the transport is `nullTransport` rather than a
 * broken HTTP client: local development and CI have no collector, and monitoring
 * being absent must never be an error condition at runtime. Whether a hosted
 * environment is *allowed* to be unconfigured is an environment-isolation
 * question, enforced at boot in `src/config/environment-isolation.ts` — not here.
 */
export function resolveMonitoringConfig(input: {
  endpoint?: string | undefined;
  release: string;
  environment: AtlasEnvironment;
  createTransport: (endpoint: string) => MonitoringTransport;
}): MonitoringConfig {
  return {
    transport: input.endpoint ? input.createTransport(input.endpoint) : nullTransport,
    release: input.release,
    environment: input.environment,
  };
}
