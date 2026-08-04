import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ATL-012 — server-side enforcement in the product route group.
 *
 * Middleware is tested separately. These assert the *second* line of defence:
 * that the layout and the server action refuse to proceed without a verified
 * session even if the request reached them — which is what protects the product
 * from a matcher misconfiguration.
 */

const getUser = vi.fn();
const cookieStore = { get: vi.fn(), getAll: vi.fn(() => []), set: vi.fn() };

vi.mock("@/server/auth/supabase-server-client", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { getUser } }),
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(cookieStore),
}));

/** `redirect()` throws a control-flow signal; this stands in for it. */
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

const { default: ProductLayout } = await import("./layout");
const { setSidebarCollapsed } = await import("./actions");

function signedIn() {
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
}

function signedOut() {
  getUser.mockResolvedValue({ data: { user: null }, error: null });
}

/** Runs an operation and returns the redirect target, or null if none occurred. */
async function redirectTargetOf(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
}

beforeEach(() => {
  cookieStore.get.mockReturnValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProductLayout", () => {
  it("redirects to sign-in when there is no verified session", async () => {
    signedOut();
    const target = await redirectTargetOf(() => ProductLayout({ children: null }));
    expect(target).toBe("/sign-in");
  });

  it("renders the shell for a verified user", async () => {
    signedIn();
    const result = await ProductLayout({ children: null });
    expect(result).not.toBeNull();
  });

  it("verifies before reading anything else", async () => {
    // The gate is the first statement, so an unauthenticated request never
    // reaches the preference read — and no protected markup is produced.
    signedOut();
    await redirectTargetOf(() => ProductLayout({ children: null }));

    expect(getUser).toHaveBeenCalledTimes(1);
    expect(cookieStore.get).not.toHaveBeenCalled();
  });

  it("revalidates the token rather than trusting the cookie", async () => {
    signedIn();
    await ProductLayout({ children: null });
    expect(getUser).toHaveBeenCalled();
  });

  it("treats a provider error as unauthenticated", async () => {
    // Fail closed: an auth server that cannot confirm the token has not
    // confirmed it.
    getUser.mockResolvedValue({ data: { user: null }, error: { code: "bad_jwt" } });
    expect(await redirectTargetOf(() => ProductLayout({ children: null }))).toBe("/sign-in");
  });

  it("treats an unreachable provider as unauthenticated", async () => {
    getUser.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await redirectTargetOf(() => ProductLayout({ children: null }))).toBe("/sign-in");
  });
});

describe("setSidebarCollapsed", () => {
  it("authenticates before writing anything", async () => {
    // Architecture §10: authenticate before reading body data. A Server Action is
    // an independently invocable POST endpoint — reachable only from a protected
    // page in the UI is not protection.
    signedOut();

    const target = await redirectTargetOf(() => setSidebarCollapsed(true));

    expect(target).toBe("/sign-in");
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("writes the preference for a verified user", async () => {
    signedIn();
    await setSidebarCollapsed(true);

    expect(cookieStore.set).toHaveBeenCalledTimes(1);
    const [name, value] = cookieStore.set.mock.calls[0] as [string, string];
    expect(name).toBe("atlas.ui.sidebar-collapsed");
    expect(value).toBe("1");
  });

  it("does not accept an identity from the caller", () => {
    // The signature takes a boolean and nothing else, so there is no parameter
    // through which a client could assert who it is (CLAUDE.md).
    expect(setSidebarCollapsed).toHaveLength(1);
  });
});
