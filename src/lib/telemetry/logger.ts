/**
 * The redaction-aware logger (ATL-085).
 *
 * The `no-console` rule in `eslint.config.mjs` has pointed at "the
 * redaction-aware logger" since ATL-001. This is that logger, and it is the only
 * sanctioned way for application code to emit a log line.
 *
 * ## Fields are named, never free-form
 *
 * The allowlist below is architecture §16's "Capture" list, transcribed. Its
 * companion "Never capture" list — names, addresses, phone numbers, emails,
 * account identifiers, request bodies, AI prompts, draft recipients and
 * subjects and bodies, personal field values, access tokens — is enforced
 * structurally: none of those has a field to travel in, so omitting them is not
 * a discipline anyone has to remember.
 *
 * There is deliberately **no `message` parameter**. A free-text message is the
 * single most reliable way personal data reaches a log, because interpolation is
 * so natural (`Failed to load asset for ${email}`) that it does not read as a
 * mistake. `event` takes a fixed, code-shaped label instead, and anything
 * variable must be an allowlisted field.
 *
 * ## Failure policy
 *
 * Logging never throws. A logging call sits on a request path, and an
 * observability concern must not be able to fail a user operation — the same
 * rule the monitoring transport follows.
 */

import { redact, scalar, type FieldPolicy } from "./redaction";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Fields a caller may supply. Every one is optional; each maps to an entry in
 * architecture §16's capture list.
 */
export interface LogFields {
  /** Correlation identifier. Never a user or session identifier. */
  requestId?: string;
  /** Parameterised route template — `/assets/:id`, never a concrete path. */
  route?: string;
  /** Server operation name, e.g. `assets.create`. */
  operation?: string;
  status?: number;
  latencyMs?: number;
  /** Typed application error code, e.g. `RATE_LIMITED`. Never a message. */
  errorCode?: string;
  /** External dependency name, e.g. `ai`, `email`. */
  provider?: string;
  providerAvailable?: boolean;
  /** Set when a structured AI response failed schema validation. */
  aiSchemaFailure?: boolean;
  jobName?: string;
  jobStatus?: "started" | "succeeded" | "failed";
  /** Count of RLS denials observed. A count carries no identity. */
  rlsDenialCount?: number;
  /**
   * Generic magnitude for the event — items processed, keys dropped, faults
   * found. A bare count carries no identity, which is what makes it the safe way
   * to report "something was filtered" without reporting what.
   */
  count?: number;
  /** Records examined by a job or batch. */
  recordCount?: number;
  /**
   * A CSP directive name, e.g. `script-src` (ATL-087).
   *
   * A fixed vocabulary defined by the CSP specification, so it carries no
   * user-controlled content — which is what makes it safe to log when the rest
   * of a violation report (document URL, blocked URL) is not.
   */
  directive?: string;

  /**
   * Error-shape fields, mirroring `ErrorReport` (ATL-010).
   *
   * Present so the error-reporting seam can log through this module rather than
   * keeping a second console call of its own. Each is already safe by
   * construction there — `digest` is a hash of a server message, never the
   * message; `component` is a static label — and each is shape-checked again
   * here, because a field's safety should not depend on where it came from.
   */
  boundary?: "global" | "route" | "component";
  errorName?: string;
  component?: string;
  digest?: string;
}

/** A fixed label: lowercase dotted segments, e.g. `asset.create.failed`. */
const EVENT_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** Route template, matching what `toRouteTemplate` produces. */
const ROUTE_TEMPLATE_PATTERN = /^\/$|^(?:\/(?::id|[a-z0-9][a-z0-9-]{0,63}))+$/;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOB_STATUSES: ReadonlySet<string> = new Set(["started", "succeeded", "failed"]);
const BOUNDARIES: ReadonlySet<string> = new Set(["global", "route", "component"]);

const isInt = (min: number, max: number) => (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const matches = (pattern: RegExp) => (v: unknown) => typeof v === "string" && pattern.test(v);
const isBoolean = (v: unknown) => typeof v === "boolean";

/**
 * The wire policy.
 *
 * Shape validators are supplied wherever the shape is knowable, because a
 * validator is a far stronger guarantee than the pattern scrub that backs it up.
 * `route` is the clearest case: enumerating the template grammar rejects
 * `/requests/dana@example.com` outright, rather than relying on the email
 * scrubber to catch it after the fact.
 */
export const LOG_FIELD_POLICY: FieldPolicy = {
  level: scalar((v) => typeof v === "string" && (LEVELS as readonly string[]).includes(v)),
  event: scalar(matches(EVENT_PATTERN)),
  occurredAt: scalar(matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/)),
  requestId: scalar(matches(IDENTIFIER)),
  route: scalar((v) => typeof v === "string" && v.length <= 256 && ROUTE_TEMPLATE_PATTERN.test(v)),
  operation: scalar(matches(/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/)),
  status: scalar(isInt(100, 599)),
  latencyMs: scalar(isInt(0, 3_600_000)),
  errorCode: scalar(matches(/^[A-Z][A-Z0-9_]{0,63}$/)),
  provider: scalar(matches(/^[a-z][a-z0-9-]{0,31}$/)),
  providerAvailable: scalar(isBoolean),
  aiSchemaFailure: scalar(isBoolean),
  jobName: scalar(matches(/^[a-z][a-z0-9-]{0,63}$/)),
  jobStatus: scalar((v) => typeof v === "string" && JOB_STATUSES.has(v)),
  rlsDenialCount: scalar(isInt(0, 1_000_000)),
  count: scalar(isInt(0, 1_000_000_000)),
  recordCount: scalar(isInt(0, 1_000_000_000)),
  directive: scalar(matches(/^[a-z][a-z-]{0,31}$/)),
  boundary: scalar((v) => typeof v === "string" && BOUNDARIES.has(v)),
  errorName: scalar(matches(/^[A-Za-z][A-Za-z0-9]{0,63}$/)),
  component: scalar(matches(/^[A-Za-z][A-Za-z0-9 .-]{0,63}$/)),
  digest: scalar(matches(/^[A-Za-z0-9]{1,64}$/)),
};

/** A log line after redaction. Only allowlisted keys are present. */
export interface LogRecord extends LogFields {
  level: LogLevel;
  event: string;
  occurredAt: string;
}

export interface LogOutcome {
  record: LogRecord;
  droppedKeys: string[];
  redactedKeys: string[];
}

/** Where redacted records go. Swappable so tests assert without touching stdout. */
export type LogSink = (record: LogRecord) => void;

/**
 * The default sink.
 *
 * The single place in the application permitted to call `console`, and the
 * reason the ESLint exemption is scoped to this file alone. Structured JSON on
 * one line is what every log aggregator expects, and `console.error` for
 * warn/error keeps severity routing intact on platforms that split streams.
 */
export const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  // eslint-disable-next-line no-console -- the sanctioned sink; see module docstring
  if (record.level === "error" || record.level === "warn") console.error(line);
  // eslint-disable-next-line no-console -- the sanctioned sink; see module docstring
  else console.log(line);
};

let sink: LogSink = consoleSink;

/** Installs a sink. Returns the previous one so callers can restore it. */
export function setLogSink(next: LogSink | null): LogSink {
  const previous = sink;
  sink = next ?? consoleSink;
  return previous;
}

/**
 * Builds a redacted record and hands it to the sink.
 *
 * Returns the outcome — including the drop and redaction counts — so callers and
 * tests can assert that redaction fired, rather than inferring it from absence.
 * The counts are the acceptance criterion's "unknown keys are dropped **and
 * counted**": they are what surfaces a caller quietly trying to log something
 * new.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): LogOutcome {
  const candidate = {
    ...fields,
    level,
    event,
    occurredAt: new Date().toISOString(),
  };

  const { value, droppedKeys, redactedKeys } = redact<LogRecord>(candidate, LOG_FIELD_POLICY);

  try {
    sink(value);
  } catch {
    // A failing sink must not escalate into a failed request.
  }

  return { record: value, droppedKeys, redactedKeys };
}

export const logger = {
  debug: (event: string, fields?: LogFields) => log("debug", event, fields),
  info: (event: string, fields?: LogFields) => log("info", event, fields),
  warn: (event: string, fields?: LogFields) => log("warn", event, fields),
  error: (event: string, fields?: LogFields) => log("error", event, fields),
};
