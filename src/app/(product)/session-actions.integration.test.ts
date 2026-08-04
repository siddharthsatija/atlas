import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ATL-013 — sign-out revocation.
 *
 * Asserts the two things that are invisible in the UI and only discovered when
 * they are wrong: the **scope** passed to the provider, and that local state is
 * cleared even when the provider call fails.
 */

const signOutMock = vi.fn();
const cookieStore = { get: vi.fn(), getAll: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };

vi.mock("@/server/auth/supabase-server-client", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { signOut: signOutMock } }),
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super("REDIRECT");
  }
}

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
}));

const { signOutAction, signOutAllDevicesAction } = await import("./session-actions");

async function redirectTargetOf(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
}

const deletedCookies = () => cookieStore.delete.mock.calls.map(([name]) => name as string);

afterEach(() => {
  vi.clearAllMocks();
});

describe("signOutAction — current device", () => {
  it("revokes only this browser's session", async () => {
    signOutMock.mockResolvedValue({ error: null });

    await redirectTargetOf(signOutAction);

    expect(signOutMock).toHaveBeenCalledWith({ scope: "local" });
  });

  it("clears the lifetime markers", async () => {
    signOutMock.mockResolvedValue({ error: null });
    await redirectTargetOf(signOutAction);

    expect(deletedCookies()).toEqual(
      expect.arrayContaining(["atlas.session.started", "atlas.session.seen"]),
    );
  });

  it("lands the user at sign-in", async () => {
    signOutMock.mockResolvedValue({ error: null });
    expect(await redirectTargetOf(signOutAction)).toBe("/sign-in");
  });
});

describe("signOutAllDevicesAction", () => {
  it("revokes every refresh token for the user", async () => {
    signOutMock.mockResolvedValue({ error: null });

    await redirectTargetOf(signOutAllDevicesAction);

    // `global` is what invalidates other devices; `local` would silently leave
    // a lost laptop signed in.
    expect(signOutMock).toHaveBeenCalledWith({ scope: "global" });
  });

  it("clears the lifetime markers", async () => {
    signOutMock.mockResolvedValue({ error: null });
    await redirectTargetOf(signOutAllDevicesAction);

    expect(deletedCookies()).toEqual(
      expect.arrayContaining(["atlas.session.started", "atlas.session.seen"]),
    );
  });

  it("lands the user at sign-in", async () => {
    signOutMock.mockResolvedValue({ error: null });
    expect(await redirectTargetOf(signOutAllDevicesAction)).toBe("/sign-in");
  });
});

describe("failure handling", () => {
  it.each([
    ["current device", () => signOutAction()],
    ["all devices", () => signOutAllDevicesAction()],
  ])("still signs the user out locally when the provider errors (%s)", async (_label, action) => {
    signOutMock.mockResolvedValue({ error: { code: "unexpected_failure" } });

    expect(await redirectTargetOf(action)).toBe("/sign-in");
    expect(deletedCookies().length).toBeGreaterThan(0);
  });

  it.each([
    ["current device", () => signOutAction()],
    ["all devices", () => signOutAllDevicesAction()],
  ])("still signs the user out when the provider is unreachable (%s)", async (_label, action) => {
    // Leaving someone apparently signed in because a network call failed is the
    // worse outcome — especially for the person who just lost a device.
    signOutMock.mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await redirectTargetOf(action)).toBe("/sign-in");
    expect(deletedCookies().length).toBeGreaterThan(0);
  });

  it("never surfaces a provider message", async () => {
    signOutMock.mockRejectedValue(new Error("Session for dana@example.com is invalid"));

    const target = await redirectTargetOf(signOutAllDevicesAction);

    expect(target).toBe("/sign-in");
    expect(target).not.toContain("dana@example.com");
  });
});
