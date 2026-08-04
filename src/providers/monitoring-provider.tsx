"use client";

import { useEffect } from "react";
import { initClientErrorMonitoring } from "@/lib/telemetry/monitoring-client";

/**
 * Registers the browser error-monitoring sink once per page load (ATL-095).
 *
 * Renders nothing and holds no state — it exists because the ATL-010 sink
 * registry is module-level and the client bundle needs its own registration.
 *
 * An effect rather than a module-level call: registration must not run during
 * server rendering of this module, and the teardown keeps hot reload from
 * stacking sinks in development.
 */
export function MonitoringProvider() {
  useEffect(() => initClientErrorMonitoring(), []);
  return null;
}
