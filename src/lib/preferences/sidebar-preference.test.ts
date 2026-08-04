import { describe, expect, it } from "vitest";
import {
  SIDEBAR_COLLAPSED_COOKIE,
  SIDEBAR_PREFERENCE_MAX_AGE_SECONDS,
  parseSidebarCollapsed,
  serializeSidebarCollapsed,
  sidebarPreferenceCookieOptions,
} from "./sidebar-preference";

/**
 * ATL-006 — sidebar collapse preference encoding.
 *
 * The cookie is user-controlled input, so the parser is tested against tampering
 * rather than only against values we write.
 */

describe("serializeSidebarCollapsed", () => {
  it("round-trips both states", () => {
    expect(parseSidebarCollapsed(serializeSidebarCollapsed(true))).toBe(true);
    expect(parseSidebarCollapsed(serializeSidebarCollapsed(false))).toBe(false);
  });
});

describe("parseSidebarCollapsed", () => {
  it("reads the collapsed encoding", () => {
    expect(parseSidebarCollapsed("1")).toBe(true);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["the expanded encoding", "0"],
    ["a truthy-looking string", "true"],
    ["a tampered value", "1; Path=/; HttpOnly"],
    ["an unexpected token", "yes"],
    ["whitespace padding", " 1 "],
  ])("defaults to expanded for %s", (_label, value) => {
    // Accepts only what it writes. Defaulting to expanded shows the most
    // information rather than the least when the value cannot be trusted.
    expect(parseSidebarCollapsed(value)).toBe(false);
  });
});

describe("sidebarPreferenceCookieOptions", () => {
  it("withholds the cookie from client script", () => {
    // Nothing client-side reads it — the server resolves the state during render.
    expect(sidebarPreferenceCookieOptions(true).httpOnly).toBe(true);
  });

  it("does not travel with cross-site requests", () => {
    expect(sidebarPreferenceCookieOptions(true).sameSite).toBe("lax");
  });

  it("is secure in production and not in local http development", () => {
    // A Secure cookie over local http is silently dropped, so the preference
    // would never persist for a developer.
    expect(sidebarPreferenceCookieOptions(true).secure).toBe(true);
    expect(sidebarPreferenceCookieOptions(false).secure).toBe(false);
  });

  it("outlives a session, as §3 requires", () => {
    expect(sidebarPreferenceCookieOptions(true).maxAge).toBe(SIDEBAR_PREFERENCE_MAX_AGE_SECONDS);
    expect(SIDEBAR_PREFERENCE_MAX_AGE_SECONDS).toBeGreaterThan(60 * 60 * 24 * 30);
  });

  it("applies to the whole application", () => {
    expect(sidebarPreferenceCookieOptions(true).path).toBe("/");
  });

  it("is named as a UI preference, not a credential", () => {
    expect(SIDEBAR_COLLAPSED_COOKIE).toBe("atlas.ui.sidebar-collapsed");
  });
});
