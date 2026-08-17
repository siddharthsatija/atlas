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

/**
 * The layout gained an onboarding gate in ATL-016, which reaches the profile
 * store through the service-role client. Stubbed here so this suite keeps
 * asserting the ATL-012 redirect decision rather than the environment.
 */
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 5).toString("base64") },
}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

/** Onboarding already complete: this suite is about the session gate. */
vi.mock("@/server/onboarding/onboarding-service", () => ({
  OnboardingService: {
    create: () => ({
      start: () => Promise.resolve({ onboardingCompletedAt: "2026-08-01T00:00:00.000Z" }),
    }),
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
}));

const { default: ProductLayout } = await import("./layout");
const { AuthProviderUnavailableError } = await import("@/server/auth/require-user");
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

  it("signs out a user the provider rejects", async () => {
    // A 401 is the auth server giving a verdict: this token is not good. That
    // is a genuine sign-out and must keep redirecting.
    getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "bad_jwt", status: 401 },
    });

    expect(await redirectTargetOf(() => ProductLayout({ children: null }))).toBe("/sign-in");
  });

  it("does not sign out a user when the provider is unreachable (ATL-111)", async () => {
    /**
     * The defect this ticket exists for. A transport failure says nothing about
     * the session, and redirecting on it told signed-in users a falsehood — and
     * cost them the page they were on.
     *
     * Still a refusal: the layout throws, so nothing below it renders and no
     * unverified token becomes authorization evidence.
     */
    getUser.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(ProductLayout({ children: null })).rejects.toThrow(AuthProviderUnavailableError);
    // And specifically not a redirect: `redirect()` throws too, so asserting
    // "it threw" alone would pass even if it were still sending users away.
    await expect(ProductLayout({ children: null })).rejects.not.toBeInstanceOf(RedirectSignal);
  });

  it("treats a rate-limited check as unreachable, not as a sign-out", async () => {
    // 429 is the provider declining to answer. Nothing about the session is
    // known, so nothing about the session may be claimed.
    getUser.mockResolvedValue({
      data: { user: null },
      error: { code: "over_request_rate_limit", status: 429 },
    });

    await expect(ProductLayout({ children: null })).rejects.toThrow(AuthProviderUnavailableError);
  });

  it("treats a provider outage as unreachable", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 503 } });

    await expect(ProductLayout({ children: null })).rejects.toThrow(AuthProviderUnavailableError);
  });

  it("renders nothing at all when the provider is unreachable", async () => {
    // The refusal has to come before any data access, exactly as the redirect
    // does — an outage must not become a half-rendered protected page.
    getUser.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(ProductLayout({ children: null })).rejects.toThrow();
    expect(cookieStore.get).not.toHaveBeenCalled();
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
