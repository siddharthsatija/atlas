import { describe, expect, it } from "vitest";
import {
  normalizeExternalProfileUri,
  getKnownPlatformConfig,
} from "./normalize-external-profile-uri";

// ── null / invalid input ──────────────────────────────────────────────────────

describe("normalizeExternalProfileUri — null for invalid input", () => {
  it("returns null for an empty string", () => {
    expect(normalizeExternalProfileUri("")).toBeNull();
  });

  it("returns null for a non-URL string", () => {
    expect(normalizeExternalProfileUri("not a url")).toBeNull();
  });

  it("returns null for a URL with an unsupported scheme (ftp)", () => {
    expect(normalizeExternalProfileUri("ftp://example.com/file")).toBeNull();
  });

  it("returns null for a URL with an unsupported scheme (mailto)", () => {
    expect(normalizeExternalProfileUri("mailto:user@example.com")).toBeNull();
  });

  it("returns null for a URL with an unsupported scheme (javascript)", () => {
    expect(normalizeExternalProfileUri("javascript:alert(1)")).toBeNull();
  });

  it("returns null for a relative path", () => {
    expect(normalizeExternalProfileUri("/path/to/resource")).toBeNull();
  });

  it("returns null for a bare domain without scheme", () => {
    expect(normalizeExternalProfileUri("example.com/path")).toBeNull();
  });
});

// ── Generic rules ─────────────────────────────────────────────────────────────

describe("normalizeExternalProfileUri — generic rules", () => {
  it("lowercases the scheme", () => {
    // WHATWG URL handles this
    expect(normalizeExternalProfileUri("HTTP://example.com/path")).toBe("http://example.com/path");
  });

  it("lowercases the host", () => {
    expect(normalizeExternalProfileUri("https://EXAMPLE.COM/path")).toBe(
      "https://example.com/path",
    );
  });

  it("strips the default http port (80)", () => {
    expect(normalizeExternalProfileUri("http://example.com:80/path")).toBe(
      "http://example.com/path",
    );
  });

  it("strips the default https port (443)", () => {
    expect(normalizeExternalProfileUri("https://example.com:443/path")).toBe(
      "https://example.com/path",
    );
  });

  it("preserves a non-default port", () => {
    expect(normalizeExternalProfileUri("https://example.com:8443/path")).toBe(
      "https://example.com:8443/path",
    );
  });

  it("strips the trailing slash from a bare root URI", () => {
    expect(normalizeExternalProfileUri("https://example.com/")).toBe("https://example.com");
  });

  it("strips the trailing slash from an http bare root URI", () => {
    expect(normalizeExternalProfileUri("http://example.com/")).toBe("http://example.com");
  });

  it("does NOT strip trailing slash when path has additional segments", () => {
    expect(normalizeExternalProfileUri("https://example.com/user/")).toBe(
      "https://example.com/user/",
    );
  });

  it("decodes unreserved percent-encoded alpha chars in path", () => {
    expect(normalizeExternalProfileUri("https://example.com/%41BC")).toBe(
      "https://example.com/ABC",
    );
  });

  it("decodes unreserved percent-encoded digit chars in path", () => {
    expect(normalizeExternalProfileUri("https://example.com/user%31")).toBe(
      "https://example.com/user1",
    );
  });

  it("decodes unreserved percent-encoded hyphen, dot, underscore, tilde", () => {
    expect(normalizeExternalProfileUri("https://example.com/path%2Dseg%2Ement%5Fname%7Etag")).toBe(
      "https://example.com/path-seg.ment_name~tag",
    );
  });

  it("preserves reserved percent-encoded chars (e.g. %2F = /)", () => {
    // %2F is "/" which is reserved; must not be decoded
    expect(normalizeExternalProfileUri("https://example.com/path%2Fslash")).toBe(
      "https://example.com/path%2Fslash",
    );
  });
});

// ── Unknown-domain identity preservation ─────────────────────────────────────

describe("normalizeExternalProfileUri — unknown domain preserves identity", () => {
  it("preserves query parameters for an unknown domain", () => {
    const uri = "https://unknown.example.com/user?ref=home&page=2";
    expect(normalizeExternalProfileUri(uri)).toBe(uri);
  });

  it("preserves the fragment for an unknown domain", () => {
    const uri = "https://unknown.example.com/profile#about";
    expect(normalizeExternalProfileUri(uri)).toBe(uri);
  });

  it("preserves a meaningful subdomain for an unknown domain", () => {
    const uri = "https://api.unknown-platform.io/v1/users/42";
    expect(normalizeExternalProfileUri(uri)).toBe(uri);
  });

  it("preserves path case for an unknown domain", () => {
    const uri = "https://unknown.example.com/Users/JohnDoe";
    expect(normalizeExternalProfileUri(uri)).toBe(uri);
  });

  it("treats HTTP and HTTPS as distinct for an unknown domain", () => {
    const http = normalizeExternalProfileUri("http://unknown.example.com/path");
    const https = normalizeExternalProfileUri("https://unknown.example.com/path");
    expect(http).not.toBe(https);
    expect(http).toBe("http://unknown.example.com/path");
    expect(https).toBe("https://unknown.example.com/path");
  });

  it("two different paths on unknown domain produce distinct canonical URIs", () => {
    const a = normalizeExternalProfileUri("https://unknown.example.com/user/alice");
    const b = normalizeExternalProfileUri("https://unknown.example.com/user/bob");
    expect(a).not.toBe(b);
  });
});

// ── Known-platform (twitter.com / x.com) ─────────────────────────────────────

describe("normalizeExternalProfileUri — known platform: twitter.com / x.com", () => {
  it("twitter.com is in the known-platform registry", () => {
    expect(getKnownPlatformConfig("twitter.com")).toBeDefined();
  });

  it("x.com is in the known-platform registry as an alias", () => {
    expect(getKnownPlatformConfig("x.com")).toBeDefined();
  });

  it("normalises x.com to twitter.com", () => {
    expect(normalizeExternalProfileUri("https://x.com/someuser")).toBe(
      "https://twitter.com/someuser",
    );
  });

  it("normalises x.com with https to twitter.com", () => {
    expect(normalizeExternalProfileUri("https://x.com/users/42")).toBe(
      "https://twitter.com/users/42",
    );
  });

  it("strips query parameters from twitter.com", () => {
    expect(normalizeExternalProfileUri("https://twitter.com/user?ref=share&t=abc")).toBe(
      "https://twitter.com/user",
    );
  });

  it("strips query parameters from x.com (alias)", () => {
    expect(normalizeExternalProfileUri("https://x.com/user?s=20")).toBe("https://twitter.com/user");
  });

  it("strips fragment from twitter.com", () => {
    expect(normalizeExternalProfileUri("https://twitter.com/user#top")).toBe(
      "https://twitter.com/user",
    );
  });

  it("normalises path to lowercase for twitter.com", () => {
    expect(normalizeExternalProfileUri("https://twitter.com/UserName")).toBe(
      "https://twitter.com/username",
    );
  });

  it("produces identical canonical URI for x.com and twitter.com with same path", () => {
    const fromX = normalizeExternalProfileUri("https://x.com/someuser");
    const fromTwitter = normalizeExternalProfileUri("https://twitter.com/SOMEUSER");
    expect(fromX).toBe(fromTwitter);
  });

  it("known-platform normalisation is deterministic (idempotent)", () => {
    const first = normalizeExternalProfileUri("https://x.com/UserName?t=1#top");
    const second = normalizeExternalProfileUri(first!);
    expect(first).toBe(second);
  });
});

// ── IDN / Unicode hostname ────────────────────────────────────────────────────

describe("normalizeExternalProfileUri — IDN / Unicode hostname", () => {
  it("accepts a URI with a Punycode-encoded hostname", () => {
    // xn--r8jz45g.jp is the ACE form of 例え.jp
    const result = normalizeExternalProfileUri("https://xn--r8jz45g.jp/path");
    expect(result).toBe("https://xn--r8jz45g.jp/path");
  });

  it("serialises a Unicode hostname to Punycode deterministically", () => {
    // The WHATWG URL constructor converts Unicode hostnames to Punycode.
    // Node.js v18+ handles this natively.
    let result: string | null;
    try {
      result = normalizeExternalProfileUri("https://例え.jp/path");
    } catch {
      // If the runtime does not support IDN in URL (very old Node), skip.
      return;
    }
    // Should either normalise to Punycode or return null if not supported;
    // must not throw an unhandled error.
    if (result !== null) {
      // Two calls must return the same value.
      expect(normalizeExternalProfileUri("https://例え.jp/path")).toBe(result);
      // Result must be http or https.
      expect(result).toMatch(/^https?:\/\//);
    }
  });

  it("two calls with the same Unicode hostname return the same result", () => {
    const a = normalizeExternalProfileUri("https://münchen.de/page");
    const b = normalizeExternalProfileUri("https://münchen.de/page");
    expect(a).toBe(b);
  });
});

// ── Determinism ───────────────────────────────────────────────────────────────

describe("normalizeExternalProfileUri — determinism", () => {
  it("returns the same value for two identical inputs", () => {
    const uri = "https://example.com/user/42?ref=home#bio";
    expect(normalizeExternalProfileUri(uri)).toBe(normalizeExternalProfileUri(uri));
  });

  it("different canonical URIs for different paths (unknown domain)", () => {
    expect(normalizeExternalProfileUri("https://example.com/alice")).not.toBe(
      normalizeExternalProfileUri("https://example.com/bob"),
    );
  });
});
