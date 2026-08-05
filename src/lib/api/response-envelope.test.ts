import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  RATE_LIMITED_MESSAGE,
  fail,
  ok,
  rateLimitedResponse,
} from "./response-envelope";

/**
 * ATL-086 — the typed response envelope (architecture §10).
 *
 * The ticket requires "envelope assertions", and the envelope is a contract
 * every future route handler is written against, so its shape is pinned here
 * rather than re-derived per endpoint.
 */

const REQUEST_ID = "0f9f7d2e-7d0e-4e0a-9d4e-2a3d0f0a1b2c";

describe("success envelope", () => {
  it("matches the documented shape", () => {
    expect(ok({ items: [] }, REQUEST_ID)).toEqual({
      data: { items: [] },
      error: null,
      requestId: REQUEST_ID,
    });
  });

  it("always carries a request id for correlation", () => {
    expect(ok(null, REQUEST_ID).requestId).toBe(REQUEST_ID);
  });
});

describe("error envelope", () => {
  it("matches the documented shape", () => {
    expect(fail("INVALID_REQUEST", "Check the highlighted fields.", REQUEST_ID)).toEqual({
      data: null,
      error: { code: "INVALID_REQUEST", message: "Check the highlighted fields." },
      requestId: REQUEST_ID,
    });
  });

  it("nulls data so a caller cannot read a partial result", () => {
    expect(fail("UNAVAILABLE", "Try again shortly.", REQUEST_ID).data).toBeNull();
  });
});

describe("rate-limited response", () => {
  it("is a 429 carrying the typed envelope", () => {
    const response = rateLimitedResponse({ requestId: REQUEST_ID, retryAfterSeconds: 42 });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      data: null,
      error: { code: "RATE_LIMITED", message: RATE_LIMITED_MESSAGE },
      requestId: REQUEST_ID,
    });
  });

  it("sends Retry-After so clients do not spin", () => {
    // A client that does not know when to retry retries immediately, and a
    // limiter that provokes tight retry loops makes the load it was added to shed.
    const response = rateLimitedResponse({ requestId: REQUEST_ID, retryAfterSeconds: 42 });
    expect(response.headers["retry-after"]).toBe("42");
  });

  it("rounds a fractional wait up and never below one second", () => {
    expect(
      rateLimitedResponse({ requestId: REQUEST_ID, retryAfterSeconds: 1.2 }).headers["retry-after"],
    ).toBe("2");
    expect(
      rateLimitedResponse({ requestId: REQUEST_ID, retryAfterSeconds: 0 }).headers["retry-after"],
    ).toBe("1");
  });

  it("is not cacheable", () => {
    // A cached 429 would outlive the window it describes.
    expect(
      rateLimitedResponse({ requestId: REQUEST_ID, retryAfterSeconds: 5 }).headers["cache-control"],
    ).toBe("no-store");
  });

  it("uses calm copy that reveals nothing", () => {
    /**
     * ATL-086 asks for "a calm retry message". It must also not leak: no limit
     * value, no attempts remaining, and nothing about whether an address is
     * registered — security §5 forbids revealing that anywhere.
     */
    expect(RATE_LIMITED_MESSAGE).toBe("Too many attempts. Please wait a moment and try again.");
    expect(RATE_LIMITED_MESSAGE).not.toMatch(/\d/);
    expect(RATE_LIMITED_MESSAGE.toLowerCase()).not.toContain("account");
    expect(RATE_LIMITED_MESSAGE.toLowerCase()).not.toContain("email");
  });
});

describe("error codes", () => {
  it("are a closed set", () => {
    // A free-string code cannot be exhaustively handled, and the failure shows
    // up as a UI that silently renders nothing.
    expect(API_ERROR_CODES).toContain("RATE_LIMITED");
    expect(API_ERROR_CODES.every((code) => /^[A-Z][A-Z_]*$/.test(code))).toBe(true);
  });
});
