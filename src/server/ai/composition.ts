import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/config/env";
import type { Database } from "@/types/database.generated";
import { ConsentService } from "@/server/consent/consent-service";
import { FindingService } from "@/server/findings/finding-service";
import { AssetService } from "@/server/assets/asset-service";
import { AiInteractionRepository } from "@/server/repositories/ai-interaction-repository";
import { createAiGateway } from "./anthropic-client";
import { PersistentInteractionRecorder } from "./interaction-recorder";
import { StructuredCompletionService } from "./structured-completion";
import { outageFallbackProvider } from "./fallback/fallback-provider";
import { AiPolicyService } from "./policy/ai-policy-service";
import { AiHistoryService } from "./history/ai-history-service";

/**
 * Production wiring for the AI subsystem (ATL-052).
 *
 * One place where the real gateway, the real recorder, the real fallback and the
 * `AI_ENABLED` flag are bound together — so a caller cannot assemble a policy
 * layer that is missing one of them. ATL-045 taught this lesson the expensive
 * way: an inline construction defaulted the score seam to a no-op and the
 * production path silently recorded nothing.
 *
 * This module is the only place outside the vendor adapter that reads
 * `@/config/env`, which keeps every other AI module testable without a fully
 * configured environment.
 */
export function createAiPolicyService(db: SupabaseClient<Database>): AiPolicyService {
  const completion = new StructuredCompletionService({
    gateway: createAiGateway(),
    /** ATL-052: deterministic content on every failure path. */
    fallback: outageFallbackProvider,
    recorder: new PersistentInteractionRecorder(new AiInteractionRepository(db)),
  });

  return new AiPolicyService({
    consent: new ConsentService(db),
    findings: new FindingService(db),
    /** ATL-054's asset reads, wired here for the same reason everything else is. */
    assets: new AssetService(db),
    completion,
    recorder: new PersistentInteractionRecorder(new AiInteractionRepository(db)),
    /**
     * Conversation history (ATL-109), bound here for the reason this module's
     * header gives.
     *
     * The policy layer defaults this to a no-op so its tests need no consent
     * service, which means an unwired production path would store nothing and
     * report nothing — the ATL-045 failure the header describes, repeated. It is
     * wired here so the only way to get history is to have consented, not to
     * have remembered.
     *
     * Storing remains off for everyone until `ai_conversation_history` consent
     * exists, which the service checks on every call. The toggle that grants it
     * is ATL-076.
     */
    history: AiHistoryService.create(db),
    /**
     * The kill switch. Read once here rather than inside the policy layer, so
     * the layer stays free of `@/config/env` and its tests need no environment.
     */
    aiEnabled: env.AI_ENABLED,
  });
}
