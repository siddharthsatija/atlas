/**
 * Server startup hook.
 *
 * Next.js calls `register()` once when a server instance starts. Importing the
 * environment module here is what makes configuration validation (ATL-001) and
 * environment isolation (ATL-003) genuinely *boot-time* checks: without this, both
 * only run when some other server module happens to import `env`, so a
 * misconfigured deployment could start successfully and fail later.
 *
 * Fail-fast is the intent — a bad environment must not serve traffic
 * (architecture §18, security §9).
 */
export async function register(): Promise<void> {
  // The env module is Node-only (it imports `server-only` and reads process.env).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./config/env");

    // Error monitoring (ATL-095). Registered at boot so server-side errors are
    // reported from the first request rather than from whenever some module
    // happens to install a sink — the same reasoning that put the environment
    // check here. Configuration is validated above, so this cannot fail on a
    // malformed endpoint.
    const [{ initErrorMonitoring }, { monitoringConfig }] = await Promise.all([
      import("./lib/telemetry/monitoring"),
      import("./config/monitoring"),
    ]);
    initErrorMonitoring(monitoringConfig);
  }
}
