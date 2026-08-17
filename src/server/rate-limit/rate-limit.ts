import "server-only";

import { createHmac } from "node:crypto";
import { env } from "@/config/env";
import { logger } from "@/lib/telemetry/logger";
import {
  RateLimitStoreUnavailableError,
  createRestRateLimitStore,
  type RateLimitStore,
} from "./rate-limit-store";

/**
 * Rate limiting (ATL-086, security §5, architecture §3).
 *
 * ## Fixed windows, dual keys
 *
 * Each policy names a maximum and a window. A check may be keyed on more than
 * one identifier, and **every key must pass** — a single host spraying many
 * addresses is caught by the IP key, and a distributed attempt bombing one inbox
 * is caught by the address key. Either alone leaves the other attack open.
 *
 * ## Identifiers are HMACed, never stored raw
 *
 * The counter store is a third-party service, and an IP address is personal data.
 * Keys are HMACs under `AUDIT_HMAC_KEY`, the same pseudonymisation ADR-006 uses
 * for audit subjects, so the store never holds a readable list of visitor
 * addresses or email addresses. Counters only need a stable opaque key, so this
 * costs nothing functionally.
 *
 * ## Outage policy: fail open, loudly
 *
 * When the store is unreachable the request is **allowed** and an error-level
 * event is logged.
 *
 * This is the one judgement call here worth stating plainly. Failing closed
 * would mean a counter-store blip locks every user out of signing in, which
 * hands an attacker a cheaper denial of service than the abuse rate limiting
 * defends against — degrade one dependency, take down authentication. Failing
 * open trades a bounded window of missing protection for continued availability,
 * and the alert is what bounds it. The alert is therefore not decoration: it is
 * the half of the decision that makes it defensible.
 */

export interface RateLimitPolicy {
  /** Stable name, used as the key prefix. */
  name: string;
  /** Requests permitted per window. */
  max: number;
  windowSeconds: number;
}

const FIFTEEN_MINUTES = 15 * 60;

/**
 * Policy defaults.
 *
 * Security §5 mandates that login and verification be limited but specifies no
 * numbers, so these are chosen and documented rather than derived. Five sign-in
 * links per fifteen minutes leaves a user who mistypes their address or loses an
 * email plenty of room, while making inbox bombing and enumeration expensive.
 *
 * Surfaces named by ATL-086 that do not exist yet — export (M11) and request
 * generation (M8) — are deliberately absent. Their policies belong to the
 * tickets that build them; inventing limits for behaviour nobody has written
 * would be guessing at both the load and the threat. `aiRequest` was added by
 * ATL-048, the ticket that built the surface it governs.
 */
export const RATE_LIMIT_POLICIES = {
  /** Magic-link requests. The email-bombing and enumeration surface. */
  signIn: { name: "signin", max: 5, windowSeconds: FIFTEEN_MINUTES },
  /** Magic-link and OAuth callback consumption. */
  authCallback: { name: "auth_callback", max: 10, windowSeconds: FIFTEEN_MINUTES },
  /** First-party client error ingest (ATL-095). Bounded so it cannot be a firehose. */
  monitoringIngest: { name: "monitoring_ingest", max: 60, windowSeconds: 60 },
  /**
   * Provider calls through the AI gateway (ATL-048, security §10).
   *
   * **Keyed per user only, never per IP.** Every AI call happens inside an
   * authenticated session, so a user identifier always exists and is the thing
   * worth bounding: an IP key would throttle a shared office or a VPN exit as if
   * it were one person, while doing nothing extra against a signed-in caller.
   *
   * Twenty per five minutes is chosen, not derived — no document specifies a
   * number. It is set against what a person can plausibly consume: an assistant
   * answer takes seconds to read, so twenty in five minutes leaves an engaged
   * user unimpeded while capping the spend of a stuck client loop at a rate the
   * provider bill can absorb. Per-environment overrides apply as they do to
   * every other policy.
   */
  aiRequest: { name: "ai_request", max: 20, windowSeconds: 5 * 60 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

/** One identifier a check is keyed on. */
export interface RateLimitIdentifier {
  /** What kind of identifier this is, e.g. `ip`, `email`, `user`. */
  kind: string;
  /** The raw value. HMACed before it reaches the store. */
  value: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the tightest exhausted window resets. */
  retryAfterSeconds: number;
  /** True when the store was unreachable and the request was allowed through. */
  degraded: boolean;
}

/**
 * Resolves per-environment overrides.
 *
 * ATL-086 requires limits to be configurable per environment. Overrides are
 * optional and validated, so an unset variable keeps the documented default
 * rather than silently disabling the limit — the failure direction that matters.
 */
export function resolvePolicy(
  policy: RateLimitPolicy,
  overrides: { max?: number | undefined; windowSeconds?: number | undefined } = {},
): RateLimitPolicy {
  const max = overrides.max;
  const windowSeconds = overrides.windowSeconds;

  return {
    name: policy.name,
    max: Number.isInteger(max) && (max as number) > 0 ? (max as number) : policy.max,
    windowSeconds:
      Number.isInteger(windowSeconds) && (windowSeconds as number) > 0
        ? (windowSeconds as number)
        : policy.windowSeconds,
  };
}

export interface RateLimiterConfig {
  store: RateLimitStore | null;
  /** Secret for identifier pseudonymisation. */
  hmacKey: Buffer;
  /** When false, every check allows. Used by environments with no store. */
  enabled: boolean;
}

export class RateLimiter {
  private readonly config: RateLimiterConfig;

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  /**
   * Builds the limiter from validated environment configuration.
   *
   * The REST store is only constructed when both credentials are present. A
   * limiter with no store is disabled rather than broken: local development and
   * CI have no counter service, and whether a *hosted* environment is allowed to
   * run without one is an environment-isolation question (architecture §18), not
   * a runtime one.
   */
  static create(): RateLimiter {
    const url = env.RATE_LIMIT_REDIS_URL;
    const token = env.RATE_LIMIT_REDIS_TOKEN;
    const configured = Boolean(url && token);

    return new RateLimiter({
      store: configured ? createRestRateLimitStore({ endpoint: url, token }) : null,
      hmacKey: Buffer.from(env.AUDIT_HMAC_KEY, "base64"),
      enabled: configured,
    });
  }

  /**
   * Opaque, stable key for one identifier.
   *
   * Truncated to 32 hex characters: 128 bits is far beyond what a counter
   * namespace needs to avoid collisions, and shorter keys keep the store's
   * memory footprint down.
   */
  private keyFor(policy: RateLimitPolicy, identifier: RateLimitIdentifier): string {
    const digest = createHmac("sha256", this.config.hmacKey)
      .update(`${policy.name}:${identifier.kind}:${identifier.value}`, "utf8")
      .digest("hex")
      .slice(0, 32);

    return `rl:${policy.name}:${identifier.kind}:${digest}`;
  }

  /**
   * Checks every identifier against the policy.
   *
   * All identifiers are incremented even once one is known to be over the limit.
   * Short-circuiting would make the other counters undercount, so an attacker
   * could keep a second key permanently below its threshold by ensuring the
   * first always trips.
   */
  async check(
    policy: RateLimitPolicy,
    identifiers: RateLimitIdentifier[],
  ): Promise<RateLimitDecision> {
    if (!this.config.enabled || !this.config.store || identifiers.length === 0) {
      return { allowed: true, retryAfterSeconds: 0, degraded: false };
    }

    let allowed = true;
    let retryAfterSeconds = 0;

    for (const identifier of identifiers) {
      try {
        const { count, ttlSeconds } = await this.config.store.increment(
          this.keyFor(policy, identifier),
          policy.windowSeconds,
        );

        if (count > policy.max) {
          allowed = false;
          retryAfterSeconds = Math.max(retryAfterSeconds, ttlSeconds);
        }
      } catch (error) {
        if (!(error instanceof RateLimitStoreUnavailableError)) throw error;

        /**
         * Fail open, and say so.
         *
         * The log line carries the policy name and nothing else — never the
         * identifier, which is the value the HMAC exists to keep out of
         * lower-trust destinations.
         */
        /**
         * No `errorCode: "RATE_LIMITED"` here. This line previously carried it,
         * which made a dependency outage read as a user being throttled — two
         * unrelated incidents wearing the same word. It sent the E2E triage
         * looking for a lockout that was never happening. `providerAvailable:
         * false` already says what this is.
         */
        logger.error("ratelimit.store_unavailable", {
          operation: "ratelimit.check",
          provider: "ratelimit",
          providerAvailable: false,
        });

        return { allowed: true, retryAfterSeconds: 0, degraded: true };
      }
    }

    return { allowed, retryAfterSeconds, degraded: false };
  }
}

/**
 * Extracts the client address from proxy headers.
 *
 * `x-forwarded-for` is a client-supplied header that a proxy *appends* to, so
 * the left-most entry is whatever the caller claimed. The **right-most** entry
 * is the one the edge observed, which is why it is taken instead — trusting the
 * left-most would let an attacker rotate a header value and reset their own
 * counter at will.
 *
 * Returns null when no address is available. A null identifier is skipped rather
 * than replaced with a constant: bucketing every unidentifiable caller under one
 * key would let a single one exhaust the window for all of them.
 */
export function clientAddressFrom(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const observed = hops[hops.length - 1];
    if (observed) return observed;
  }

  return headers.get("x-real-ip") ?? null;
}
