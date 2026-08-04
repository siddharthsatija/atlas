import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ATL-095 — integration test asserting the redacted payload shape.
 *
 * Drives the real route handler against a real HTTP collector and inspects the
 * exact bytes that reach the wire. Unit tests assert that redaction removes a
 * field; this asserts that what a collector actually receives, after the full
 * boot path (env validation → isolation rules → config → route → transport),
 * contains nothing it should not.
 *
 * No database is involved, so this does not depend on the local Supabase
 * instance the other integration suites will require from ATL-027.
 */

/** Same poisoned fixture as ATL-010 and the monitoring unit tests. */
const POISONED_MESSAGE =
  "Failed for Dana Whitfield <dana@example.com>, phone 555-0100, 42 Roseway Ave, " +
  'token sk_live_9f2b7c1d, body {"draft":"Please delete my account"}';

const RESTRICTED_FRAGMENTS = [
  "Dana Whitfield",
  "dana@example.com",
  "555-0100",
  "Roseway",
  "sk_live_9f2b7c1d",
  "Please delete my account",
  "personal-fields.ts",
];

interface ReceivedRequest {
  body: string;
  headers: NodeJS.Dict<string | string[]>;
}

let collector: Server;
let received: ReceivedRequest[] = [];
let POST: (request: NextRequest) => Promise<NextResponse>;

beforeAll(async () => {
  collector = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ body, headers: request.headers });
      response.writeHead(200).end();
    });
  });

  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const { port } = collector.address() as AddressInfo;

  // A complete, isolation-valid local environment. Values are obvious fixtures —
  // no production data in tests (CLAUDE.md database rules).
  const kek = Buffer.alloc(32, 1).toString("base64");
  const auditKey = Buffer.alloc(32, 2).toString("base64");

  vi.stubEnv("ATLAS_ENV", "local");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-fixture");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-fixture");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("ATLAS_KEK", kek);
  vi.stubEnv("AUDIT_HMAC_KEY", auditKey);
  vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-fixture");
  vi.stubEnv("RATE_LIMIT_REDIS_URL", "http://127.0.0.1:6379");
  vi.stubEnv("RATE_LIMIT_REDIS_TOKEN", "redis-fixture");
  vi.stubEnv("ATLAS_MONITORING_ENDPOINT", `http://127.0.0.1:${port}/ingest`);
  vi.stubEnv("ATLAS_MONITORING_KEY", "collector-fixture-key");
  vi.stubEnv("ATLAS_RELEASE", "a1b2c3d4e5");

  // Imported after the environment is in place: `env.ts` validates at module load.
  ({ POST } = await import("./route"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

/**
 * The handler reads only `headers` and the body, both of which a plain `Request`
 * provides. Constructing a real `NextRequest` would pull in router internals this
 * route never touches, so the cast is narrowed to the surface actually used.
 */
function ingest(body: unknown, headers: Record<string, string> = {}): Promise<NextResponse> {
  const request = new Request("http://localhost:3000/api/monitoring/error", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

/** A well-formed ATL-010 report, as the browser would send it. */
const validReport = {
  boundary: "route" as const,
  route: "/assets/:id",
  errorName: "TypeError",
  occurredAt: "2026-07-30T09:15:00.000Z",
  digest: "ff00aa",
};

describe("POST /api/monitoring/error", () => {
  beforeAll(() => {
    received = [];
  });

  it("forwards a valid report and returns 204 with no body", async () => {
    const response = await ingest(validReport);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
  });

  it("sends exactly the allowlisted wire shape", async () => {
    received = [];
    await ingest(validReport, { "x-request-id": "iad1-abc-123" });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const payload = JSON.parse(received[0]!.body) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      "boundary",
      "digest",
      "environment",
      "errorName",
      "occurredAt",
      "release",
      "requestId",
      "route",
      "schemaVersion",
    ]);

    // Release tagging and environment separation (ATL-095 acceptance criteria).
    expect(payload.release).toBe("a1b2c3d4e5");
    expect(payload.environment).toBe("local");
    // Correlation ID is minted or adopted server-side, never taken from the body.
    expect(payload.requestId).toBe("iad1-abc-123");
    expect(payload.route).toBe("/assets/:id");
  });

  it("sends the collector credential as a header, never in the URL or body", async () => {
    received = [];
    await ingest(validReport);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]!.headers["x-atlas-monitoring-key"]).toBe("collector-fixture-key");
    expect(received[0]!.body).not.toContain("collector-fixture-key");
  });

  it("rejects a poisoned event before anything reaches the collector", async () => {
    received = [];

    // A tampered client sending every forbidden category at once.
    const response = await ingest({
      ...validReport,
      message: POISONED_MESSAGE,
      stack: `Error: ${POISONED_MESSAGE}\n    at save (/srv/atlas/personal-fields.ts:20:11)`,
      userEmail: "dana@example.com",
      requestBody: '{"draft":"Please delete my account"}',
      accessToken: "sk_live_9f2b7c1d",
    });

    // The strict schema refuses the whole event rather than stripping extras and
    // forwarding the remainder — an unexpected key means the sender is not the
    // client we shipped, and nothing it sends is trustworthy.
    expect(response.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(0);
  });

  it("never lets a restricted value reach the wire, whatever the client sends", async () => {
    received = [];

    // Poison inside fields the schema DOES accept, so it passes validation and
    // must be caught by the pre-transport redaction pass instead.
    await ingest({
      ...validReport,
      route: "/requests/dana@example.com",
      component: "Card",
    });
    await ingest({ ...validReport, route: "/assets/:id" }, { "x-request-id": "dana@example.com" });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const allBytes = received.map((r) => r.body).join("\n");
    for (const fragment of RESTRICTED_FRAGMENTS) {
      expect(allBytes).not.toContain(fragment);
    }
    expect(allBytes).not.toMatch(/message|stack|accessToken/i);
  });

  it("ignores an oversized body", async () => {
    received = [];
    await ingest({ ...validReport, route: "/x".repeat(4000) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(0);
  });

  it("returns 204 for malformed JSON rather than surfacing an error", async () => {
    const response = await ingest("{not json");
    expect(response.status).toBe(204);
  });

  it("does not fail the request when the collector is down", async () => {
    // Closing the collector simulates an outage mid-flight.
    await new Promise<void>((resolve) => collector.close(() => resolve()));
    const response = await ingest(validReport);
    expect(response.status).toBe(204);

    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  });
});
