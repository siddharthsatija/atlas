import { describe, expect, it } from "vitest";
import {
  AI_UNAVAILABLE_MESSAGE,
  AiGatewayError,
  classifyStatus,
  isRetryable,
  toApiError,
  toLogCode,
  type AiFailureKind,
} from "./errors";
import { RATE_LIMITED_MESSAGE } from "@/lib/api/response-envelope";

/**
 * ATL-048 — the internal failure taxonomy.
 *
 * Two properties matter more than the mapping table itself: that the collapse to
 * `ApiErrorCode` loses the detail it is supposed to lose, and that nothing here
 * has anywhere to put provider prose.
 */

const ALL_KINDS: AiFailureKind[] = [
  "timeout",
  "rate_limited",
  "provider_overloaded",
  "provider_unavailable",
  "provider_rejected",
  "malformed_response",
];

describe("status classification", () => {
  it("separates 429 from the rest of the 4xx range", () => {
    // The one client error that is genuinely transient.
    expect(classifyStatus(429)).toBe("provider_overloaded");
  });

  it("treats every 5xx as an outage", () => {
    for (const status of [500, 502, 503, 529]) {
      expect(classifyStatus(status)).toBe("provider_unavailable");
    }
  });

  it("treats other 4xx as a rejected request", () => {
    // An Atlas-side defect — a bad key or a malformed body — not an outage.
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyStatus(status)).toBe("provider_rejected");
    }
  });

  it("treats a non-error status reaching the failure path as unusable output", () => {
    expect(classifyStatus(200)).toBe("malformed_response");
  });
});

describe("retryability is decided once, in one place", () => {
  it("retries exactly the three transient kinds", () => {
    expect(ALL_KINDS.filter(isRetryable)).toEqual([
      "timeout",
      "provider_overloaded",
      "provider_unavailable",
    ]);
  });

  it("never retries a rejected request", () => {
    // A 400 fails identically on the second attempt; retrying spends money and
    // latency to reach the same answer.
    expect(isRetryable("provider_rejected")).toBe(false);
  });

  it("never retries our own rate limit", () => {
    // Retrying inside the same request would defeat the limit that denied it.
    expect(isRetryable("rate_limited")).toBe(false);
  });

  it("exposes the same decision on the error itself", () => {
    expect(new AiGatewayError("timeout").retryable).toBe(true);
    expect(new AiGatewayError("provider_rejected").retryable).toBe(false);
  });
});

describe("the collapse to the closed public union", () => {
  it("maps our own limit to RATE_LIMITED with the shared message", () => {
    const envelope = toApiError("rate_limited", "req-1");

    expect(envelope.error?.code).toBe("RATE_LIMITED");
    // Reuses ATL-086's copy rather than inventing a second rate-limit sentence.
    expect(envelope.error?.message).toBe(RATE_LIMITED_MESSAGE);
  });

  it("maps every other kind to UNAVAILABLE", () => {
    for (const kind of ALL_KINDS.filter((k) => k !== "rate_limited")) {
      expect(toApiError(kind, "req-1").error?.code).toBe("UNAVAILABLE");
    }
  });

  it("gives one message for every non-limit failure", () => {
    /**
     * The intended loss of detail. A user cannot act on the difference between a
     * 500 and a malformed body, and varying the copy per kind would leak the
     * taxonomy this module exists to contain.
     */
    const messages = new Set(
      ALL_KINDS.filter((k) => k !== "rate_limited").map((k) => toApiError(k, "r").error?.message),
    );

    expect(messages).toEqual(new Set([AI_UNAVAILABLE_MESSAGE]));
  });

  it("never mentions the provider to the caller", () => {
    for (const kind of ALL_KINDS) {
      expect(toApiError(kind, "r").error?.message).not.toMatch(/anthropic|claude|provider/i);
    }
  });

  it("returns null data so a caller cannot read a partial result", () => {
    expect(toApiError("timeout", "req-1").data).toBeNull();
  });
});

describe("the error carries numbers, never prose", () => {
  it("keeps status and attempts", () => {
    const error = new AiGatewayError("provider_unavailable", { status: 503, attempts: 2 });

    expect(error.status).toBe(503);
    expect(error.attempts).toBe(2);
  });

  it("carries the retry-after seconds only for our own limit", () => {
    // Without it a caller cannot emit a correct `Retry-After`, and a 429 with no
    // guidance provokes the tight retry loop the limiter exists to prevent.
    expect(new AiGatewayError("rate_limited", { retryAfterSeconds: 42 }).retryAfterSeconds).toBe(
      42,
    );
    expect(new AiGatewayError("timeout").retryAfterSeconds).toBeUndefined();
  });

  it("builds its message from the kind alone", () => {
    // There is no field to put a provider message in, which is the point.
    const error = new AiGatewayError("provider_rejected", { status: 401 });

    expect(error.message).toBe("AI gateway failure: provider_rejected");
    expect(error.name).toBe("AiGatewayError");
  });
});

describe("log codes", () => {
  it("match the logger's allowlisted errorCode shape", () => {
    // LOG_FIELD_POLICY.errorCode requires ^[A-Z][A-Z0-9_]{0,63}$; a code that
    // failed this would be silently dropped from the log line.
    for (const kind of ALL_KINDS) {
      expect(toLogCode(kind)).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
    }
  });

  it("keeps the internal distinction that the public code discards", () => {
    // Operators need to tell an outage from an Atlas-side defect; both collapse
    // to UNAVAILABLE for the caller.
    expect(toLogCode("provider_unavailable")).not.toBe(toLogCode("provider_rejected"));
  });
});
