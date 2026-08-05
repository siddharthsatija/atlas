import { describe, expect, it } from "vitest";
import {
  CSP_REPORT_PATH,
  NONCE_BYTES,
  buildContentSecurityPolicy,
  buildReportToHeader,
  generateNonce,
} from "./content-security-policy";

/**
 * ATL-087 — the Content-Security-Policy.
 *
 * The policy is the one §18 header that is computed rather than fixed, so it is
 * asserted directly here. Header *presence* on real responses is covered in
 * `src/middleware.test.ts`.
 */

const NONCE = "dGVzdC1ub25jZS12YWx1ZQ==";

function directive(policy: string, name: string): string {
  const found = policy.split("; ").find((part) => part.startsWith(`${name} `));
  return found ?? "";
}

const production = (overrides: Partial<Parameters<typeof buildContentSecurityPolicy>[0]> = {}) =>
  buildContentSecurityPolicy({ nonce: NONCE, isDevelopment: false, ...overrides });

describe("nonce generation", () => {
  it("produces 128 bits of base64", () => {
    const nonce = generateNonce();
    expect(Buffer.from(nonce, "base64")).toHaveLength(NONCE_BYTES);
  });

  it("never repeats", () => {
    /**
     * The property the whole policy rests on. A reused nonce lets an attacker
     * who observed one response inject a script that passes the policy on the
     * next, which is strictly worse than having no nonce at all — the policy
     * would look strict while admitting chosen script.
     */
    const nonces = new Set(Array.from({ length: 500 }, () => generateNonce()));
    expect(nonces.size).toBe(500);
  });
});

describe("script-src", () => {
  it("carries the nonce", () => {
    expect(directive(production(), "script-src")).toContain(`'nonce-${NONCE}'`);
  });

  it("has no unsafe-inline in production", () => {
    // The acceptance criterion, asserted literally.
    expect(directive(production(), "script-src")).not.toContain("'unsafe-inline'");
  });

  it("has no unsafe-eval in production", () => {
    expect(directive(production(), "script-src")).not.toContain("'unsafe-eval'");
  });

  it("includes strict-dynamic so runtime chunks load", () => {
    // Without it every Next-loaded chunk would need its own nonce, which the
    // framework does not do — the page breaks the moment a route code-splits.
    expect(directive(production(), "script-src")).toContain("'strict-dynamic'");
  });

  it("permits unsafe-eval only in development", () => {
    const dev = buildContentSecurityPolicy({ nonce: NONCE, isDevelopment: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
  });
});

describe("style-src", () => {
  it("carries the nonce", () => {
    expect(directive(production(), "style-src")).toContain(`'nonce-${NONCE}'`);
  });

  it("retains unsafe-inline, and only here", () => {
    /**
     * A deliberate, scoped exception. Security §18 requires avoiding unsafe
     * inline *scripts*, which `script-src` does absolutely. Next injects
     * un-nonced inline `<style>` while streaming, so a strict `style-src` would
     * render production unstyled. A browser that honours the nonce ignores this
     * fallback entirely.
     *
     * The assertion is paired: if `script-src` ever gains `'unsafe-inline'`,
     * the test above fails.
     */
    expect(directive(production(), "style-src")).toContain("'unsafe-inline'");

    const withUnsafeInline = production()
      .split("; ")
      .filter((part) => part.includes("'unsafe-inline'"))
      .map((part) => part.split(" ")[0]);
    expect(withUnsafeInline).toEqual(["style-src"]);
  });
});

describe("framing and navigation", () => {
  it("forbids all framing", () => {
    // §18's "frame-ancestors restriction". next.config.ts also sets
    // X-Frame-Options for browsers predating this directive.
    expect(directive(production(), "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("locks base-uri", () => {
    // An injected <base> re-points every relative URL on the page, script
    // sources included.
    expect(directive(production(), "base-uri")).toBe("base-uri 'self'");
  });

  it("restricts form submission to the origin", () => {
    expect(directive(production(), "form-action")).toBe("form-action 'self'");
  });

  it("forbids plugins", () => {
    expect(directive(production(), "object-src")).toBe("object-src 'none'");
  });

  it("has a default-src fallback", () => {
    // Directives not named above inherit this rather than defaulting to open.
    expect(directive(production(), "default-src")).toBe("default-src 'self'");
  });
});

describe("transport", () => {
  it("upgrades insecure requests in production", () => {
    expect(production()).toContain("upgrade-insecure-requests");
  });

  it("does not upgrade in development, where the dev server is plain HTTP", () => {
    expect(buildContentSecurityPolicy({ nonce: NONCE, isDevelopment: true })).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("permits websockets only in development", () => {
    expect(directive(production(), "connect-src")).not.toContain("ws:");
    expect(
      directive(buildContentSecurityPolicy({ nonce: NONCE, isDevelopment: true }), "connect-src"),
    ).toContain("ws:");
  });
});

describe("violation reporting", () => {
  it("emits both report-uri and report-to when configured", () => {
    // report-uri is deprecated but the only one Safari honours; report-to is the
    // modern replacement. Both, or violations are Chromium-only.
    const policy = production({ reportUri: CSP_REPORT_PATH });
    expect(policy).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(policy).toContain("report-to csp-endpoint");
  });

  it("omits reporting entirely when unconfigured", () => {
    const policy = production();
    expect(policy).not.toContain("report-uri");
    expect(policy).not.toContain("report-to");
  });

  it("builds a Report-To header naming the same group", () => {
    const header = buildReportToHeader(CSP_REPORT_PATH);
    expect(JSON.parse(header ?? "{}")).toMatchObject({
      group: "csp-endpoint",
      endpoints: [{ url: CSP_REPORT_PATH }],
    });
  });

  it("returns null when unconfigured, so no empty header is sent", () => {
    expect(buildReportToHeader(undefined)).toBeNull();
  });
});
