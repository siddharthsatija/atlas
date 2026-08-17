import "server-only";
import { logger } from "@/lib/telemetry/logger";
import type { AiInteractionStatus, InputClassification } from "@/lib/ai/interaction-vocabulary";
import type { AiInteractionRepository } from "@/server/repositories/ai-interaction-repository";

/**
 * The interaction-recording seam (task #95).
 *
 * The same shape ATL-045 established with `NoopScoreRecalculationQueue` and
 * ATL-050 with `unavailableFallback`: an interface with an inert default, so a
 * caller can be wired for recording without acquiring a database dependency it
 * does not otherwise need.
 *
 * That matters here specifically. `StructuredCompletionService` is pure
 * orchestration over a gateway and a validator; giving it a repository would
 * mean every one of its tests needed a database, and the module that decides
 * whether output is trustworthy would suddenly also own persistence.
 *
 * ## Recording never fails the interaction
 *
 * If the row cannot be written, the user still gets their answer. Losing a
 * metadata row is a real loss — it is disclosure and audit evidence — but
 * refusing to return a validated explanation because a bookkeeping insert failed
 * would trade a working product for a complete ledger. The failure is logged so
 * it is visible rather than silent.
 */

export interface InteractionRecord {
  userId: string;
  purpose: string;
  model: string;
  promptVersion: number;
  policyVersion: number;
  /** Sensitivity of the context sent (ATL-049). Absent when nothing built it. */
  inputClassification?: InputClassification | undefined;
  /** Entity IDs that were in the context sent to the provider. */
  recordsReferenced: string[];
  outputSchemaVersion: number;
  status: AiInteractionStatus;
  latencyMs: number;
}

export interface AiInteractionRecorder {
  /**
   * Records the interaction and returns the row's id (task #109).
   *
   * `null` means **no row exists to reference** — either nothing was written
   * (the inert recorder) or the insert failed. Both are the same fact to a
   * caller: there is nothing for feedback to attach to. The id originates in
   * Postgres, so minting one here before the insert would be a claim about a row
   * that might never exist.
   *
   * `string | null` rather than `string | undefined` because "no row" is a real
   * outcome rather than an absent value.
   */
  record(interaction: InteractionRecord): Promise<string | null>;
}

/**
 * Records nothing.
 *
 * The default, so ATL-050's service works unchanged wherever persistence is not
 * wired — tests, and any caller that has not yet been given a repository.
 */
export const noopInteractionRecorder: AiInteractionRecorder = {
  record: () => Promise.resolve(null),
};

/** Writes through the repository, absorbing storage failures. */
export class PersistentInteractionRecorder implements AiInteractionRecorder {
  private readonly repository: AiInteractionRepository;

  constructor(repository: AiInteractionRepository) {
    this.repository = repository;
  }

  async record(interaction: InteractionRecord): Promise<string | null> {
    try {
      /**
       * The repository already returns the inserted row; before task #109 the
       * id was discarded here. Returning it is what lets ATL-053 attach feedback
       * to the interaction the user is looking at.
       */
      const recorded = await this.repository.record(interaction);
      return recorded.id;
    } catch {
      /**
       * Swallowed deliberately, and logged. The caller's interaction succeeded
       * or failed on its own merits; this is bookkeeping. Only allowlisted
       * fields are logged, so no identifier from `recordsReferenced` and nothing
       * about the interaction's content can travel to a log sink.
       */
      logger.error("ai.interaction_record_failed", {
        operation: "ai.record_interaction",
        provider: "database",
        providerAvailable: false,
      });

      /**
       * No row, so no id. Surfacing one here would let a caller offer feedback
       * against an interaction that was never recorded, and `recordFeedback`
       * would silently match nothing.
       */
      return null;
    }
  }
}
