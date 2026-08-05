import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/telemetry/logger";
import {
  RATE_LIMIT_POLICIES,
  RateLimiter,
  clientAddressFrom,
} from "@/server/rate-limit/rate-limit";

/**
 * Content-Security-Policy violation reports (ATL-087).
 *
 * ROUTE-HANDLER JUSTIFICATION (required by src/app/api/README.md): the browser
 * posts violation reports itself, without JavaScript, to the URL named in the
 * policy. There is no server action to reach — the reporting mechanism is the
 * browser's, and it requires an endpoint.
 *
 * ## What is recorded, and what is not
 *
 * A violation report is unusually hostile input for a privacy product. It
 * contains `document-uri`, `referrer`, and `blocked-uri`, all of which are full
 * URLs that can carry identifiers or personal data in a query string — and it
 * arrives **unauthenticated**, from any browser, with content an attacker can
 * partly choose by triggering a violation on a URL of their making.
 *
 * So the report is not stored and not forwarded. Exactly two things are kept:
 * the violated directive, which is a fixed CSP vocabulary, and a count. Both go
 * through the ATL-085 logger, whose allowlist drops anything else even if this
 * handler were changed to pass it.
 *
 * ## Always 204
 *
 * Same reasoning as the ATL-095 monitoring ingest: an endpoint that reported
 * *why* it rejected something would be a probing oracle, and a browser has no
 * use for the answer. Malformed body, over the rate limit, unparseable JSON —
 * all 204.
 */

/** Legacy `report-uri` shape (`application/csp-report`). Still the only one Safari sends. */
const legacyReportSchema = z.object({
  "csp-report": z
    .object({
      "effective-directive": z.string().optional(),
      "violated-directive": z.string().optional(),
    })
    .loose(),
});

/** Modern Reporting API shape (`application/reports+json`), sent as a batch. */
const reportingApiSchema = z.array(
  z
    .object({
      type: z.string(),
      body: z.object({ effectiveDirective: z.string().optional() }).loose(),
    })
    .loose(),
);

/**
 * Bodies larger than this are dropped unread.
 *
 * A report is a small JSON object. The cap exists because this endpoint is
 * unauthenticated, so the body is whatever a caller chooses to send.
 */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Reduces a report to the single field worth keeping.
 *
 * Returns null when no recognisable directive is present, which is treated as a
 * malformed report rather than logged as an unknown one — a violation whose
 * directive cannot be read tells an operator nothing actionable.
 */
function directiveFrom(payload: unknown): string | null {
  const legacy = legacyReportSchema.safeParse(payload);
  if (legacy.success) {
    const report = legacy.data["csp-report"];
    const raw = report["effective-directive"] ?? report["violated-directive"];
    // `violated-directive` historically included the value, e.g.
    // "script-src 'self'". Only the directive name is kept.
    return typeof raw === "string" ? (raw.split(" ")[0] ?? null) : null;
  }

  const modern = reportingApiSchema.safeParse(payload);
  if (modern.success) {
    const violation = modern.data.find((entry) => entry.type === "csp-violation");
    return violation?.body.effectiveDirective ?? null;
  }

  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const accepted = new NextResponse(null, { status: 204 });

  try {
    /**
     * Rate limited (ATL-086) before anything is parsed.
     *
     * This endpoint is unauthenticated and its URL is published in the policy
     * header of every response, so it is trivially discoverable and trivially
     * floodable. Reusing the monitoring-ingest policy rather than defining a new
     * one: both are unauthenticated first-party telemetry sinks with the same
     * abuse shape.
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

    const directive = directiveFrom(JSON.parse(raw));
    if (!directive) return accepted;

    // The logger's allowlist is the actual guard here: were this call ever
    // widened to pass a URL, the field would be dropped and counted rather than
    // written.
    logger.warn("csp.violation", { directive, count: 1 });
  } catch {
    // Malformed JSON, an aborted body, a transport failure — none of it is the
    // user's problem and none of it may surface as a 500.
  }

  return accepted;
}
