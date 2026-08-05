import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { captureMonitoringEvent } from "@/lib/telemetry/monitoring";
import { monitoringConfig } from "@/config/monitoring";
import {
  RATE_LIMIT_POLICIES,
  RateLimiter,
  clientAddressFrom,
} from "@/server/rate-limit/rate-limit";

/**
 * First-party ingest for client-originated error reports (ATL-095).
 *
 * ROUTE-HANDLER JUSTIFICATION (required by src/app/api/README.md): the browser
 * cannot deliver to the collector directly without shipping the collector
 * credential in the client bundle. A NEXT_PUBLIC monitoring key would be readable
 * by anyone loading the page, so the browser reports here and the server forwards
 * using the server-only credential. A server action is not usable: this is called
 * from an error boundary, where the React tree may already be unmountable.
 *
 * The indirection buys two things beyond secret hygiene:
 *   - Atlas controls the redaction checkpoint. Every client event passes through
 *     `captureMonitoringEvent`, the same path server errors take.
 *   - The request ID is minted server-side, so correlation does not depend on a
 *     value the client could shape.
 *
 * Unauthenticated by necessity — errors during sign-in and on public pages are
 * exactly the ones worth seeing. That makes strict validation and a small body cap
 * the only defences, so both are enforced below. Rate limiting is **ATL-086**; it
 * applies here when it lands.
 */

export const runtime = "nodejs";
/** Never cached, never prerendered: this is a write path. */
export const dynamic = "force-dynamic";

/** Generous for a legitimate event (~300 bytes), far too small to be a useful channel. */
const MAX_BODY_BYTES = 2_048;

/**
 * Accepts only the ATL-010 report fields. Everything else — including anything a
 * modified client might add — is rejected by `.strict()` before it can reach the
 * envelope builder.
 */
const reportSchema = z
  .object({
    boundary: z.enum(["global", "route", "component"]),
    route: z.string().max(256),
    errorName: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
    occurredAt: z.iso.datetime(),
    digest: z
      .string()
      .regex(/^[A-Za-z0-9]{1,64}$/)
      .optional(),
    component: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9 .-]{0,63}$/)
      .optional(),
  })
  .strict();

/**
 * Correlation ID (architecture §16). Prefers the platform's request identifier so
 * an event lines up with the platform's own logs; otherwise a fresh UUID.
 *
 * Client-supplied values are deliberately ignored — a correlation ID the caller
 * controls is a free-text field wearing a disguise.
 */
function resolveRequestId(request: NextRequest): string {
  const platformId = request.headers.get("x-vercel-id") ?? request.headers.get("x-request-id");
  if (platformId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(platformId)) return platformId;
  return crypto.randomUUID();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = resolveRequestId(request);

  // Always 204, whatever happens below. A telemetry endpoint that reported *why*
  // it rejected something would be a probing oracle, and the client has no useful
  // response to a failed error report in any case.
  const accepted = new NextResponse(null, { status: 204 });

  try {
    /**
     * Rate limit the ingest (ATL-086).
     *
     * An over-limit caller is dropped silently and still receives 204, rather
     * than the 429 envelope other surfaces return. That is deliberate and
     * matches this route's existing rule above: a telemetry endpoint that
     * reported *why* it rejected something would be a probing oracle, and a 429
     * is exactly such a report. The client has no useful response to a refused
     * error report either way.
     *
     * Keyed on the caller's address only. There is no session here — the route
     * exists so browser-side errors can be reported before or without one.
     */
    const address = clientAddressFrom(request.headers);
    if (address) {
      const limit = await RateLimiter.create().check(RATE_LIMIT_POLICIES.monitoringIngest, [
        { kind: "ip", value: address },
      ]);
      if (!limit.allowed) return accepted;
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_BODY_BYTES) return accepted;

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return accepted;

    const parsed = reportSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return accepted;

    const { digest, component, ...required } = parsed.data;

    await captureMonitoringEvent(monitoringConfig, {
      // Optional fields are spread conditionally rather than passed as
      // `undefined`: `exactOptionalPropertyTypes` distinguishes "absent" from
      // "present and undefined", and the envelope must not carry empty keys.
      report: {
        ...required,
        ...(digest ? { digest } : {}),
        ...(component ? { component } : {}),
      },
      requestId,
      // Client render failures have no HTTP status, so none is asserted. Inventing
      // one (500) would make dashboards count render errors as server failures.
    });
  } catch {
    // Malformed JSON, an aborted body, a transport failure — none of it is the
    // user's problem and none of it may surface as a 500.
  }

  return accepted;
}
