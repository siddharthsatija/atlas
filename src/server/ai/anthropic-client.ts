import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/config/env";
import { RateLimiter } from "@/server/rate-limit/rate-limit";
import { AiProviderGateway, type AiProviderClient, type ProviderCallInput } from "./gateway";

/**
 * The Anthropic adapter (ATL-048). **The only module in Atlas that names a
 * vendor.**
 *
 * Kept apart from `gateway.ts` so the retry, timeout and classification logic
 * can be unit-tested against a mock with no SDK in the graph at all, and so that
 * adding a second provider is a new file rather than a rewrite of the logic that
 * every AI surface depends on.
 *
 * ## The SDK's own retries are switched off, deliberately
 *
 * `@anthropic-ai/sdk` defaults to `maxRetries: 2` and a **ten-minute** timeout.
 * Left alone, those compose with the gateway's own policy rather than replacing
 * it: two gateway attempts, each internally retried twice, is up to six provider
 * calls per request — six times the spend, under exactly the outage conditions
 * that produced the failure — and the gateway's 30-second deadline would be the
 * only thing bounding a request the SDK was prepared to wait ten minutes for.
 *
 * So retries are disabled here and owned there, where they are bounded, jittered
 * and asserted by tests. `timeout` is left at the SDK default because the
 * gateway's `AbortSignal` is the real deadline; two competing timers would make
 * whichever fired first arbitrary.
 *
 * ## Data retention (B3, security §10)
 *
 * "Provider data-retention settings configured to the strongest available mode"
 * is an **operational** requirement, not a code one. Version 0.115.0 of the SDK
 * exposes no request-level retention parameter — verified by inspection of the
 * message parameter types — so there is nothing honest to send per call, and
 * inventing a field would produce a control that looks enforced and is not.
 *
 * It is configured on the Anthropic organisation and recorded as a production
 * prerequisite in architecture §12. A comment is not the control; the
 * documented deployment step is.
 */

/** Wraps the SDK behind the vendor-neutral port. */
export function createAnthropicClient(): AiProviderClient {
  const anthropic = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Retry policy belongs to the gateway. See the note above.
    maxRetries: 0,
  });

  return {
    async send(input: ProviderCallInput, signal: AbortSignal): Promise<{ text: string }> {
      const message = await anthropic.messages.create(
        {
          model: input.model,
          system: input.system,
          messages: input.messages.map((entry) => ({
            role: entry.role,
            content: entry.content,
          })),
          max_tokens: input.maxTokens,
          temperature: input.temperature,
        },
        { signal },
      );

      /**
       * Text blocks only, concatenated.
       *
       * No tools are exposed to the model (AI behavior §10), so any non-text
       * block is something Atlas did not ask for and has no meaning for. It is
       * dropped rather than rendered; an empty result then fails as
       * `malformed_response` in the gateway rather than surfacing as a blank
       * answer.
       */
      const text = message.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");

      return { text };
    },
  };
}

/**
 * The production gateway.
 *
 * Built here rather than in `gateway.ts` so that module stays free of both the
 * SDK and `@/config/env` — the latter validates at import time, which would make
 * every gateway unit test depend on a fully configured environment.
 */
export function createAiGateway(): AiProviderGateway {
  return new AiProviderGateway({
    client: createAnthropicClient(),
    limiter: RateLimiter.create(),
  });
}
