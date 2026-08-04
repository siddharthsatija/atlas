import { describe, expect, it, vi } from "vitest";
import {
  signOut,
  signOutAllDevices,
  signOutCurrentDevice,
  type SessionClient,
} from "./session-service";

/**
 * ATL-013 — session revocation.
 *
 * The scope argument is the whole contract: `local` clears this browser,
 * `global` revokes every refresh token. Getting it wrong is invisible in the UI
 * and only discovered when someone's stolen laptop stays signed in.
 */

function sessionDouble(overrides: Partial<SessionClient> = {}): SessionClient {
  return {
    signOut: vi.fn().mockResolvedValue({ error: null }),
    ...overrides,
  };
}

describe("signOutCurrentDevice", () => {
  it("revokes only this browser's session", async () => {
    const auth = sessionDouble();
    const result = await signOutCurrentDevice(auth);

    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(result).toEqual({ code: "signed_out", scope: "local" });
  });

  it("leaves other devices signed in", async () => {
    // Asserted through the scope: `global` here would sign a user out everywhere
    // when they only asked to sign out of one browser.
    const auth = sessionDouble();
    await signOutCurrentDevice(auth);
    expect(auth.signOut).not.toHaveBeenCalledWith({ scope: "global" });
  });
});

describe("signOutAllDevices", () => {
  it("revokes every refresh token for the user", async () => {
    const auth = sessionDouble();
    const result = await signOutAllDevices(auth);

    expect(auth.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(result).toEqual({ code: "signed_out", scope: "global" });
  });
});

describe("failure handling", () => {
  it("reports a provider error without surfacing it", async () => {
    const auth = sessionDouble({
      signOut: vi
        .fn()
        .mockResolvedValue({ error: { code: "unexpected_failure", message: "dana@example.com" } }),
    });

    const result = await signOut(auth, "global");

    expect(result.code).toBe("unavailable");
    // The result is a code, not a message — nothing from the provider travels.
    expect(JSON.stringify(result)).not.toContain("dana@example.com");
  });

  it("does not throw when the provider is unreachable", async () => {
    // The caller clears local cookies regardless, so a failed network call must
    // not leave the user apparently signed in.
    const auth = sessionDouble({
      signOut: vi.fn().mockRejectedValue(new Error("ECONNREFUSED at db.example.com")),
    });

    const result = await signOut(auth, "local");

    expect(result).toEqual({ code: "unavailable", scope: "local" });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  it("always reports the scope it attempted", async () => {
    const auth = sessionDouble({ signOut: vi.fn().mockRejectedValue(new Error("x")) });
    expect((await signOut(auth, "global")).scope).toBe("global");
  });
});
