/**
 * Privacy-safe error report shaping (ATL-010).
 *
 * This module answers one question: given an unknown thrown value, what is the
 * *most* we are allowed to record about it?
 *
 * The answer is deliberately small. Architecture §16 lists what must never be
 * captured — names, addresses, emails, account identifiers, request body text,
 * AI prompts, draft recipients/subjects/bodies, personal field values, tokens.
 * An error message or stack trace can contain any of them: a validation error
 * quotes the offending value, a database error quotes the row, a fetch error
 * quotes the URL, and a stack frame quotes local variables in some runtimes.
 *
 * So the report is built by CONSTRUCTION, not by redaction: nothing is copied
 * from the error except fields that are structurally incapable of carrying user
 * data, and each of those is validated against an allowlisted shape before it is
 * accepted. There is no field on `ErrorReport` that can hold a message or stack,
 * which means no future caller can add one by accident.
 *
 * Transport is NOT here. `ATL-095` wires a monitoring provider, release tagging,
 * and request IDs onto this shape; `ATL-085` supplies the general allowlist
 * redaction utility for the rest of the logging surface. This module exists first
 * because boundaries cannot report anything until the shape is safe.
 */

import { NAV_ORDER } from "@/config/app";

/** Where the error was caught. Determines the recovery affordance, not the payload. */
export type ErrorBoundaryLevel = "global" | "route" | "component";

/**
 * The complete set of facts Atlas records about a client-side error.
 *
 * Note what is absent and cannot be added without changing this type: message,
 * stack, component stack, query string, headers, user ID, entity IDs.
 */
export interface ErrorReport {
  boundary: ErrorBoundaryLevel;
  /** Parameterised route template — never the concrete path. See `toRouteTemplate`. */
  route: string;
  /** Error constructor name, allowlisted by shape. Falls back to "Error". */
  errorName: string;
  /** Next.js server-generated digest: an opaque hash, safe to record and to show. */
  digest?: string;
  /** Developer-supplied static label for a component boundary. Never interpolated. */
  component?: string;
  occurredAt: string;
}

export interface BuildErrorReportInput {
  error: unknown;
  boundary: ErrorBoundaryLevel;
  /** `usePathname()` or equivalent. Redacted before it reaches the report. */
  pathname: string;
  component?: string;
  /** Injected so reports are deterministic under test (testing skill: no ambient time). */
  now?: Date;
}

/**
 * Path segments that are known route names rather than data.
 *
 * This is an ALLOWLIST, not a pattern denylist, and the direction matters. A
 * denylist ("replace anything that looks like a UUID") fails open: an unforeseen
 * identifier format — a slug containing a service name, an email in a path, a
 * base64 token — passes straight through into telemetry. An allowlist fails
 * closed: an unrecognised segment becomes `:id` and we lose a little debugging
 * precision, which is the correct side to err on for a privacy product.
 */
const KNOWN_ROUTE_SEGMENTS: ReadonlySet<string> = new Set<string>([
  ...NAV_ORDER,
  // Route groups and non-product surfaces.
  "auth",
  "sign-in",
  "sign-up",
  "verify",
  "callback",
  "onboarding",
  "design-tokens",
  "api",
  // Sub-routes that are structural, not user data.
  "new",
  "edit",
  "detail",
  "profile",
  "security",
  "privacy",
  "notifications",
  "data",
]);

/**
 * Reads a property from a value that arrived as `unknown` from a framework
 * boundary.
 *
 * The `try` is not defensive theatre. A rejected value can be any object, and a
 * property implemented as a throwing getter — or a Proxy that throws on `get` —
 * would raise from inside `componentDidCatch`, turning a handled error into an
 * unhandled one that re-enters the boundary. Report construction must be total.
 */
function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9]{1,64}$/;
const COMPONENT_LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9 .-]{0,63}$/;

/**
 * Converts a concrete pathname into a parameterised template.
 *
 * `/assets/8f14e45f-ceea-467a-9dbf-2a0e1b7e4a11` becomes `/assets/:id`.
 *
 * Query strings and fragments are dropped entirely rather than filtered:
 * security §19 forbids sensitive data in URLs, but telemetry should not depend on
 * that rule holding perfectly everywhere.
 */
export function toRouteTemplate(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/, 1)[0] ?? "";
  if (withoutQuery === "" || withoutQuery === "/") return "/";

  const segments = withoutQuery
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      KNOWN_ROUTE_SEGMENTS.has(segment.toLowerCase()) ? segment.toLowerCase() : ":id",
    );

  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

/**
 * Reads the error's constructor name if — and only if — it has the shape of an
 * identifier. A thrown string, a rejected object literal, or an `Error` whose
 * `name` was overwritten with interpolated text all fall back to "Error".
 */
export function toErrorName(error: unknown): string {
  const name = readProperty(error, "name");
  if (typeof name !== "string") return "Error";
  return ERROR_NAME_PATTERN.test(name) ? name : "Error";
}

/**
 * Next.js hashes server error messages into `digest` and sends only the hash to
 * the client — that is precisely the property we want, so it is the one thing we
 * both record and show the user. Validated anyway: this arrives as `unknown` from
 * a framework boundary, and a value we display must never be attacker-shaped.
 */
export function toDigest(error: unknown): string | undefined {
  const digest = readProperty(error, "digest");
  if (typeof digest !== "string") return undefined;
  return DIGEST_PATTERN.test(digest) ? digest : undefined;
}

/** Builds the complete, safe-by-construction report. Never throws. */
export function buildErrorReport({
  error,
  boundary,
  pathname,
  component,
  now = new Date(),
}: BuildErrorReportInput): ErrorReport {
  const digest = toDigest(error);
  const label = component && COMPONENT_LABEL_PATTERN.test(component) ? component : undefined;

  return {
    boundary,
    route: toRouteTemplate(pathname),
    errorName: toErrorName(error),
    ...(digest ? { digest } : {}),
    ...(label ? { component: label } : {}),
    occurredAt: now.toISOString(),
  };
}

/**
 * The reference a user can quote to support.
 *
 * Only the digest qualifies. When there is none (a purely client-side error), the
 * user gets no code rather than a fabricated one — inventing an identifier that
 * resolves to nothing wastes the user's time and ours.
 */
export function toUserReference(error: unknown): string | undefined {
  return toDigest(error);
}
