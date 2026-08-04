import { describe, expect, it, vi } from "vitest";
import {
  completeAuthCallback,
  getVerifiedUser,
  signInWithGoogle,
  signInWithMagicLink,
  type AuthClient,
} from "./auth-service";

/**
 * ATL-011 — authentication operations.
 *
 * The provider is a test double: these assert *our* contract — the closed result
 * set, the neutral behaviour, and the flags that make it neutral — not Supabase's
 * implementation.
 */

function authDouble(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    signInWithOtp: vi.fn().mockResolvedValue({ data: {}, error: null }),
    signInWithOAuth: vi.fn().mockResolvedValue({
      data: { url: "https://accounts.google.com/o/oauth2/auth?x=1" },
      error: null,
    }),
    exchangeCodeForSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }),
    ...overrides,
  };
}

const REDIRECT = "https://atlas.test/auth/callback";

describe("signInWithMagicLink", () => {
  it("requests a link and reports it sent", async () => {
    const auth = authDouble();
    const result = await signInWithMagicLink(auth, {
      email: "user@example.com",
      redirectTo: REDIRECT,
    });
    expect(result.code).toBe("verification_sent");
  });

  it("sets shouldCreateUser so sign-in and sign-up are one operation", async () => {
    /**
     * The security-critical flag. With `shouldCreateUser: false` an unregistered
     * address takes a different, faster path and returns a different provider
     * error — the neutral wording would then paper over an observable difference.
     */
    const auth = authDouble();
    await signInWithMagicLink(auth, { email: "user@example.com", redirectTo: REDIRECT });

    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: "user@example.com",
      options: { shouldCreateUser: true, emailRedirectTo: REDIRECT },
    });
  });

  it("normalises the address so one identity is not split by casing", async () => {
    const auth = authDouble();
    await signInWithMagicLink(auth, { email: "  User@Example.COM  ", redirectTo: REDIRECT });

    expect(auth.signInWithOtp).toHaveBeenCalledWith(
      expect.objectContaining({ email: "user@example.com" }),
    );
  });

  it("rejects a malformed address without calling the provider", async () => {
    // No provider call means no account lookup, so nothing can leak.
    const auth = authDouble();
    const result = await signInWithMagicLink(auth, { email: "not-an-email", redirectTo: REDIRECT });

    expect(result.code).toBe("invalid_email");
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("responds identically for a registered and an unregistered address", async () => {
    const known = await signInWithMagicLink(authDouble(), {
      email: "known@example.com",
      redirectTo: REDIRECT,
    });
    const unknown = await signInWithMagicLink(
      authDouble({
        signInWithOtp: vi.fn().mockResolvedValue({ data: {}, error: { code: "user_not_found" } }),
      }),
      { email: "unknown@example.com", redirectTo: REDIRECT },
    );

    expect(unknown).toEqual(known);
  });

  it("makes the same single provider call in both cases", async () => {
    // Equal work, so response timing does not become the side channel that the
    // response body is not.
    const known = authDouble();
    const unknown = authDouble({
      signInWithOtp: vi.fn().mockResolvedValue({ data: {}, error: { code: "user_not_found" } }),
    });

    await signInWithMagicLink(known, { email: "a@example.com", redirectTo: REDIRECT });
    await signInWithMagicLink(unknown, { email: "b@example.com", redirectTo: REDIRECT });

    expect(known.signInWithOtp).toHaveBeenCalledTimes(1);
    expect(unknown.signInWithOtp).toHaveBeenCalledTimes(1);
  });

  it("reports a rate limit", async () => {
    const auth = authDouble({
      signInWithOtp: vi
        .fn()
        .mockResolvedValue({ data: {}, error: { code: "over_email_send_rate_limit" } }),
    });
    const result = await signInWithMagicLink(auth, {
      email: "a@example.com",
      redirectTo: REDIRECT,
    });
    expect(result.code).toBe("rate_limited");
  });

  it("does not surface a thrown transport failure", async () => {
    const auth = authDouble({
      signInWithOtp: vi.fn().mockRejectedValue(new Error("ECONNREFUSED at db.example.com")),
    });
    const result = await signInWithMagicLink(auth, {
      email: "a@example.com",
      redirectTo: REDIRECT,
    });

    expect(result).toEqual({ code: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });
});

describe("signInWithGoogle", () => {
  it("returns the consent URL without redirecting, and asks for the email scope", async () => {
    const auth = authDouble();
    const result = await signInWithGoogle(auth, { redirectTo: REDIRECT });

    expect(result.code).toBe("redirect_ready");
    expect(result.url).toContain("accounts.google.com");

    // Asserted as a complete literal rather than a partial match: every option
    // here carries weight. `skipBrowserRedirect` keeps the navigation under
    // server control, and the `email` scope is what lets Supabase link a Google
    // identity to an existing user on a *verified* address.
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: REDIRECT,
        skipBrowserRedirect: true,
        scopes: "email profile",
      },
    });
  });

  it("reports unavailable when the provider is not configured", async () => {
    // Google is optional (§5): the application must degrade, not fail.
    const auth = authDouble({
      signInWithOAuth: vi
        .fn()
        .mockResolvedValue({ data: null, error: { code: "provider_disabled" } }),
    });
    expect(await signInWithGoogle(auth, { redirectTo: REDIRECT })).toEqual({ code: "unavailable" });
  });

  it("reports unavailable when no URL comes back", async () => {
    const auth = authDouble({
      signInWithOAuth: vi.fn().mockResolvedValue({ data: { url: null }, error: null }),
    });
    expect((await signInWithGoogle(auth, { redirectTo: REDIRECT })).code).toBe("unavailable");
  });
});

describe("completeAuthCallback", () => {
  it("establishes a session for a valid code", async () => {
    const auth = authDouble();
    expect(await completeAuthCallback(auth, "valid-code")).toEqual({ code: "session_established" });
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("valid-code");
  });

  it.each(["", "   "])("rejects an empty code without calling the provider", async (code) => {
    const auth = authDouble();
    expect(await completeAuthCallback(auth, code)).toEqual({ code: "link_invalid_or_expired" });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("reports an expired link and a forged link identically", async () => {
    const expired = await completeAuthCallback(
      authDouble({
        exchangeCodeForSession: vi
          .fn()
          .mockResolvedValue({ data: {}, error: { code: "otp_expired" } }),
      }),
      "code",
    );
    const forged = await completeAuthCallback(
      authDouble({
        exchangeCodeForSession: vi
          .fn()
          .mockResolvedValue({ data: {}, error: { code: "flow_state_not_found" } }),
      }),
      "code",
    );

    expect(expired).toEqual(forged);
  });
});

describe("getVerifiedUser", () => {
  it("revalidates with the auth server rather than trusting the cookie", async () => {
    // getUser() checks the token; getSession() only decodes what the browser sent.
    const auth = authDouble();
    await getVerifiedUser(auth);
    expect(auth.getUser).toHaveBeenCalled();
  });

  it("returns the user when the token verifies", async () => {
    expect(await getVerifiedUser(authDouble())).toEqual({ id: "user-1" });
  });

  it("returns null when verification fails", async () => {
    const auth = authDouble({
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { code: "bad_jwt" } }),
    });
    expect(await getVerifiedUser(auth)).toBeNull();
  });

  it("returns null rather than throwing when the provider is unreachable", async () => {
    const auth = authDouble({ getUser: vi.fn().mockRejectedValue(new Error("offline")) });
    expect(await getVerifiedUser(auth)).toBeNull();
  });
});
