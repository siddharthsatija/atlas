import "server-only";

import { createHash } from "node:crypto";
import { env } from "@/config/env";
import type { DiscoveryEligibleField } from "@/server/personal-fields/personal-field-service";
import type { PersonalFieldKey } from "@/lib/personal-fields";
import type { DiscoveryProviderAdapter, ProviderQueryResult } from "./provider-adapter";

/**
 * One breach entry returned to the result writer after two-step HIBP enrichment
 * (ATL-207, ADR-008 §1, §6).
 *
 * Only the fields kept or acted on by the result writer are typed here.
 * Extra fields from the catalogue endpoint are ignored at parse time.
 *
 * Must never be logged.  A list of breach names linked to a user request is
 * per-user data under ADR-008 §8.
 */
export interface HibpBreachMatch {
  /** Provider breach name.  Normalised to source_identifier in the writer. */
  Name: string;
  /** Human-readable title (e.g. "Adobe").  Written as evidence_summary. */
  Title: string;
  /** ISO 8601 date of the breach.  e.g. "2013-10-04". */
  BreachDate: string;
  /** Categories of data exposed in the breach. */
  DataClasses: string[];
  /** Whether HIBP has verified the breach with the breached organisation. */
  IsVerified: boolean;
  /** Approximate count of compromised accounts. */
  PwnCount: number;
  /**
   * True when this is a spam-list breach (not a service-corpus breach).
   * Used transiently by the result writer to gate candidate creation
   * (ADR-007 §12, non-service-corpus gate): spam-list breaches produce
   * evidence only, no candidate, no rejection fingerprint.
   *
   * NOT persisted in the encrypted evidence JSON.
   * NOT mapped to `is_aggregator_attributed` (which remains false for all HIBP).
   */
  isSpamList: boolean;
}

/**
 * The payload placed in `ProviderQueryResult.data` on a successful query.
 *
 * Carrying `fieldId` alongside `breaches` means the result writer receives the
 * personal-field UUID without a second DB round-trip to load the invocation's
 * field mapping.
 */
export interface HibpProviderData {
  /** UUID of the personal field (email) that was queried. */
  fieldId: string;
  /** Breach entries returned by HIBP for the k-anonymity prefix. */
  breaches: HibpBreachMatch[];
}

// ── Adapter constants ─────────────────────────────────────────────────────────

export const HIBP_PROVIDER_CLASS = "discovery_hashed_query" as const;
const CONSENT_TYPE = "discovery_hashed_query" as const;
const DISCLOSURE_CLASS = "hashed_query" as const;
const DISCLOSURE_CONTRACT_VERSION = "v1" as const;

const HIBP_RANGE_BASE = "https://haveibeenpwned.com/api/v3/breachedaccount/range";
const HIBP_BREACH_BASE = "https://haveibeenpwned.com/api/v3/breach";
const USER_AGENT = "Atlas-Discovery/1.0";
/** k-anonymity prefix length: first 6 uppercase hex chars of SHA-1(trimmed lowercase email). */
const PREFIX_LENGTH = 6;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * HIBP breached-account range adapter (ATL-207, ADR-008 §1, §4).
 *
 * Implements `DiscoveryProviderAdapter` for the `discovery_hashed_query`
 * provider class.  Responsible only for the HTTP calls and response translation.
 * All persistence, candidate routing, and rejection fingerprinting belong to
 * `HibpResultWriter`.
 *
 * ## Two-step flow (ADR-008 §1)
 *
 * Step 1: k-anonymity range lookup.
 *   `GET /api/v3/breachedaccount/range/{prefix}` with `hibp-api-key` +
 *   `user-agent`.  Response: `Array<{ hashSuffix: string; websites: string[] }>`.
 *   Local suffix matching; non-matches are discarded immediately.  No suffix
 *   match → success with empty breaches.
 *
 * Step 2: Public catalogue enrichment.
 *   `GET /api/v3/breach/{name}` with `user-agent` only (unauthenticated;
 *   no user data transmitted).  One request per breach name in the matched
 *   entry's `websites` array.  Per-breach catalogue failure → skip that breach,
 *   continue others.
 *
 * ## k-anonymity (ADR-008 §1)
 *
 * `email.trim().toLowerCase()` → SHA-1 → toUpperCase() → prefix = slice(0, 6).
 * Only the prefix crosses the outbound boundary.  The raw email address and the
 * full hash never leave Atlas.
 *
 * ## Error contract
 *
 * `query` never throws.  Network failures and unexpected HTTP statuses are
 * returned as `{ status: "error", errorCode }` so the dispatch engine can write
 * a terminal state for the invocation.  HTTP 429 is returned as
 * `{ status: "rate_limited" }`.
 *
 * ## Logging prohibition (ADR-008 §8)
 *
 * The email address, full hash, prefix, API key, request URLs, and provider
 * response must never appear in logs.  No log calls appear in this file.
 */
export class HibpAdapter implements DiscoveryProviderAdapter {
  readonly providerClass = HIBP_PROVIDER_CLASS;
  readonly consentType = CONSENT_TYPE;
  readonly disclosureClass = DISCLOSURE_CLASS;
  readonly disclosureContractVersion = DISCLOSURE_CONTRACT_VERSION;
  readonly eligibleFieldTypes: ReadonlySet<PersonalFieldKey> = new Set<PersonalFieldKey>(["email"]);

  constructor(private readonly apiKey: string) {}

  /** Production factory: reads `HIBP_API_KEY` from the validated server env. */
  static create(): HibpAdapter {
    return new HibpAdapter(env.HIBP_API_KEY);
  }

  async query(authorizedFields: readonly DiscoveryEligibleField[]): Promise<ProviderQueryResult> {
    const emailField = authorizedFields.find((f) => f.fieldKey === "email");
    if (!emailField) {
      return { status: "error", errorCode: "hibp.no_email_field" };
    }

    // k-anonymity normalisation: trim + lowercase before hashing (ADR-008 §1).
    const normalized = emailField.value.trim().toLowerCase();
    const hash = createHash("sha1").update(normalized).digest("hex").toUpperCase();
    const prefix = hash.slice(0, PREFIX_LENGTH);
    const suffix = hash.slice(PREFIX_LENGTH);

    // ── Step 1: range lookup ──────────────────────────────────────────────────

    const rangeResult = await this.fetchRange(prefix);
    if (rangeResult.status !== "ok") {
      return rangeResult.result;
    }

    // Local suffix matching — non-matches discarded immediately (ADR-008 §1).
    const matched = rangeResult.entries.find((e) => e.hashSuffix.toUpperCase() === suffix);

    // No suffix match: valid success with no breaches to report.
    if (!matched) {
      return { status: "success", data: { fieldId: emailField.id, breaches: [] } };
    }

    // ── Step 2: catalogue enrichment ──────────────────────────────────────────

    const breaches: HibpBreachMatch[] = [];
    for (const breachName of matched.websites) {
      const breach = await this.fetchBreachCatalogue(breachName);
      if (breach !== null) {
        breaches.push(breach);
      }
      // null = catalogue failure for this breach → skip, continue.
    }

    const data: HibpProviderData = { fieldId: emailField.id, breaches };
    return { status: "success", data };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Fetches the k-anonymity range response. Returns a discriminated union. */
  private async fetchRange(
    prefix: string,
  ): Promise<
    | { status: "ok"; entries: Array<{ hashSuffix: string; websites: string[] }> }
    | { status: "fail"; result: ProviderQueryResult }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${HIBP_RANGE_BASE}/${prefix}`, {
        headers: {
          "hibp-api-key": this.apiKey,
          "user-agent": USER_AGENT,
        },
        signal: controller.signal,
      });
    } catch {
      // Network error or AbortError (timeout).  Must not log the URL or prefix.
      return { status: "fail", result: { status: "error", errorCode: "hibp.network_error" } };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      return { status: "fail", result: { status: "rate_limited" } };
    }

    if (!response.ok) {
      return {
        status: "fail",
        result: { status: "error", errorCode: `hibp.http_${response.status}` },
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: "fail", result: { status: "error", errorCode: "hibp.parse_error" } };
    }

    if (!Array.isArray(body)) {
      return { status: "fail", result: { status: "error", errorCode: "hibp.unexpected_shape" } };
    }

    return {
      status: "ok",
      entries: body as Array<{ hashSuffix: string; websites: string[] }>,
    };
  }

  /**
   * Fetches one breach's catalogue metadata (Step 2).
   *
   * Returns `null` on any failure so the caller can skip that breach and continue.
   * No `hibp-api-key` header: the catalogue endpoint is public; no user data is
   * transmitted (ADR-008 §1).
   */
  private async fetchBreachCatalogue(breachName: string): Promise<HibpBreachMatch | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${HIBP_BREACH_BASE}/${encodeURIComponent(breachName)}`, {
        headers: { "user-agent": USER_AGENT },
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) return null;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }

    if (typeof body !== "object" || body === null) return null;
    const b = body as Record<string, unknown>;

    if (
      typeof b.Name !== "string" ||
      typeof b.Title !== "string" ||
      typeof b.BreachDate !== "string" ||
      !Array.isArray(b.DataClasses) ||
      typeof b.IsVerified !== "boolean" ||
      typeof b.PwnCount !== "number"
    ) {
      return null;
    }

    return {
      Name: b.Name,
      Title: b.Title,
      BreachDate: b.BreachDate,
      DataClasses: b.DataClasses as string[],
      IsVerified: b.IsVerified,
      PwnCount: b.PwnCount,
      // IsSpamList is optional in the catalogue response; absent = false.
      isSpamList: typeof b.IsSpamList === "boolean" ? b.IsSpamList : false,
    };
  }
}
