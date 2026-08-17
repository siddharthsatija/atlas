import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Type-only, so they are erased before `vi.mock` hoisting runs. */
import type {
  AiCompletionRequest,
  AiProviderClient,
  ProviderCallInput,
  AiGatewayDeps,
} from "./gateway";
import type {
  RateLimitPolicy,
  RateLimiter as RateLimiterType,
} from "@/server/rate-limit/rate-limit";
import type { RateLimitStore } from "@/server/rate-limit/rate-limit-store";
import type { AiGatewayError as AiGatewayErrorType } from "./errors";
import type { LogRecord } from "@/lib/telemetry/logger";

/**
 * ATL-048 — the AI gateway, against a mocked provider.
 *
 * Named `*.integration.test.ts` so it runs in the `server` project: `gateway.ts`
 * imports `server-only`, which throws under every export condition except
 * `react-server`. No network and no database are involved — the provider is a
 * stub and the rate-limit store is in memory.
 *
 * The provider stub is the whole point of the port. `gateway.ts` imports no SDK,
 * so nothing here needs a key, a fixture server, or a vendor error class.
 *
 * ## Why the environment is mocked
 *
 * `gateway.ts` deliberately does not import `@/config/env`, but it does import
 * the rate limiter, and `rate-limit.ts` reads env at module load for its
 * `create()` factory. That validates the *entire* environment on import and
 * kills the suite before a single test runs. Mocking env with only the keys the
 * limiter reads is the pattern `rate-limit.integration.test.ts` already
 * established for exactly this; a second idiom here would be worse than reusing
 * a working one.
 */

const HMAC_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

vi.mock("@/config/env", () => ({
  env: {
    AUDIT_HMAC_KEY: HMAC_KEY_B64,
    RATE_LIMIT_REDIS_URL: "https://counter.example.test",
    RATE_LIMIT_REDIS_TOKEN: "test-token",
  },
}));

const { AI_GATEWAY_CONFIG, AiProviderGateway } = await import("./gateway");
const { AiGatewayError } = await import("./errors");
const { RateLimiter, RATE_LIMIT_POLICIES } = await import("@/server/rate-limit/rate-limit");
const { createMemoryRateLimitStore, RateLimitStoreUnavailableError } =
  await import("@/server/rate-limit/rate-limit-store");
const { logger, setLogSink } = await import("@/lib/telemetry/logger");

const HMAC_KEY = Buffer.from(HMAC_KEY_B64, "base64");

const request: AiCompletionRequest = {
  userId: "user-1",
  system: "You are Atlas.",
  messages: [{ role: "user", content: "Explain this finding." }],
};

/** A limiter that always allows: most tests are not about rate limiting. */
const openLimiter = () => new RateLimiter({ store: null, hmacKey: HMAC_KEY, enabled: false });

/** Resolves with fixed text, and records what it was asked for. */
function respondingClient(text: string): AiProviderClient & { calls: ProviderCallInput[] } {
  const calls: ProviderCallInput[] = [];
  return {
    calls,
    send: (input) => {
      calls.push(input);
      return Promise.resolve({ text });
    },
  };
}

/** Fails every time with the given status. */
function failingClient(
  status: number | undefined,
  message = "provider detail",
): AiProviderClient & {
  attempts: number;
} {
  const client = {
    attempts: 0,
    send: () => {
      client.attempts += 1;
      const error =
        status === undefined ? new Error(message) : Object.assign(new Error(message), { status });
      return Promise.reject(error);
    },
  };
  return client;
}

const gatewayWith = (client: AiProviderClient, limiter: RateLimiterType = openLimiter()) =>
  new AiProviderGateway({
    client,
    limiter,
    // Backoff is asserted, never waited for.
    sleep: () => Promise.resolve(),
    random: () => 1,
  } satisfies AiGatewayDeps);

let logs: LogRecord[] = [];
let restoreSink: (record: LogRecord) => void;

beforeEach(() => {
  logs = [];
  restoreSink = setLogSink((record) => logs.push(record));
});

afterEach(() => {
  setLogSink(restoreSink);
  vi.useRealTimers();
});

describe("a successful call", () => {
  it("returns the provider text unchanged", async () => {
    const result = await gatewayWith(respondingClient("Here is why.")).complete(request);

    expect(result.text).toBe("Here is why.");
    expect(result.attempts).toBe(1);
  });

  it("reports the model it actually used", async () => {
    // `ai_interactions.model` is meant to record what generated the output, not
    // what a caller hoped would.
    const result = await gatewayWith(respondingClient("ok")).complete(request);

    expect(result.model).toBe(AI_GATEWAY_CONFIG.model);
  });

  it("sends the centrally defined generation settings, not caller-supplied ones", async () => {
    // B5: callers supply content; the gateway supplies how it is generated.
    const client = respondingClient("ok");
    await gatewayWith(client).complete(request);

    expect(client.calls[0]).toMatchObject({
      model: AI_GATEWAY_CONFIG.model,
      maxTokens: AI_GATEWAY_CONFIG.maxOutputTokens,
      temperature: AI_GATEWAY_CONFIG.temperature,
      system: request.system,
      messages: request.messages,
    });
  });

  it("never sends the user id to the provider", async () => {
    /**
     * It is the rate-limit key and nothing else. Security §10 prohibits
     * unrelated user records reaching the provider, and an account identifier
     * is exactly that.
     */
    const client = respondingClient("ok");
    await gatewayWith(client).complete(request);

    expect(JSON.stringify(client.calls[0])).not.toContain(request.userId);
  });

  it("logs nothing on the happy path", async () => {
    await gatewayWith(respondingClient("ok")).complete(request);

    expect(logs).toEqual([]);
  });
});

describe("retry is bounded and selective", () => {
  it("retries a 5xx exactly once, for two attempts in total", async () => {
    const client = failingClient(503);

    await expect(gatewayWith(client).complete(request)).rejects.toBeInstanceOf(AiGatewayError);

    expect(client.attempts).toBe(2);
    expect(AI_GATEWAY_CONFIG.maxAttempts).toBe(2);
  });

  it("retries a 429 from the provider", async () => {
    const client = failingClient(429);

    await expect(gatewayWith(client).complete(request)).rejects.toMatchObject({
      kind: "provider_overloaded",
      attempts: 2,
    });
  });

  it("retries a transport failure that carries no status", async () => {
    const client = failingClient(undefined);

    await expect(gatewayWith(client).complete(request)).rejects.toMatchObject({
      kind: "provider_unavailable",
      attempts: 2,
    });
  });

  it("never retries a 4xx that is not 429", async () => {
    // The sharpest waste case: a 401 will fail identically the second time.
    for (const status of [400, 401, 403, 404, 422]) {
      const client = failingClient(status);

      await expect(gatewayWith(client).complete(request)).rejects.toMatchObject({
        kind: "provider_rejected",
        attempts: 1,
      });
      expect(client.attempts).toBe(1);
    }
  });

  it("succeeds on the retry when the first attempt was transient", async () => {
    let calls = 0;
    const client: AiProviderClient = {
      send: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(Object.assign(new Error("blip"), { status: 500 }))
          : Promise.resolve({ text: "recovered" });
      },
    };

    const result = await gatewayWith(client).complete(request);

    expect(result.text).toBe("recovered");
    expect(result.attempts).toBe(2);
  });

  it("waits between attempts, with jitter applied to an exponential base", async () => {
    /**
     * `random: () => 1` makes full jitter resolve to its ceiling, so the value is
     * assertable. Jitter is not decoration: without it every client that failed
     * against one provider incident retries at the same instant, and the storm
     * lands when the provider is least able to absorb it.
     */
    const waits: number[] = [];
    const gateway = new AiProviderGateway({
      client: failingClient(500),
      limiter: openLimiter(),
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      random: () => 1,
    });

    await expect(gateway.complete(request)).rejects.toBeInstanceOf(AiGatewayError);

    expect(waits).toEqual([AI_GATEWAY_CONFIG.backoffBaseMs]);
  });

  it("scales the wait by the random draw", async () => {
    const waits: number[] = [];
    const gateway = new AiProviderGateway({
      client: failingClient(500),
      limiter: openLimiter(),
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    });

    await expect(gateway.complete(request)).rejects.toBeInstanceOf(AiGatewayError);

    expect(waits).toEqual([AI_GATEWAY_CONFIG.backoffBaseMs / 2]);
  });
});

describe("the timeout is the gateway's own", () => {
  it("aborts the attempt and maps it to a timeout", async () => {
    vi.useFakeTimers();

    // Rejects when aborted, as a real client does.
    const client: AiProviderClient = {
      send: (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };

    const promise = gatewayWith(client).complete(request);
    const assertion = expect(promise).rejects.toMatchObject({ kind: "timeout", attempts: 2 });

    // Two attempts, each with its own 30-second deadline.
    await vi.advanceTimersByTimeAsync(AI_GATEWAY_CONFIG.timeoutMs);
    await vi.advanceTimersByTimeAsync(AI_GATEWAY_CONFIG.timeoutMs);

    await assertion;
  });

  it("passes an abort signal the provider can honour", async () => {
    let received: AbortSignal | undefined;
    const client: AiProviderClient = {
      send: (_input, signal) => {
        received = signal;
        return Promise.resolve({ text: "ok" });
      },
    };

    await gatewayWith(client).complete(request);

    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
  });

  it("holds the deadline at 30 seconds", () => {
    // B2. Asserted as a constant because the behavioural test above can only
    // prove that *some* deadline fired.
    expect(AI_GATEWAY_CONFIG.timeoutMs).toBe(30_000);
  });
});

describe("an empty completion is a failure, not an empty success", () => {
  it("rejects whitespace-only output without retrying", async () => {
    // A caller that received "" would render a blank explanation and call it an
    // answer.
    const client = respondingClient("   ");

    await expect(gatewayWith(client).complete(request)).rejects.toMatchObject({
      kind: "malformed_response",
    });
    expect(client.calls).toHaveLength(1);
  });
});

describe("no provider prose escapes", () => {
  const PROVIDER_DETAIL = "internal-provider-detail-xyz";

  it("is absent from the thrown error", async () => {
    const client = failingClient(500, PROVIDER_DETAIL);

    const error = await gatewayWith(client)
      .complete(request)
      .catch((caught: unknown) => caught);

    expect(JSON.stringify({ error, message: (error as Error).message })).not.toContain(
      PROVIDER_DETAIL,
    );
  });

  it("is absent from every log line", async () => {
    const client = failingClient(500, PROVIDER_DETAIL);

    await gatewayWith(client)
      .complete(request)
      .catch(() => undefined);

    expect(JSON.stringify(logs)).not.toContain(PROVIDER_DETAIL);
  });

  it("records the internal code and the provider status as numbers", async () => {
    await gatewayWith(failingClient(503))
      .complete(request)
      .catch(() => undefined);

    expect(logs.at(-1)).toMatchObject({
      event: "ai.provider_failure",
      errorCode: "PROVIDER_UNAVAILABLE",
      provider: "anthropic",
      providerAvailable: false,
      status: 503,
    });
  });

  it("drops a prompt-shaped field rather than logging it", () => {
    /**
     * The structural guarantee behind "prompts and completions are never
     * logged": `LOG_FIELD_POLICY` is an allowlist, so an unlisted key cannot
     * reach a sink even if some future caller passes one.
     */
    logger.error("ai.provider_failure", {
      operation: "ai.complete",
      prompt: "the user's private asset text",
    } as never);

    expect(JSON.stringify(logs)).not.toContain("private asset text");
  });
});

describe("rate limiting is enforced inside the gateway", () => {
  const limiterWith = (store: RateLimitStore): RateLimiterType =>
    new RateLimiter({ store, hmacKey: HMAC_KEY, enabled: true });

  const exhaust = async (limiter: RateLimiterType, policy: RateLimitPolicy) => {
    for (let index = 0; index < policy.max; index++) {
      await limiter.check(policy, [{ kind: "user", value: request.userId }]);
    }
  };

  it("denies once the per-user window is exhausted", async () => {
    const limiter = limiterWith(createMemoryRateLimitStore());
    await exhaust(limiter, RATE_LIMIT_POLICIES.aiRequest);

    const client = respondingClient("ok");
    await expect(gatewayWith(client, limiter).complete(request)).rejects.toMatchObject({
      kind: "rate_limited",
    });

    // Denied before the provider was ever called — the point of checking first.
    expect(client.calls).toHaveLength(0);
  });

  it("carries the retry-after seconds so a caller can build a correct 429", async () => {
    const limiter = limiterWith(createMemoryRateLimitStore());
    await exhaust(limiter, RATE_LIMIT_POLICIES.aiRequest);

    const error = (await gatewayWith(respondingClient("ok"), limiter)
      .complete(request)
      .catch((caught: unknown) => caught)) as AiGatewayErrorType;

    expect(error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keys the limit on the user and nobody else", async () => {
    // B1: per-user only. A second user must be unaffected by the first's usage.
    const limiter = limiterWith(createMemoryRateLimitStore());
    await exhaust(limiter, RATE_LIMIT_POLICIES.aiRequest);

    const result = await gatewayWith(respondingClient("ok"), limiter).complete({
      ...request,
      userId: "user-2",
    });

    expect(result.text).toBe("ok");
  });

  it("fails open when the counter store is unreachable, and says so", async () => {
    /**
     * B1: matches every other surface. The trade is deliberate — an unreachable
     * counter store would otherwise take the assistant down for everyone — and
     * the degradation is logged so it is visible rather than silent.
     */
    const brokenStore: RateLimitStore = {
      increment: () => Promise.reject(new RateLimitStoreUnavailableError()),
    };

    const result = await gatewayWith(respondingClient("ok"), limiterWith(brokenStore)).complete(
      request,
    );

    expect(result.text).toBe("ok");
    expect(logs.map((record) => record.event)).toContain("ai.ratelimit_degraded");
  });

  it("never logs the user identifier", async () => {
    const brokenStore: RateLimitStore = {
      increment: () => Promise.reject(new RateLimitStoreUnavailableError()),
    };

    await gatewayWith(respondingClient("ok"), limiterWith(brokenStore)).complete(request);

    // The value the limiter's HMAC exists to keep out of lower-trust sinks.
    expect(JSON.stringify(logs)).not.toContain(request.userId);
  });
});
