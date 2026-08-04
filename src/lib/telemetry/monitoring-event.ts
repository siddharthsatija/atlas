/**
 * Monitoring event envelope and the final redaction pass (ATL-095).
 *
 * ATL-010 produces an `ErrorReport` that is safe *by construction* — it has no
 * field capable of holding a message or stack. This module wraps that report with
 * the deployment metadata architecture §16 asks monitoring to capture (request ID,
 * route, status, error code, release), and then runs an **independent
 * allowlist-and-shape pass immediately before transport**.
 *
 * The second pass is not redundant. The envelope adds fields from sources the
 * boundary never saw — a request ID from a proxy header, an error code chosen by a
 * future service, a release string from the build environment. Those are the
 * plausible ways restricted data enters a payload that was previously safe, and
 * they enter *after* the point ATL-010 guarantees. Redaction therefore runs where
 * the data actually leaves the process, not where it was first shaped.
 *
 * Relationship to ATL-085: that ticket delivers the general allowlist redaction
 * utility used by every logging path. This module is the narrow, monitoring-shaped
 * instance of the same rule, built now because ATL-095 cannot ship without it.
 * When ATL-085 lands, `redactMonitoringEvent` should delegate to it rather than
 * keeping a second pattern list.
 */

import type { ErrorReport } from "./error-report";

/** Bumped when the wire shape changes, so a collector can reject what it cannot parse. */
export const MONITORING_SCHEMA_VERSION = 1;

export type AtlasEnvironment = "local" | "preview" | "staging" | "production";

/**
 * The complete wire payload. Every field is either a fixed vocabulary, a validated
 * shape, or an opaque hash — there is no free-text field, by design.
 */
export interface MonitoringEvent {
  schemaVersion: number;
  /** Which boundary caught it (ATL-010). */
  boundary: ErrorReport["boundary"];
  /** Parameterised route template — `/assets/:id`, never a concrete path. */
  route: string;
  errorName: string;
  occurredAt: string;
  /** Next.js digest: a hash of the server message, not the message. */
  digest?: string;
  /** Static component label from a component boundary. */
  component?: string;
  /** Build identifier. Architecture §16 "release tagging". */
  release: string;
  environment: AtlasEnvironment;
  /** Correlation identifier. Architecture §16; never a personal identifier. */
  requestId?: string;
  /** HTTP status where one exists. Client render failures have none. */
  status?: number;
  /** Typed application error code, e.g. `RATE_LIMITED`. Never a message. */
  errorCode?: string;
}

export interface BuildMonitoringEventInput {
  report: ErrorReport;
  release: string;
  environment: AtlasEnvironment;
  requestId?: string;
  status?: number;
  errorCode?: string;
}

const ENVIRONMENTS: ReadonlySet<string> = new Set(["local", "preview", "staging", "production"]);
const BOUNDARIES: ReadonlySet<string> = new Set(["global", "route", "component"]);

/**
 * Every key permitted on the wire, each paired with the shape its value must have.
 *
 * An allowlist rather than a denylist: a denylist has to anticipate the field
 * someone adds next year, and the failure mode of guessing wrong is a permanent
 * data leak into a third-party system that is difficult to unwind.
 *
 * Pairing each key with a validator is what makes the envelope safe rather than
 * merely tidy. A key surviving the allowlist is not enough — `requestId` is an
 * allowed key, but a proxy echoing an email into `x-request-id` must still be
 * caught. Because every shape here is strict, **a value that passes cannot also be
 * an email, phone number, token, or free-text message**: none of them fit.
 */
const FIELD_VALIDATORS: Readonly<Record<string, (value: unknown) => boolean>> = {
  schemaVersion: (v) => typeof v === "number" && Number.isInteger(v) && v > 0,
  boundary: (v) => typeof v === "string" && BOUNDARIES.has(v),
  // A template, never a concrete path.
  //
  // Checked positively against the shape `toRouteTemplate` actually produces —
  // "/" or a series of segments that are each `:id` or a lowercase slug — rather
  // than negatively against things that look like identifiers. An earlier version
  // only rejected long alphanumeric runs, and `/requests/dana@example.com`
  // sailed through it: no run was long enough. Enumerating what is allowed is the
  // only version of this check that holds against inputs nobody predicted.
  route: (v) =>
    typeof v === "string" &&
    v.length <= 256 &&
    ROUTE_TEMPLATE_PATTERN.test(v) &&
    // A lowercase-hex or long slug segment is shape-valid but is still an opaque
    // identifier, so it is refused as well.
    !/[a-z0-9]{16,}/.test(v),
  errorName: (v) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(v),
  occurredAt: (v) => typeof v === "string" && ISO_INSTANT_PATTERN.test(v),
  digest: (v) => typeof v === "string" && /^[A-Za-z0-9]{1,64}$/.test(v),
  component: (v) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9 .-]{0,63}$/.test(v),
  release: (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v),
  environment: (v) => typeof v === "string" && ENVIRONMENTS.has(v),
  requestId: (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),
  status: (v) => typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599,
  errorCode: (v) => typeof v === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(v),
};

/**
 * Strict ISO-8601 instant.
 *
 * Worth its own constant because of a bug this file already had: a generic
 * "looks like a phone number" pattern (`\+?\d[\d\s().-]{7,}\d`) matches
 * `2026-07-30T09:15:00.000Z`, which silently stripped `occurredAt` from every
 * event. Heuristic pattern-matching over structured fields produces exactly that
 * class of failure, which is why validation here is by shape rather than by
 * resemblance.
 */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** Root, or one or more segments that are each `:id` or a lowercase slug. */
const ROUTE_TEMPLATE_PATTERN = /^\/$|^(?:\/(?::id|[a-z0-9][a-z0-9-]{0,63}))+$/;

/**
 * Builds the wire envelope from an ATL-010 report plus deployment metadata.
 *
 * Optional fields are omitted rather than set to `undefined` so the serialised
 * payload contains only what was actually known.
 */
export function buildMonitoringEvent({
  report,
  release,
  environment,
  requestId,
  status,
  errorCode,
}: BuildMonitoringEventInput): MonitoringEvent {
  return {
    schemaVersion: MONITORING_SCHEMA_VERSION,
    boundary: report.boundary,
    route: report.route,
    errorName: report.errorName,
    occurredAt: report.occurredAt,
    ...(report.digest ? { digest: report.digest } : {}),
    ...(report.component ? { component: report.component } : {}),
    release,
    environment,
    ...(requestId ? { requestId } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

export interface RedactionOutcome {
  event: MonitoringEvent;
  /** Keys removed because they are not on the allowlist. */
  droppedKeys: string[];
  /** Keys removed because the value did not match the shape the field promises. */
  redactedKeys: string[];
}

/**
 * The last thing that runs before an event reaches the network.
 *
 * Returns a new object containing only allowlisted keys whose values pass both
 * their shape check and the restricted-pattern scan. Counts are returned rather
 * than logged so the caller decides what to do with them — and so tests can assert
 * that redaction actually fired rather than inferring it from absence.
 */
export function redactMonitoringEvent(candidate: unknown): RedactionOutcome {
  const droppedKeys: string[] = [];
  const redactedKeys: string[] = [];

  const source: Record<string, unknown> =
    typeof candidate === "object" && candidate !== null
      ? (candidate as Record<string, unknown>)
      : {};

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    const validator = FIELD_VALIDATORS[key];

    // Not an allowlisted key — dropped whatever its value.
    if (!validator) {
      droppedKeys.push(key);
      continue;
    }

    // Allowlisted, but the value does not have the shape the field promises.
    // Removed rather than coerced: a value we cannot recognise is one we cannot
    // vouch for, and a half-repaired identifier is still a correlation handle.
    if (!validator(value)) {
      redactedKeys.push(key);
      continue;
    }

    out[key] = value;
  }

  return { event: out as unknown as MonitoringEvent, droppedKeys, redactedKeys };
}
