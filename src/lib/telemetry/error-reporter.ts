/**
 * Error reporting seam (ATL-010).
 *
 * Boundaries call `reportError`. Where that report *goes* is deliberately not
 * decided here — ATL-095 registers a monitoring sink with release tagging, request
 * IDs, and per-environment credentials. Until then the default sink is inert, and
 * that is the correct MVP behaviour: shipping boundaries that silently drop
 * reports is honest, shipping boundaries that quietly POST error data to a
 * third party before the redaction story is signed off is not.
 *
 * Two invariants hold regardless of which sink is installed:
 *
 *  1. Sinks receive an `ErrorReport` and nothing else. The raw error never leaves
 *     the boundary, so a sink physically cannot serialise a message or stack.
 *  2. Reporting never throws. An exception raised while handling an exception
 *     inside an error boundary re-enters the boundary and loops.
 */

import { buildErrorReport, type BuildErrorReportInput, type ErrorReport } from "./error-report";
import { logger } from "./logger";

export type ErrorSink = (report: ErrorReport) => void;

let sink: ErrorSink | null = null;

/**
 * Installs the process-wide sink. ATL-095 owns the production call; tests use it
 * to assert on the payload shape.
 *
 * Returns the previous sink so a test can restore it without reaching into module
 * state.
 */
export function setErrorSink(next: ErrorSink | null): ErrorSink | null {
  const previous = sink;
  sink = next;
  return previous;
}

/** Test helper: removes any installed sink. */
export function resetErrorSink(): void {
  sink = null;
}

/**
 * Shapes the error safely and hands the report to the installed sink.
 *
 * Returns the report so boundaries can render the reference code from the same
 * value that was reported, rather than deriving it a second time.
 */
export function reportError(input: BuildErrorReportInput): ErrorReport {
  const report = buildErrorReport(input);

  try {
    if (sink) {
      sink(report);
    } else if (process.env.NODE_ENV === "development") {
      // Development visibility only, and it emits the REDACTED report — not the
      // error. The raw error is already in the browser console via React's own
      // logging, where it is a local debugging artefact rather than telemetry.
      //
      // Routed through the logger (ATL-085) rather than `console` directly: with
      // no sink installed this is a logging path like any other, and a second
      // console call here would be exactly the bypass the central utility exists
      // to prevent.
      logger.error("error-boundary.unreported", {
        boundary: report.boundary,
        route: report.route,
        errorName: report.errorName,
        ...(report.component ? { component: report.component } : {}),
        ...(report.digest ? { digest: report.digest } : {}),
      });
    }
  } catch {
    // A failing sink must not escalate a handled error into an unhandled one.
  }

  return report;
}
