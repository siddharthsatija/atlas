import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ATL-014 — sign-in actions and return-path handoff.
 *
 * The security-relevant assertions here are about the return path: that it is
 * validated before storage, that it never travels in a URL, and that a hostile
 * value is discarded rather than carried.
 */

const signInWithOtp = vi.fn();
const signInWithOAuth = vi.fn();
const cookieStore = { get: vi.fn(), getAll: vi.fn(() => []), set: vi.fn(), delete: vi.fn() };

vi.mock("@/server/auth/supabase-server-client", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { signInWithOtp, signInWithOAuth } }),
}));

/**
 * Request headers are read for the rate-limit identifier (ATL-086). Mutable so a
 * test can present a caller address.
 */
let requestHeaders = new Headers();

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve(requestHeaders),
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

vi.mock("@/config/env", () => ({
  env: {
    NEXT_PUBLIC_APP_URL: "https://atlas.test",
    ATLAS_ENV: "production",
    // Read by the ATL-086 limiter: the HMAC key pseudonymises rate-limit
    // identifiers. No counter store is configured, so the limiter is disabled
    // and these tests exercise the sign-in flow rather than the limit.
    AUDIT_HMAC_KEY: Buffer.alloc(32, 4).toString("base64"),
    RATE_LIMIT_REDIS_URL: "",
    RATE_LIMIT_REDIS_TOKEN: "",
  },
}));

const { requestMagicLinkAction, startGoogleSignInAction } = await import("./actions");
const { INITIAL_MAGIC_LINK_STATE } = await import("./form-state");

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

async function redirectTargetOf(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
}

const storedReturnPath = () =>
  cookieStore.set.mock.calls.find(([name]) => name === "atlas.auth.next")?.[1] as
    string | undefined;

beforeEach(() => {
  requestHeaders = new Headers();
  signInWithOtp.mockResolvedValue({ data: {}, error: null });
  signInWithOAuth.mockResolvedValue({
    data: { url: "https://accounts.google.com/o/oauth2/auth?x=1" },
    error: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("requestMagicLinkAction", () => {
  it("sends a link and reports the verification state", async () => {
    const state = await requestMagicLinkAction(
      INITIAL_MAGIC_LINK_STATE,
      formData({ email: "user@example.com" }),
    );

    expect(state.code).toBe("verification_sent");
    expect(signInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({ email: "user@example.com" }),
    );
  });

  it("returns the callback as the email redirect target", async () => {
    await requestMagicLinkAction(INITIAL_MAGIC_LINK_STATE, formData({ email: "user@example.com" }));

    const [args] = signInWithOtp.mock.calls[0] as [{ options: { emailRedirectTo: string } }];
    expect(args.options.emailRedirectTo).toBe("https://atlas.test/auth/callback");
  });

  it("increments the attempt counter so repeated results re-announce", async () => {
    const first = await requestMagicLinkAction(
      INITIAL_MAGIC_LINK_STATE,
      formData({ email: "bad" }),
    );
    const second = await requestMagicLinkAction(first, formData({ email: "bad" }));

    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
  });

  it("rejects a missing email without calling the provider", async () => {
    const state = await requestMagicLinkAction(INITIAL_MAGIC_LINK_STATE, formData({}));

    expect(state.code).toBe("invalid_email");
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it("reports the same code for a registered and an unregistered address", async () => {
    const known = await requestMagicLinkAction(
      INITIAL_MAGIC_LINK_STATE,
      formData({ email: "known@example.com" }),
    );

    signInWithOtp.mockResolvedValue({ data: {}, error: { code: "user_not_found" } });
    const unknown = await requestMagicLinkAction(
      INITIAL_MAGIC_LINK_STATE,
      formData({ email: "unknown@example.com" }),
    );

    expect(unknown.code).toBe(known.code);
  });
});

describe("return path handoff", () => {
  it("stores a valid return path in a cookie, not a URL", async () => {
    await requestMagicLinkAction(
      INITIAL_MAGIC_LINK_STATE,
      formData({ email: "user@example.com", next: "/assets" }),
    );

    expect(storedReturnPath()).toBe("/assets");
    // The magic-link URL is followed from an inbox; a redirect target there
    // would be an open-redirect surface.
    const [args] = signInWithOtp.mock.calls[0] as [{ options: { emailRedirectTo: string } }];
    expect(args.options.emailRedirectTo).not.toContain("assets");
  });

  it("stores the cookie HttpOnly and scoped to this origin", async () => {
    await requestMagicLinkAction(
      INITIAL_MAGIC_LINK_STATE,
      formData({ email: "user@example.com", next: "/assets" }),
    );

    const options = cookieStore.set.mock.calls.find(([name]) => name === "atlas.auth.next")?.[2] as
      Record<string, unknown> | undefined;
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  });

  it("truncates a record identifier before storing", async () => {
    await requestMagicLinkAction(
      INITIAL_MAGIC_LINK_STATE,
      formData({ email: "user@example.com", next: "/assets/8f14e45f-ceea-467a" }),
    );

    expect(storedReturnPath()).toBe("/assets");
  });

  it.each([
    ["absolute URL", "https://evil.example.com"],
    ["scheme-relative", "//evil.example.com"],
    ["unknown path", "/admin"],
  ])("discards a %s and clears any stale value", async (_label, next) => {
    await requestMagicLinkAction(
      INITIAL_MAGIC_LINK_STATE,
      formData({ email: "user@example.com", next }),
    );

    expect(storedReturnPath()).toBeUndefined();
    // Cleared rather than left alone, so a previous attempt's target cannot
    // redirect this one.
    expect(cookieStore.delete).toHaveBeenCalledWith("atlas.auth.next");
  });
});

describe("startGoogleSignInAction", () => {
  it("redirects to the provider consent URL", async () => {
    const target = await redirectTargetOf(() => startGoogleSignInAction(formData({})));
    expect(target).toContain("accounts.google.com");
  });

  it("remembers the return path before leaving for the provider", async () => {
    await redirectTargetOf(() => startGoogleSignInAction(formData({ next: "/insights" })));
    expect(storedReturnPath()).toBe("/insights");
  });

  it("falls back to the neutral unavailable reason when Google is not configured", async () => {
    // Optional per security §5: an unconfigured provider must not produce an
    // error page.
    signInWithOAuth.mockResolvedValue({ data: null, error: { code: "provider_disabled" } });

    const target = await redirectTargetOf(() => startGoogleSignInAction(formData({})));
    expect(target).toBe("/sign-in?reason=unavailable");
  });

  it("never surfaces a provider message in the redirect", async () => {
    signInWithOAuth.mockRejectedValue(new Error("Google rejected dana@example.com"));

    const target = await redirectTargetOf(() => startGoogleSignInAction(formData({})));
    expect(target).toBe("/sign-in?reason=unavailable");
    expect(target).not.toContain("dana@example.com");
  });
});
