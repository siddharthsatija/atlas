import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NAV_ORDER } from "@/config/app";

/**
 * ATL-012 — middleware unit tests.
 *
 * The provider is stubbed so these assert the redirect decision, which is the
 * part that can be wrong in a way nothing else catches.
 */

const getUser = vi.fn();
const signOutMock = vi.fn().mockResolvedValue({ error: null });

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser, signOut: signOutMock } }),
}));

const { middleware, config } = await import("./middleware");

/**
 * Minimal NextRequest surface the middleware touches.
 *
 * `cookies.get` is part of it since ATL-013 reads the session lifetime markers.
 */
function requestFor(pathname: string, cookies: Record<string, string> = {}): NextRequest {
  const url = new URL(pathname, "https://atlas.test");
  return {
    nextUrl: { pathname: url.pathname, origin: url.origin, protocol: url.protocol },
    cookies: {
      get: (name: string) =>
        name in cookies ? { name, value: cookies[name] as string } : undefined,
      getAll: () => Object.entries(cookies).map(([name, value]) => ({ name, value })),
      set: vi.fn(),
    },
    headers: new Headers(),
    url: url.href,
  } as unknown as NextRequest;
}

/** Marker cookies representing a session that began `ageMs` ago, seen `idleMs` ago. */
function sessionMarkers(ageMs: number, idleMs: number): Record<string, string> {
  const now = Date.now();
  return {
    "atlas.session.started": String(now - ageMs),
    "atlas.session.seen": String(now - idleMs),
  };
}

function signedIn() {
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
}

function signedOut() {
  getUser.mockResolvedValue({ data: { user: null }, error: null });
}

/** The auth server could not be reached: no verdict on the session (ATL-111). */
function providerUnavailable() {
  getUser.mockRejectedValue(new Error("ECONNREFUSED"));
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-fixture");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("unauthenticated access", () => {
  it.each([...NAV_ORDER])("redirects /%s to sign-in", async (segment) => {
    signedOut();
    const response = await middleware(requestFor(`/${segment}`));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("next")).toBe(`/${segment}`);
  });

  it("redirects a nested product route, preserving only the section", async () => {
    signedOut();
    const response = await middleware(requestFor("/assets/8f14e45f-ceea-467a-9dbf"));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("next")).toBe("/assets");
    // The record identifier must not reach the sign-in URL (security §19).
    expect(location.href).not.toContain("8f14e45f");
  });

  it("never redirects off-origin", async () => {
    signedOut();
    const response = await middleware(requestFor("/assets"));
    expect(new URL(response.headers.get("location") ?? "").origin).toBe("https://atlas.test");
  });

  it.each(["/", "/sign-in", "/privacy", "/terms", "/api/monitoring/error"])(
    "leaves %s reachable",
    async (pathname) => {
      signedOut();
      const response = await middleware(requestFor(pathname));
      expect(response.headers.get("location")).toBeNull();
    },
  );
});

describe("authenticated access", () => {
  it.each([...NAV_ORDER])("allows /%s through", async (segment) => {
    signedIn();
    const response = await middleware(requestFor(`/${segment}`));
    expect(response.headers.get("location")).toBeNull();
  });

  it("verifies with the auth server rather than decoding the cookie", async () => {
    // getSession() would return whatever the cookie contains — client state,
    // which architecture §5 forbids as authorization evidence.
    signedIn();
    await middleware(requestFor("/overview"));
    expect(getUser).toHaveBeenCalledTimes(1);
  });
});

describe("failure modes", () => {
  it("fails closed on a protected route when Supabase is unconfigured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    const response = await middleware(requestFor("/assets"));

    // A misconfigured environment must not silently serve protected routes.
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/sign-in");
    expect(getUser).not.toHaveBeenCalled();
  });

  it("leaves public routes reachable when Supabase is unconfigured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    const response = await middleware(requestFor("/"));
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("an unreachable auth provider (ATL-111)", () => {
  /**
   * The failure this ticket removes. A provider outage used to be
   * indistinguishable from "no session", so middleware bounced signed-in users
   * to `/sign-in` on the strength of a failed network call — and the layout
   * then did it again.
   *
   * Passing through is not a grant. `(product)/layout.tsx` verifies again
   * before any data renders and refuses the same way; what moves is only where
   * the refusal is reported, so it can be reported honestly.
   */

  it("does not redirect a protected route to sign-in", async () => {
    providerUnavailable();

    const response = await middleware(requestFor("/assets"));

    expect(response.headers.get("location")).toBeNull();
  });

  it.each([...NAV_ORDER])("does not redirect /%s", async (segment) => {
    providerUnavailable();

    const response = await middleware(requestFor(`/${segment}`));

    expect(response.headers.get("location")).toBeNull();
  });

  it("treats a returned transport error the same as a thrown one", async () => {
    // supabase-js reports a network failure as a returned AuthRetryableFetchError
    // rather than by throwing. Both mean the same thing and must behave alike.
    getUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthRetryableFetchError" },
    });

    const response = await middleware(requestFor("/assets"));

    expect(response.headers.get("location")).toBeNull();
  });

  it.each([429, 500, 503])("does not redirect when the provider answers %i", async (status) => {
    getUser.mockResolvedValue({ data: { user: null }, error: { status } });

    const response = await middleware(requestFor("/assets"));

    expect(response.headers.get("location")).toBeNull();
  });

  it("still redirects when the provider gives a verdict", async () => {
    // A 401 is an answer, not a failure to answer. Genuine sign-outs are
    // untouched by this change.
    getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });

    const response = await middleware(requestFor("/assets"));

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/sign-in");
  });

  it("does not clear the session markers", async () => {
    /**
     * The cookies are the user's session. Clearing them during an outage would
     * turn a temporary inability to check into a real sign-out that survives
     * the provider recovering.
     */
    providerUnavailable();

    const response = await middleware(
      requestFor("/assets", sessionMarkers(1 * 60 * 60 * 1000, 60 * 1000)),
    );

    expect(response.cookies.get("atlas.session.started")).toBeUndefined();
    expect(response.cookies.get("atlas.session.seen")).toBeUndefined();
  });

  it("does not revoke the provider session", async () => {
    // Session-lifetime enforcement runs only on a confirmed session, and an
    // unconfirmed one must not be expired on unverified input.
    providerUnavailable();

    await middleware(requestFor("/assets", sessionMarkers(120 * 24 * 60 * 60 * 1000, 60 * 1000)));

    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("still applies the security headers", async () => {
    // Every response this middleware can produce carries the policy (ATL-087),
    // and the pass-through is now one more of them.
    providerUnavailable();

    const response = await middleware(requestFor("/assets"));

    expect(response.headers.get("content-security-policy")).toContain("default-src");
  });
});

describe("session lifetime enforcement (ATL-013)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("lets an active session continue and refreshes the last-seen marker", async () => {
    signedIn();
    const response = await middleware(requestFor("/overview", sessionMarkers(DAY, 60_000)));

    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get("atlas.session.seen")).toBeDefined();
    expect(response.cookies.get("atlas.session.started")).toBeDefined();
  });

  it("expires a session idle beyond the limit", async () => {
    signedIn();
    const response = await middleware(requestFor("/overview", sessionMarkers(20 * DAY, 15 * DAY)));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("reason")).toBe("session_idle");
  });

  it("expires a session past the absolute limit despite recent activity", async () => {
    // The point of an absolute limit: continuous use cannot extend it.
    signedIn();
    const response = await middleware(requestFor("/overview", sessionMarkers(91 * DAY, 60_000)));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("reason")).toBe("session_expired");
  });

  it("revokes the provider session on expiry, not just the cookies", async () => {
    // Clearing cookies alone would leave a valid refresh token at the provider,
    // making the limit cosmetic.
    signedIn();
    await middleware(requestFor("/overview", sessionMarkers(91 * DAY, 60_000)));

    expect(signOutMock).toHaveBeenCalledWith({ scope: "local" });
  });

  it("clears both markers on expiry", async () => {
    signedIn();
    const response = await middleware(requestFor("/overview", sessionMarkers(91 * DAY, 60_000)));

    expect(response.cookies.get("atlas.session.started")?.value).toBe("");
    expect(response.cookies.get("atlas.session.seen")?.value).toBe("");
  });

  it("preserves the return path when an expired session is on a product route", async () => {
    signedIn();
    const response = await middleware(
      requestFor("/assets/8f14e45f-ceea-467a", sessionMarkers(91 * DAY, 60_000)),
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("next")).toBe("/assets");
    // ATL-012's rule still holds: no record identifier in the URL.
    expect(location.href).not.toContain("8f14e45f");
  });

  it("adopts a session with no markers rather than expiring it", async () => {
    // A session predating this policy must survive the deploy.
    signedIn();
    const response = await middleware(requestFor("/overview"));

    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get("atlas.session.started")).toBeDefined();
  });

  it("does not evaluate lifetimes for an unauthenticated request", async () => {
    // Acting on a token that has not been verified would be acting on unverified
    // input; the unauthenticated redirect happens first.
    signedOut();
    await middleware(requestFor("/overview", sessionMarkers(91 * DAY, 91 * DAY)));

    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("still expires the session when the provider revocation call fails", async () => {
    signedIn();
    signOutMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const response = await middleware(requestFor("/overview", sessionMarkers(91 * DAY, 60_000)));

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/sign-in");
  });

  it("uses a neutral reason that discloses nothing about the account", async () => {
    signedIn();
    const response = await middleware(requestFor("/overview", sessionMarkers(91 * DAY, 60_000)));

    const location = new URL(response.headers.get("location") ?? "");
    expect(["session_idle", "session_expired"]).toContain(location.searchParams.get("reason"));
    expect(location.href).not.toMatch(/@|user|email/i);
  });
});

describe("security headers (ATL-087)", () => {
  /**
   * The policy must reach every response the middleware can produce, not just
   * the happy path. The redirects are the ones worth pinning: they are what an
   * unauthenticated or expired request receives, and a redirect without a
   * policy is a page an injected script could run on.
   */
  it("sets a policy on a pass-through response", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u-1" } } });
    const response = await middleware(requestFor("/overview"));

    expect(response.headers.get("content-security-policy")).toContain("script-src");
  });

  it("sets a policy on the sign-in redirect", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const response = await middleware(requestFor("/overview"));

    expect(response.status).toBe(307);
    expect(response.headers.get("content-security-policy")).toContain("script-src");
  });

  it("sets a policy on the session-expiry redirect", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u-1" } } });
    const longAgo = String(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const response = await middleware(
      requestFor("/overview", {
        "atlas.session.started": longAgo,
        "atlas.session.seen": longAgo,
      }),
    );

    expect(response.headers.get("content-security-policy")).toContain("script-src");
  });

  it("issues a different nonce per request", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u-1" } } });

    const first = await middleware(requestFor("/overview"));
    const second = await middleware(requestFor("/overview"));

    const nonceOf = (response: Response) =>
      /'nonce-([^']+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1];

    expect(nonceOf(first)).toBeDefined();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  it("names the violation report path", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u-1" } } });
    const response = await middleware(requestFor("/overview"));

    expect(response.headers.get("content-security-policy")).toContain(
      "report-uri /api/security/csp-report",
    );
    expect(response.headers.get("report-to")).toContain("csp-endpoint");
  });
});

describe("matcher", () => {
  const matches = (pathname: string) =>
    config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));

  it("runs on product routes", () => {
    for (const segment of NAV_ORDER) {
      expect(matches(`/${segment}`)).toBe(true);
    }
  });

  it("skips the auth callback, which is how a user becomes authenticated", () => {
    // Guarding it would deadlock sign-in.
    expect(matches("/auth/callback")).toBe(false);
  });

  it.each(["/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/logo.svg"])(
    "skips the static asset %s",
    (pathname) => {
      expect(matches(pathname)).toBe(false);
    },
  );
});
