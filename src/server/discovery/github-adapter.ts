import "server-only";

import { env } from "@/config/env";
import type { DiscoveryEligibleField } from "@/server/personal-fields/personal-field-service";
import type { PersonalFieldKey } from "@/lib/personal-fields";
import type { DiscoveryProviderAdapter, ProviderQueryResult } from "./provider-adapter";

// ── Provider constants ────────────────────────────────────────────────────────

export const GITHUB_PROVIDER_CLASS = "discovery_github_profile" as const;
const CONSENT_TYPE = "discovery_identifying" as const;
const DISCLOSURE_CLASS = "identifying_lookup" as const;
const DISCLOSURE_CONTRACT_VERSION = "v1" as const;

const GITHUB_USERS_BASE = "https://api.github.com/users";
const USER_AGENT = "Atlas-Discovery/1.0";
const REQUEST_TIMEOUT_MS = 10_000;

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Structured metadata for one GitHub user profile (ATL-217).
 *
 * Only the fields needed for candidate creation and encrypted provenance
 * storage are typed here.  Additional fields from the API response are
 * discarded at parse time.
 *
 * Must never be logged.  A GitHub login linked to a user request is
 * per-user data under ADR-008 §8.
 */
export interface GithubProfile {
  /** UUID of the personal field (username) that was queried. */
  fieldId: string;
  /** GitHub login (username) as returned by the API. */
  login: string;
  /** Addressable profile URL, e.g. "https://github.com/username". */
  htmlUrl: string;
  /** GitHub's internal numeric user id — stored only in encrypted evidence. */
  githubId: number;
  /** Display name (may be null if unset on the profile). */
  name: string | null;
  publicRepos: number;
  followers: number;
  /** ISO 8601 account creation timestamp. */
  createdAt: string;
}

/**
 * The payload placed in `ProviderQueryResult.data` on a successful query.
 *
 * `profile` is null when the queried handle does not correspond to an
 * existing GitHub account (HTTP 404).  The result writer uses this to skip
 * evidence and candidate creation for handles with no matching profile.
 */
export interface GithubProviderData {
  /** UUID of the personal field (username) that was queried. */
  fieldId: string;
  /** Resolved GitHub profile, or null when no account exists for the handle. */
  profile: GithubProfile | null;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * GitHub user-profile discovery adapter (ATL-217, ADR-008 §1).
 *
 * Implements `DiscoveryProviderAdapter` for the `discovery_github_profile`
 * provider class.  Responsible only for the HTTP call and response parsing.
 * All persistence, canonical candidate routing, and rejection fingerprinting
 * belong to `GithubResultWriter`.
 *
 * ## Disclosure model (ADR-008 §1)
 *
 * - `consentType = "discovery_identifying"`: the exact stored handle value
 *   crosses the outbound boundary as the URL path segment.
 * - `disclosureClass = "identifying_lookup"`: subject to check 8 in the
 *   dispatch engine (first-disclosure acknowledgment per
 *   `(provider_class, field_id, disclosure_contract_version)` tuple).
 *
 * ## API (GitHub REST v3)
 *
 * `GET https://api.github.com/users/{login}` — public endpoint.
 * Unauthenticated: 60 req/hour per IP.
 * Authenticated (GITHUB_TOKEN): 5 000 req/hour.
 * HTTP 404 → `profile: null` (valid success, no account for this handle).
 * HTTP 429 → `{ status: "rate_limited" }`.
 * Other non-2xx → `{ status: "error", errorCode: "github.http_NNN" }`.
 *
 * ## Error contract
 *
 * `query` never throws.  Network failures, timeouts, and unexpected HTTP
 * statuses are returned as `{ status: "error", errorCode }`.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * The handle value, request URL, and provider response must never appear in
 * logs.  No log calls appear in this file.
 */
export class GithubAdapter implements DiscoveryProviderAdapter {
  readonly providerClass = GITHUB_PROVIDER_CLASS;
  readonly consentType = CONSENT_TYPE;
  readonly disclosureClass = DISCLOSURE_CLASS;
  readonly disclosureContractVersion = DISCLOSURE_CONTRACT_VERSION;
  readonly eligibleFieldTypes: ReadonlySet<PersonalFieldKey> = new Set<PersonalFieldKey>([
    "username",
  ]);

  constructor(private readonly token: string | undefined) {}

  /** Production factory. Uses `GITHUB_TOKEN` from env when present. */
  static create(): GithubAdapter {
    return new GithubAdapter(env.GITHUB_TOKEN);
  }

  async query(authorizedFields: readonly DiscoveryEligibleField[]): Promise<ProviderQueryResult> {
    const usernameField = authorizedFields.find((f) => f.fieldKey === "username");
    if (!usernameField) {
      return { status: "error", errorCode: "github.no_username_field" };
    }

    // Trim the handle. Must not log this value (ADR-008 §8).
    const handle = usernameField.value.trim();
    if (!handle) {
      return { status: "error", errorCode: "github.empty_handle" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      const headers: Record<string, string> = {
        "user-agent": USER_AGENT,
        accept: "application/vnd.github.v3+json",
      };
      if (this.token) {
        headers["authorization"] = `Bearer ${this.token}`;
      }
      // encodeURIComponent prevents path traversal (e.g. "user/../../etc").
      response = await fetch(`${GITHUB_USERS_BASE}/${encodeURIComponent(handle)}`, {
        headers,
        signal: controller.signal,
      });
    } catch {
      // Network error or AbortError (timeout). Must not log URL or handle.
      return { status: "error", errorCode: "github.network_error" };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      return { status: "rate_limited" };
    }

    // 404: handle does not correspond to an existing account — valid outcome,
    // not an error.  The result writer will skip evidence and candidate creation.
    if (response.status === 404) {
      const data: GithubProviderData = { fieldId: usernameField.id, profile: null };
      return { status: "success", data };
    }

    if (!response.ok) {
      return { status: "error", errorCode: `github.http_${response.status}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: "error", errorCode: "github.parse_error" };
    }

    const profile = parseGithubProfile(body, usernameField.id);
    if (profile === null) {
      return { status: "error", errorCode: "github.unexpected_shape" };
    }

    const data: GithubProviderData = { fieldId: usernameField.id, profile };
    return { status: "success", data };
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Parses the raw GitHub API response body into a `GithubProfile`.
 *
 * Returns null if any required field is absent or has the wrong type.
 * Extra fields from the API are silently discarded (data minimisation).
 */
function parseGithubProfile(body: unknown, fieldId: string): GithubProfile | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (
    typeof b.id !== "number" ||
    typeof b.login !== "string" ||
    typeof b.html_url !== "string" ||
    typeof b.public_repos !== "number" ||
    typeof b.followers !== "number" ||
    typeof b.created_at !== "string"
  ) {
    return null;
  }
  return {
    fieldId,
    login: b.login,
    htmlUrl: b.html_url,
    githubId: b.id,
    name: typeof b.name === "string" ? b.name : null,
    publicRepos: b.public_repos,
    followers: b.followers,
    createdAt: b.created_at,
  };
}
