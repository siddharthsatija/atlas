import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * ATL-087 — the security §18 checklist, asserted as a checklist.
 *
 * §18 is a list of headers that must be present. The per-header behaviour is
 * tested where it lives (CSP in `src/lib/security`, presence on real responses
 * in `src/middleware.test.ts`); this file exists so that *deleting* one is a
 * test failure rather than a silent regression nobody notices until a scan.
 *
 * It is the ATL-087 counterpart to `repo-guards.test.ts`: an invariant that is
 * cheap to violate and expensive to discover late.
 */

const ROOT = join(__dirname, "../..");

function read(path: string): string {
  return execFileSync("cat", [join(ROOT, path)], { encoding: "utf8" });
}

/** Static headers, resolved from the real Next config rather than a copy. */
async function staticHeaders(): Promise<Map<string, string>> {
  const entries = await nextConfig.headers?.();
  const first = entries?.[0];
  return new Map((first?.headers ?? []).map((header) => [header.key.toLowerCase(), header.value]));
}

describe("security §18 headers are all accounted for", () => {
  it("sets Strict-Transport-Security with a long max-age and preload", async () => {
    const value = (await staticHeaders()).get("strict-transport-security") ?? "";
    expect(value).toContain("max-age=");
    expect(value).toContain("includeSubDomains");
    expect(value).toContain("preload");

    // A short max-age leaves a window in which the first request of a visit can
    // be downgraded to HTTP.
    const maxAge = Number(/max-age=(\d+)/.exec(value)?.[1] ?? 0);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
  });

  it("sets X-Content-Type-Options to nosniff", async () => {
    expect((await staticHeaders()).get("x-content-type-options")).toBe("nosniff");
  });

  it("sets a Referrer-Policy that does not leak paths cross-origin", async () => {
    const value = (await staticHeaders()).get("referrer-policy");
    expect(["strict-origin-when-cross-origin", "same-origin", "no-referrer"]).toContain(value);
  });

  it("sets a Permissions-Policy denying the powerful features", async () => {
    const value = (await staticHeaders()).get("permissions-policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(value).toContain(`${feature}=()`);
    }
  });

  it("sets X-Frame-Options for browsers predating frame-ancestors", async () => {
    // CSP frame-ancestors is the modern control and middleware sets it; this is
    // the fallback, not a duplicate.
    expect((await staticHeaders()).get("x-frame-options")).toBe("DENY");
  });

  it("does not set a static Content-Security-Policy", () => {
    /**
     * CSP must stay in middleware, because it needs a per-request nonce. A
     * static policy in `next.config.ts` would be either unsafe (unsafe-inline)
     * or broken (no nonce for streamed scripts) — and, worse, it would *look*
     * like the header was handled.
     */
    const config = read("next.config.ts");
    expect(config).not.toMatch(/key:\s*["']Content-Security-Policy["']/i);
  });

  it("applies the static headers to every path", async () => {
    const entries = await nextConfig.headers?.();
    expect(entries?.[0]?.source).toBe("/:path*");
  });

  it("does not advertise the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("secure cookie attributes (§18)", () => {
  /**
   * Every cookie Atlas sets must be HttpOnly, SameSite, and Secure outside local
   * development.
   *
   * Checked by scanning the option builders rather than by rendering a response:
   * a cookie is added by writing one of these, so this catches a new one at the
   * moment it is introduced rather than when someone remembers to test it.
   */
  const cookieBuilders = [
    "src/lib/auth/session-lifetime.ts",
    "src/lib/auth/return-path.ts",
    "src/lib/preferences/sidebar-preference.ts",
  ];

  it.each(cookieBuilders)("%s sets httpOnly, sameSite, and secure", (path) => {
    const source = read(path);
    expect(source).toContain("httpOnly: true");
    expect(source).toMatch(/sameSite:\s*"(lax|strict)"/);
    expect(source).toMatch(/secure:\s*\w/);
  });

  it("has no cookie option builder outside the audited list", () => {
    // If this fails, a new cookie was added — extend the list above and confirm
    // the new builder sets the same three attributes.
    const found = execFileSync("grep", ["-rl", "--include=*.ts", "httpOnly", join(ROOT, "src")], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((file) => file.replace(`${ROOT}/`, ""))
      .filter((file) => !file.endsWith(".test.ts"))
      // The middleware consumes the builders; it defines none of its own.
      .filter((file) => file !== "src/middleware.ts")
      .sort();

    expect(found).toEqual([...cookieBuilders].sort());
  });
});
