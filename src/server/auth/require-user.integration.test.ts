import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so they are erased before `vi.mock` hoisting runs. */
import type { SessionCheck } from "./auth-service";
import type { LogRecord } from "@/lib/telemetry/logger";

/**
 * `requireVerifiedUser` after the per-request memoisation (#131).
 *
 * ## What these prove, and what they deliberately do not
 *
 * The memoisation itself is **not** exercised here, and no test below pretends
 * otherwise. React's `cache` reads its memo table from the active cache
 * dispatcher and, with none installed, calls straight through
 * (`react/cjs/react.react-server.development.js:576-578`). Vitest never runs an
 * RSC render, so in this harness the wrapper is a pass-through.
 *
 * That has a consequence worth stating plainly: a test here asserting "two
 * requests do not share a user" would **pass whether or not the memoisation
 * exists**, because there is no cache to leak through. Such a test would be
 * vacuous, so none is written. The anti-leak property rests on the framework
 * contract documented in `require-user.ts` — the memo table is a `Map` owned by
 * each per-request RSC `Request` and reached through `AsyncLocalStorage`, with
 * no module-global store anywhere — and the *saving* is measured at runtime by
 * counting `GET /user` requests reaching the auth provider.
 *
 * What these do prove is that the refactor changed **no observable behaviour**:
 * every branch, every side effect and every redirect target is what it was.
 */

const getUser = vi.fn();
const verifySession = vi.fn<() => Promise<SessionCheck>>();
const redirect = vi.fn((path: string) => {
  /** Real `redirect` throws to abort rendering; this mirrors that control flow. */
  throw new Error(`REDIRECT:${path}`);
});

vi.mock("next/navigation", () => ({ redirect }));

vi.mock("./supabase-server-client", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { getUser } }),
}));

vi.mock("./auth-service", () => ({ verifySession: () => verifySession() }));

const { requireVerifiedUser, AuthProviderUnavailableError } = await import("./require-user");
const { setLogSink } = await import("@/lib/telemetry/logger");

const USER = { id: "11111111-1111-4111-8111-111111111111" } as const;

let logs: LogRecord[] = [];
let restoreSink: (record: LogRecord) => void;

beforeEach(() => {
  logs = [];
  restoreSink = setLogSink((record) => logs.push(record));
  verifySession.mockReset();
  redirect.mockClear();
});

afterEach(() => {
  setLogSink(restoreSink);
});

describe("an authenticated request", () => {
  it("returns the verified user", async () => {
    verifySession.mockResolvedValue({ status: "authenticated", user: USER } as SessionCheck);

    await expect(requireVerifiedUser()).resolves.toBe(USER);
  });

  it("neither redirects nor logs", async () => {
    verifySession.mockResolvedValue({ status: "authenticated", user: USER } as SessionCheck);

    await requireVerifiedUser("/insights");

    expect(redirect).not.toHaveBeenCalled();
    expect(logs).toHaveLength(0);
  });
});

describe("an unauthenticated request", () => {
  beforeEach(() => {
    verifySession.mockResolvedValue({ status: "unauthenticated" });
  });

  it("redirects to sign-in with no return path when none was given", async () => {
    await expect(requireVerifiedUser()).rejects.toThrow(/REDIRECT:/);

    expect(redirect).toHaveBeenCalledWith("/sign-in");
  });

  it("preserves the caller's return path", async () => {
    await expect(requireVerifiedUser("/insights")).rejects.toThrow(/REDIRECT:/);

    /** Asserted exactly: `buildSignInPath` percent-encodes the destination. */
    expect(redirect).toHaveBeenCalledWith("/sign-in?next=%2Finsights");
  });

  /**
   * The reason `returnPath` is kept **outside** the cached lookup.
   *
   * Two callers in one request may want different destinations. Were the
   * parameter ever folded into the memoised function, the second caller would be
   * served the first's path — so this asserts each call redirects to its own.
   */
  it("gives each caller its own destination", async () => {
    await expect(requireVerifiedUser("/insights")).rejects.toThrow(/REDIRECT:/);
    await expect(requireVerifiedUser("/assets")).rejects.toThrow(/REDIRECT:/);

    expect(redirect).toHaveBeenNthCalledWith(1, "/sign-in?next=%2Finsights");
    expect(redirect).toHaveBeenNthCalledWith(2, "/sign-in?next=%2Fassets");
  });
});

describe("when the auth provider cannot be reached", () => {
  beforeEach(() => {
    verifySession.mockResolvedValue({ status: "unavailable" });
  });

  it("throws AuthProviderUnavailableError rather than redirecting", async () => {
    /**
     * ATL-111: a redirect would assert the user is signed out, which is not what
     * an unreachable provider establishes. Their cookie is untouched.
     */
    await expect(requireVerifiedUser("/insights")).rejects.toBeInstanceOf(
      AuthProviderUnavailableError,
    );

    expect(redirect).not.toHaveBeenCalled();
  });

  it("logs auth.provider_unavailable", async () => {
    await expect(requireVerifiedUser()).rejects.toThrow(AuthProviderUnavailableError);

    expect(logs.map((record) => record.event)).toContain("auth.provider_unavailable");
  });

  /**
   * The log stays **outside** the cached lookup, so each call site still reports
   * its own refusal. Folding it inside would silence every caller after the
   * first and make an outage look narrower in the logs than it was.
   */
  it("logs once per call, not once per request", async () => {
    await expect(requireVerifiedUser()).rejects.toThrow(AuthProviderUnavailableError);
    await expect(requireVerifiedUser()).rejects.toThrow(AuthProviderUnavailableError);

    expect(logs.filter((record) => record.event === "auth.provider_unavailable")).toHaveLength(2);
  });

  it("carries no session, token or account detail in the log", async () => {
    await expect(requireVerifiedUser()).rejects.toThrow(AuthProviderUnavailableError);

    expect(JSON.stringify(logs)).not.toContain(USER.id);
  });
});

describe("a failure is never turned into a success", () => {
  it("propagates a thrown lookup rather than returning a user", async () => {
    /**
     * `cache` records a rejection and re-throws it for the rest of the request
     * (`react.react-server.development.js:604-607`); it never substitutes a
     * resolved value. This asserts the outcome that matters: a caller who could
     * not be verified is refused, not admitted.
     */
    verifySession.mockRejectedValue(new Error("transport failed"));

    await expect(requireVerifiedUser()).rejects.toThrow("transport failed");
  });

  it("does not fall back to a previously authenticated result", async () => {
    verifySession.mockResolvedValueOnce({ status: "authenticated", user: USER } as SessionCheck);
    await expect(requireVerifiedUser()).resolves.toBe(USER);

    verifySession.mockResolvedValue({ status: "unavailable" });

    await expect(requireVerifiedUser()).rejects.toBeInstanceOf(AuthProviderUnavailableError);
  });
});
