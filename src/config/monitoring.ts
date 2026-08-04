import "server-only";
import { env } from "./env";
import { createHttpTransport } from "@/lib/telemetry/monitoring-transport";
import {
  resolveMonitoringConfig,
  resolveRelease,
  type MonitoringConfig,
} from "@/lib/telemetry/monitoring";

/**
 * Server-side monitoring configuration (ATL-095).
 *
 * Wiring only — every decision it makes lives in `@/lib/telemetry`, which is pure
 * and unit-tested. This module is server-only because it reads the collector
 * credential; the browser never imports it, reporting through the first-party
 * ingest route instead.
 */
export const monitoringConfig: MonitoringConfig = resolveMonitoringConfig({
  endpoint: env.ATLAS_MONITORING_ENDPOINT,
  release: resolveRelease(process.env),
  environment: env.ATLAS_ENV,
  createTransport: (endpoint) =>
    createHttpTransport({
      endpoint,
      ...(env.ATLAS_MONITORING_KEY ? { apiKey: env.ATLAS_MONITORING_KEY } : {}),
    }),
});
