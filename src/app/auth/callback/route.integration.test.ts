import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NextRequest, NextResponse } from "next/server";

/**
 * ATL-011 — magic-link and OAuth callback consumption.
 *
 * Exercises the real route handler end to end over a stubbed provider: link
 * consumed, link expired, link forged, provider error returned. The assertion that
 * matters most is on the **redirect URL**, because that is the one thing the user's
 * browser — and anything logging it — actually sees.
 *
 * Runs in the integration project because the route imports `server-only` modules.
 */

const exchangeCodeForSession = vi.fn();

vi.mock("@/server/auth/supabase-server-client", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { exchangeCodeForSession } }),
}));

let GET: (request: NextRequest) => Promise<NextResponse>;

beforeAll(async () => {
  ({ GET } = await import("./route"));
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * `cookies.get` is part of the surface since ATL-014: the callback reads the
 * return path this origin stored before the round trip.
 */
function callback(query: string, cookies: Record<string, string> = {}): Promise<NextResponse> {
  const request = new Request(`https://atlas.test/auth/callback${query}`);
  Object.defineProperty(request, "cookies", {
    value: {
      get: (name: string) =>
        name in cookies ? { name, value: cookies[name] as string } : undefined,
      getAll: () => Object.entries(cookies).map(([name, value]) => ({ name, value })),
    },
  });
  return GET(request as unknown as NextRequest);
}

function locationOf(response: NextResponse): URL {
  return new URL(response.headers.get("location") ?? "");
}

describe("GET /auth/callback", () => {
  it("consumes a valid code and lands the user in the product", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

    const response = await callback("?code=valid-code");

    expect(exchangeCodeForSession).toHaveBeenCalledWith("valid-code");
    expect(response.status).toBe(307);
    expect(locationOf(response).pathname).toBe("/overview");
  });

  it("keeps the success redirect free of any parameter", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

    const location = locationOf(await callback("?code=valid-code"));
    expect(location.search).toBe("");
  });

  it.each([
    ["expired", "otp_expired"],
    ["already consumed", "flow_state_not_found"],
    ["forged", "bad_code_verifier"],
  ])("sends a %s link to sign-in with one neutral reason", async (_label, code) => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: { code } });

    const location = locationOf(await callback("?code=some-code"));

    expect(location.pathname).toBe("/sign-in");
    // One reason for every link failure: distinguishing them would tell the
    // holder of a stolen link whether it was ever valid.
    expect(location.searchParams.get("reason")).toBe("link_invalid_or_expired");
  });

  it("treats a missing code as a link failure without calling the provider", async () => {
    const location = locationOf(await callback(""));

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(location.searchParams.get("reason")).toBe("link_invalid_or_expired");
  });

  it("does not forward the provider's own error parameters", async () => {
    // Google returns ?error=access_denied&error_description=... when consent is
    // cancelled. Neither the code nor the description may reach our redirect.
    const location = locationOf(
      await callback(
        "?error=access_denied&error_description=User%20dana%40example.com%20denied%20access",
      ),
    );

    expect(location.href).not.toContain("access_denied");
    expect(location.href).not.toContain("dana@example.com");
    expect(location.searchParams.get("reason")).toBe("link_invalid_or_expired");
  });

  it("never puts a provider message in the redirect", async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: {},
      error: { code: "otp_expired", message: "Token for dana@example.com has expired" },
    });

    const location = locationOf(await callback("?code=some-code"));
    expect(location.href).not.toContain("dana@example.com");
    expect(location.href).not.toContain("expired ");
  });

  it("reports an unreachable provider distinctly from a bad link", async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: {},
      error: { code: "over_request_rate_limit" },
    });

    const location = locationOf(await callback("?code=some-code"));
    // Telling the user their link is broken when the service is merely busy
    // sends them round the loop generating more links against the same limit.
    expect(location.searchParams.get("reason")).toBe("unavailable");
  });

  it("does not honour a redirect target supplied in the URL", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

    // Honouring `next` here would make the callback an open redirect: this URL
    // is followed from an inbox and can be crafted by anyone. The return path
    // comes from a cookie this origin set instead (ATL-014).
    const location = locationOf(await callback("?code=valid-code&next=https://evil.example.com"));

    expect(location.origin).toBe("https://atlas.test");
    expect(location.pathname).toBe("/overview");
  });

  it("returns the user to the remembered path (ATL-014)", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

    const location = locationOf(
      await callback("?code=valid-code", { "atlas.auth.next": "/assets" }),
    );

    expect(location.pathname).toBe("/assets");
  });

  it("revalidates the remembered path rather than trusting the cookie", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

    // The value round-tripped through the browser, so it is untrusted again.
    for (const tampered of ["https://evil.example.com", "//evil.example.com", "/admin"]) {
      const location = locationOf(
        await callback("?code=valid-code", { "atlas.auth.next": tampered }),
      );
      expect(location.origin).toBe("https://atlas.test");
      expect(location.pathname).toBe("/overview");
    }
  });

  it("clears the remembered path once consumed", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

    // Leaving it would send a later sign-in to a stale target.
    const response = await callback("?code=valid-code", { "atlas.auth.next": "/assets" });
    expect(response.cookies.get("atlas.auth.next")?.value).toBe("");
  });

  it("does not throw when the provider connection fails", async () => {
    exchangeCodeForSession.mockRejectedValue(new Error("ECONNREFUSED"));

    const response = await callback("?code=some-code");
    expect(response.status).toBe(307);
    expect(locationOf(response).href).not.toContain("ECONNREFUSED");
  });
});
