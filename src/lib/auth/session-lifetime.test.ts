import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_LIFETIME_MS,
  IDLE_LIFETIME_MS,
  evaluateSessionLifetime,
  parseMarker,
  serializeMarker,
  sessionMarkerCookieOptions,
} from "./session-lifetime";

/**
 * ATL-013 — session lifetime policy.
 *
 * The clock is injected, so expiry is simulated exactly at the boundary rather
 * than approximated by waiting.
 */

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const active = { startedAt: NOW - 1000, lastSeenAt: NOW - 1000 };

describe("policy values", () => {
  it("defines both lifetimes, with absolute longer than idle", () => {
    // An absolute limit shorter than the idle limit would make idle unreachable.
    expect(IDLE_LIFETIME_MS).toBeGreaterThan(0);
    expect(ABSOLUTE_LIFETIME_MS).toBeGreaterThan(IDLE_LIFETIME_MS);
  });

  it("is 14 days idle and 90 days absolute", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(IDLE_LIFETIME_MS).toBe(14 * day);
    expect(ABSOLUTE_LIFETIME_MS).toBe(90 * day);
  });
});

describe("evaluateSessionLifetime", () => {
  it("keeps an active session and advances last-seen", () => {
    const decision = evaluateSessionLifetime(active, NOW);

    expect(decision.status).toBe("active");
    expect(decision.markers).toEqual({ startedAt: active.startedAt, lastSeenAt: NOW });
  });

  it("preserves the original start time across requests", () => {
    // The absolute clock must not restart on activity, or it would never expire.
    const started = NOW - 30 * 24 * 60 * 60 * 1000;
    const decision = evaluateSessionLifetime({ startedAt: started, lastSeenAt: NOW - 5000 }, NOW);
    expect(decision.markers?.startedAt).toBe(started);
  });

  it("expires exactly at the idle boundary", () => {
    const atBoundary = { startedAt: NOW - IDLE_LIFETIME_MS, lastSeenAt: NOW - IDLE_LIFETIME_MS };
    expect(evaluateSessionLifetime(atBoundary, NOW).status).toBe("expired_idle");
  });

  it("stays active one millisecond before the idle boundary", () => {
    const justInside = {
      startedAt: NOW - IDLE_LIFETIME_MS + 1,
      lastSeenAt: NOW - IDLE_LIFETIME_MS + 1,
    };
    expect(evaluateSessionLifetime(justInside, NOW).status).toBe("active");
  });

  it("expires exactly at the absolute boundary even with recent activity", () => {
    // The point of an absolute limit: continuous use cannot extend it.
    const decision = evaluateSessionLifetime(
      { startedAt: NOW - ABSOLUTE_LIFETIME_MS, lastSeenAt: NOW - 1000 },
      NOW,
    );
    expect(decision.status).toBe("expired_absolute");
  });

  it("stays active one millisecond before the absolute boundary", () => {
    const decision = evaluateSessionLifetime(
      { startedAt: NOW - ABSOLUTE_LIFETIME_MS + 1, lastSeenAt: NOW - 1000 },
      NOW,
    );
    expect(decision.status).toBe("active");
  });

  it("reports the absolute reason when both limits are exceeded", () => {
    const decision = evaluateSessionLifetime(
      { startedAt: NOW - ABSOLUTE_LIFETIME_MS * 2, lastSeenAt: NOW - IDLE_LIFETIME_MS * 2 },
      NOW,
    );
    expect(decision.status).toBe("expired_absolute");
  });

  it("returns no markers when the session has expired", () => {
    const decision = evaluateSessionLifetime({ startedAt: 1, lastSeenAt: 1 }, NOW);
    expect(decision.markers).toBeUndefined();
  });

  it("adopts a session with missing markers rather than expiring it", () => {
    // A session predating this policy must not be signed out on deploy — the
    // token itself is still validated on every request.
    const decision = evaluateSessionLifetime({ startedAt: null, lastSeenAt: null }, NOW);
    expect(decision.status).toBe("active");
    expect(decision.markers).toEqual({ startedAt: NOW, lastSeenAt: NOW });
  });

  it("does not let a future-dated marker extend a session", () => {
    // Clock skew or tampering. Either way the marker is clamped to now, so it
    // cannot buy extra time.
    const decision = evaluateSessionLifetime(
      { startedAt: NOW + ABSOLUTE_LIFETIME_MS, lastSeenAt: NOW + IDLE_LIFETIME_MS },
      NOW,
    );
    expect(decision.markers).toEqual({ startedAt: NOW, lastSeenAt: NOW });
  });
});

describe("parseMarker", () => {
  it("round-trips a timestamp", () => {
    expect(parseMarker(serializeMarker(NOW))).toBe(NOW);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["negative", "-1"],
    ["zero", "0"],
    ["decimal", "1.5"],
    ["hex", "0x1f"],
    ["text", "yesterday"],
    ["over-long", "1".repeat(20)],
    ["padded", " 123 "],
    ["injection", "123; Path=/"],
  ])("treats a %s value as unknown", (_label, value) => {
    // Unknown, never zero: parsing junk as an epoch timestamp would expire every
    // session on the spot.
    expect(parseMarker(value)).toBeNull();
  });
});

describe("sessionMarkerCookieOptions", () => {
  it("keeps the markers out of client script", () => {
    expect(sessionMarkerCookieOptions(true).httpOnly).toBe(true);
    expect(sessionMarkerCookieOptions(true).sameSite).toBe("lax");
  });

  it("is secure outside local http development", () => {
    expect(sessionMarkerCookieOptions(true).secure).toBe(true);
    expect(sessionMarkerCookieOptions(false).secure).toBe(false);
  });

  it("never outlives the absolute limit it enforces", () => {
    expect(sessionMarkerCookieOptions(true).maxAge).toBe(ABSOLUTE_LIFETIME_MS / 1000);
  });
});
