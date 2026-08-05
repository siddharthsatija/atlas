import "server-only";

/**
 * The durable counter store behind rate limiting (ATL-086, architecture §3).
 *
 * Architecture §3 is explicit that "serverless instances cannot rate-limit in
 * memory" — every request may land on a fresh instance, so an in-process counter
 * limits nothing. The store is therefore a shared, durable service.
 *
 * ## Provider-agnostic on purpose
 *
 * **OQ-09 leaves the choice between Vercel KV and Upstash Redis open**, and
 * CLAUDE.md forbids assuming answers to open questions. This module therefore
 * defines the operation the limiter needs and ships one adapter for the
 * URL-plus-token REST shape that `RATE_LIMIT_REDIS_URL` and
 * `RATE_LIMIT_REDIS_TOKEN` already describe — the same pattern ATL-095 used for
 * the monitoring transport while its vendor was undecided. Selecting a provider
 * becomes a config change plus one adapter, not a rewrite.
 *
 * ## One operation
 *
 * `increment` is atomic increment-and-expire. Everything the limiter needs is
 * derivable from the resulting count and TTL, and keeping the interface to a
 * single call means an adapter cannot get the *sequence* wrong — a two-call
 * "read then write" store would race under exactly the concurrency rate limiting
 * exists to handle.
 */

export interface CounterResult {
  /** Value after this increment. 1 means the window just opened. */
  count: number;
  /** Whole seconds until the key expires. */
  ttlSeconds: number;
}

export interface RateLimitStore {
  /**
   * Increments `key`, setting a `windowSeconds` expiry when the window opens.
   *
   * Must be atomic. Must not extend the expiry of an existing window — a sliding
   * expiry would let a caller that keeps knocking hold the window open forever
   * and never reset.
   */
  increment(key: string, windowSeconds: number): Promise<CounterResult>;
}

/** Raised when the store cannot be reached. The limiter treats this as an outage. */
export class RateLimitStoreUnavailableError extends Error {
  constructor() {
    super("rate limit store unavailable");
    this.name = "RateLimitStoreUnavailableError";
  }
}

export interface RestStoreConfig {
  endpoint: string;
  token: string;
  /** A limiter must not hold a request open waiting on its own counter. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

interface PipelineEntry {
  result?: unknown;
  error?: string;
}

/**
 * Redis-over-HTTP adapter (Upstash-compatible REST).
 *
 * Chosen shape because `RATE_LIMIT_REDIS_URL` + `RATE_LIMIT_REDIS_TOKEN` already
 * exist in the validated environment (ATL-003) and describe exactly this
 * contract. No vendor SDK is added: a privacy product should not take a
 * dependency it can replace with one `fetch`, and OQ-09 is still open.
 *
 * The pipeline is `INCR` then `EXPIRE ... NX`. `NX` is what makes the window
 * fixed rather than sliding — it sets the TTL only when the key has none, so a
 * caller hammering the endpoint cannot keep pushing the reset further away.
 */
export function createRestRateLimitStore(config: RestStoreConfig): RateLimitStore {
  const { endpoint, token, timeoutMs = 1000, fetchImpl } = config;

  return {
    async increment(key: string, windowSeconds: number): Promise<CounterResult> {
      const doFetch = fetchImpl ?? globalThis.fetch;
      if (typeof doFetch !== "function") throw new RateLimitStoreUnavailableError();

      // `AbortSignal.timeout` is not available in every runtime Atlas targets,
      // so the controller is created explicitly.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await doFetch(`${endpoint.replace(/\/$/, "")}/pipeline`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify([
            ["INCR", key],
            ["EXPIRE", key, String(windowSeconds), "NX"],
            ["TTL", key],
          ]),
          signal: controller.signal,
          // A counter store is not the user's session; ambient credentials must
          // never travel to it.
          credentials: "omit",
          cache: "no-store",
        });

        if (!response.ok) throw new RateLimitStoreUnavailableError();

        const body: unknown = await response.json();
        if (!Array.isArray(body) || body.length < 3) throw new RateLimitStoreUnavailableError();

        const entries = body as PipelineEntry[];
        const count = Number(entries[0]?.result);
        const ttl = Number(entries[2]?.result);

        if (!Number.isFinite(count) || count < 1) throw new RateLimitStoreUnavailableError();

        return {
          count,
          // A missing or negative TTL (-1 no expiry, -2 no key) means the window
          // is not what we think it is. Reporting the full window is the safe
          // reading: it never tells a caller to retry sooner than it should.
          ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : windowSeconds,
        };
      } catch (error) {
        if (error instanceof RateLimitStoreUnavailableError) throw error;
        // Network error, timeout, abort, malformed body — indistinguishable from
        // the limiter's point of view, and all mean the same thing.
        throw new RateLimitStoreUnavailableError();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * In-memory store. **Tests only.**
 *
 * Deliberately not exported for production use and never selected by
 * `RateLimiter.create()`: architecture §3 rules out in-memory counters because
 * each serverless instance would keep its own, so the effective limit becomes
 * the configured limit multiplied by the instance count. It exists so the
 * limiter's own behaviour can be exercised without a network.
 */
export function createMemoryRateLimitStore(now: () => number = Date.now): RateLimitStore {
  const windows = new Map<string, { count: number; expiresAt: number }>();

  return {
    increment(key: string, windowSeconds: number): Promise<CounterResult> {
      const current = windows.get(key);
      const timestamp = now();

      if (!current || current.expiresAt <= timestamp) {
        const opened = { count: 1, expiresAt: timestamp + windowSeconds * 1000 };
        windows.set(key, opened);
        return Promise.resolve({ count: 1, ttlSeconds: windowSeconds });
      }

      current.count += 1;
      return Promise.resolve({
        count: current.count,
        ttlSeconds: Math.max(1, Math.ceil((current.expiresAt - timestamp) / 1000)),
      });
    },
  };
}
