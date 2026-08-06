import "server-only";

import { logger } from "@/lib/telemetry/logger";

/**
 * The privacy-score recalculation seam (ATL-032, ADR-004, architecture §11.2
 * and §14).
 *
 * ## Why this is separate from the findings seam
 *
 * §14 lists them as two jobs — "Per-user findings recompute after relevant
 * mutations" and "Recalculate score after relevant events" — and ADR-004 gives
 * score recalculation its own trigger list. They are also not the same event: a
 * finding being dismissed recalculates the score without recomputing findings,
 * and ADR-004 requires a snapshot only "when the score or factor breakdown
 * changes", which is a decision the score owns.
 *
 * Collapsing them into one queue now would be a guess about ATL-039's design
 * that costs nothing to avoid.
 *
 * ## Why a no-op
 *
 * There is no score module, no `privacy_score_snapshots` table, and no job
 * transport specified anywhere — §14 names the jobs without saying how they are
 * dispatched. **ATL-039 onwards owns the score itself.** What shipping the seam
 * buys is that the *call sites* are already right: finding every mutation that
 * should move a user's score is far harder to do later than to write down as
 * each mutation is built.
 *
 * Same shape as `FindingsRecomputeQueue` (ATL-030), deliberately — one pattern
 * for both, so a reader who understands one understands the other.
 */

export interface ScoreRecalculationRequest {
  userId: string;
  /**
   * What moved. Unused by the no-op, but ADR-004's factors are independent, so
   * a real implementation can recompute only the affected one rather than all
   * six.
   */
  reason: "asset.created" | "asset.updated" | "asset.archived" | "asset.restored" | "asset.deleted";
}

export interface ScoreRecalculationQueue {
  enqueue(request: ScoreRecalculationRequest): Promise<void>;
}

/**
 * The default until ATL-039 lands.
 *
 * Logged at debug rather than silent: §14 requires jobs to be observable, and a
 * recalculation that was asked for and dropped is precisely what someone would
 * look for when a score fails to move after a change that should have moved it.
 *
 * No asset id (architecture §10: "avoid exposing internal record identifiers in
 * logs") and no score value, because there is none yet.
 */
export class NoopScoreRecalculationQueue implements ScoreRecalculationQueue {
  enqueue(request: ScoreRecalculationRequest): Promise<void> {
    logger.debug("score.recalculation_skipped", {
      operation: request.reason,
      provider: "score",
      providerAvailable: false,
    });
    return Promise.resolve();
  }
}
