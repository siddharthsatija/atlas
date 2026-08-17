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
     * The kill switch. Read once here rather than inside the policy layer, so
     * the layer stays free of `@/config/env` and its tests need no environment.
     */
    aiEnabled: env.AI_ENABLED,
  });
}
