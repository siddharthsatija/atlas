/**
 * ATL-215 — Atlas-owned external-profile URI normaliser.
 *
 * Converts a raw URI supplied by a discovery provider into a stable,
 * deterministic canonical form so that evidence from different providers or
 * different personal fields that refer to the same external profile can be
 * collapsed onto a single discovery_candidates row.
 *
 * ## Two-tier model
 *
 * GENERIC (always applied):
 *   Safe universal transformations that preserve the identity-significant
 *   components of any URI regardless of its host.  These rules must not
 *   strip query parameters, fragments, meaningful subdomains, or path case,
 *   and must not alias hosts or collapse HTTP/HTTPS, because those operations
 *   are only safe for known platforms where Atlas can reason about the
 *   semantics.
 *
 * KNOWN-PLATFORM (registry-gated):
 *   Host-specific rules registered in KNOWN_PLATFORMS.  Applied only when the
 *   URI host matches a registered alias.  Rules here may include query
 *   stripping, fragment stripping, host alias normalisation, and path-case
 *   normalisation, because Atlas has verified those operations are safe for
 *   those platforms.
 *
 * ## Hostname handling
 *
 * The WHATWG URL constructor (Node.js built-in) lowercases the host and
 * serialises internationalised domain names to Punycode (ACE form).  A URI
 * with a Unicode hostname that the URL parser accepts is not rejected: the
 * Punycode representation is the normalised canonical form.
 *
 * ## Provider contract
 *
 * Providers MUST NOT implement independent normalisation.  The canonical URI
 * supplied by a provider must be a raw URI; this module is the single
 * normalisation point.
 *
 * @module normalize-external-profile-uri
 */

/** Registered known-platform rule.  Atlas-owned; add only after deliberate review. */
interface KnownPlatformConfig {
  /** Canonical host that all aliases are normalised to. */
  readonly canonicalHost: string;
  /** All host aliases (including the canonical host) that identify this platform. */
  readonly aliases: readonly string[];
  /** Strip query parameters from the URI. */
  readonly stripQuery: boolean;
  /** Strip the fragment from the URI. */
  readonly stripFragment: boolean;
  /** Normalise path to lowercase. */
  readonly lowercasePath: boolean;
}

/**
 * Atlas-owned known-platform registry.
 *
 * IMPORTANT: Add platforms only when a concrete provider adapter (ATL-217+)
 * requires them.  Do not speculatively register platforms for anticipated
 * future providers.  Each entry here represents a deliberate Atlas decision
 * about what is safe to strip or alias for that platform.
 *
 * Initial entry demonstrates the registry pattern and provides test coverage
 * for alias resolution, query stripping, fragment stripping, and path-case
 * normalisation.
 */
const KNOWN_PLATFORMS: readonly KnownPlatformConfig[] = [
  {
    canonicalHost: "twitter.com",
    aliases: ["twitter.com", "x.com"],
    stripQuery: true,
    stripFragment: true,
    lowercasePath: true,
  },
];

/** Alias → config lookup table built once at module initialisation time. */
const PLATFORM_BY_ALIAS = new Map<string, KnownPlatformConfig>(
  KNOWN_PLATFORMS.flatMap((cfg) => cfg.aliases.map((alias) => [alias, cfg])),
);

/**
 * Unreserved characters per RFC 3986 §2.3.  These are safe to decode because
 * they carry no special meaning in a URI component.
 *
 *   ALPHA (A-Z, a-z) | DIGIT (0-9) | "-" | "." | "_" | "~"
 */
function decodeUnreservedChars(input: string): string {
  return input.replace(/%([0-9A-Fa-f]{2})/g, (match, hex: string) => {
    const code = parseInt(hex, 16);
    if (
      (code >= 0x41 && code <= 0x5a) || // A–Z
      (code >= 0x61 && code <= 0x7a) || // a–z
      (code >= 0x30 && code <= 0x39) || // 0–9
      code === 0x2d || // -
      code === 0x2e || // .
      code === 0x5f || // _
      code === 0x7e // ~
    ) {
      return String.fromCharCode(code);
    }
    return match;
  });
}

/**
 * Returns a normalised canonical URI string for the given raw URI, or null
 * if the input cannot be normalised to a valid http/https URI.
 *
 * ### Generic rules (always applied)
 *
 * - WHATWG URL parsing: lowercases scheme and host, strips default ports
 *   (:80 for http, :443 for https), encodes invalid characters, serialises
 *   internationalised hostnames to Punycode.
 * - Decode unreserved percent-encoded characters in the path (RFC 3986 §2.3).
 * - Strip trailing slash when the path is exactly "/" and there are no query
 *   parameters or fragment (i.e. the URL is a bare root).
 *
 * ### Unknown-domain preservation (host not in KNOWN_PLATFORMS)
 *
 * - Query parameters preserved.
 * - Fragment preserved.
 * - Subdomains preserved.
 * - Path case preserved.
 * - HTTP and HTTPS treated as distinct.
 *
 * ### Known-platform rules (host in KNOWN_PLATFORMS)
 *
 * - Host alias normalised to the registered canonical host.
 * - Query parameters stripped.
 * - Fragment stripped.
 * - Path normalised to lowercase.
 *
 * @param rawUri - The raw URI supplied by the discovery provider.
 * @returns Normalised canonical URI, or null.
 */
export function normalizeExternalProfileUri(rawUri: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUri);
  } catch {
    // Unparseable input: reject.
    return null;
  }

  // Only http and https are valid external-profile URI schemes.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  // WHATWG URL parsing already:
  //   • Lowercases scheme and host
  //   • Strips default ports (80 for http, 443 for https)
  //   • Serialises IDN/Unicode hostnames to Punycode (ACE form)

  // Decode unreserved percent-encoded characters in the path.
  url.pathname = decodeUnreservedChars(url.pathname);

  // Apply known-platform rules if the host (after Punycode normalisation) is
  // registered.
  const platform = PLATFORM_BY_ALIAS.get(url.hostname);
  if (platform !== undefined) {
    url.hostname = platform.canonicalHost;
    if (platform.stripQuery) url.search = "";
    if (platform.stripFragment) url.hash = "";
    if (platform.lowercasePath) url.pathname = url.pathname.toLowerCase();
  }

  // Strip trailing slash for bare root URIs: http://example.com/ → http://example.com
  // WHATWG URL always serialises http/https with a "/" path when no explicit path
  // was provided, so we normalise these by removing the trailing slash from the
  // serialised string only when the full serialised form is exactly "origin + /".
  const serialized = url.toString();
  if (serialized === url.origin + "/") {
    return url.origin;
  }
  return serialized;
}

/**
 * Returns the registered known-platform config for the given hostname, or
 * undefined if the host is not in the registry.
 *
 * Exported for testing and for providers that need to inspect whether a host
 * is subject to known-platform rules.
 *
 * @internal Not part of the public ATL-215 API surface.
 */
export function getKnownPlatformConfig(hostname: string): KnownPlatformConfig | undefined {
  return PLATFORM_BY_ALIAS.get(hostname);
}
