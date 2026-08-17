import "server-only";

import { logger } from "@/lib/telemetry/logger";
import { PrivacyScoreService } from "./privacy-score-service";

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
  reason:
    | "asset.created"
    | "asset.updated"
    | "asset.archived"
    | "asset.restored"
    | "asset.deleted"
    /**
     * A finding opened or auto-resolved (ATL-101). §11.2 lists "finding state
     * changes" among the recalculation triggers; the vocabulary predates
     * findings existing, so this is the value that trigger needed.
     */
    | "finding.changed";
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

/**
 * The real implementation (ATL-045).
 *
 * Recalculates in-process: `enqueue` computes the user's score and records a
 * snapshot **only if it changed**, returning when that is done. No queue table,
 * no runner, no transport — none is specified anywhere, and ATL-101 answered the
 * same question the same way for the findings engine.
 *
 * That is safe here for the same reason it was safe there, and a stronger one:
 * the calculation is a pure function of the user's records, so a duplicate call
 * computes an identical result and the write-on-change rule turns it into a
 * no-op. Running twice cannot produce two rows for one change.
 *
 * The honest cost: this runs inside the request that mutated the record — four
 * reads plus, at most, one insert. Every call site already wraps `enqueue` in
 * its own try/catch and logs `score.recalculation_enqueue_failed`, so a failure
 * here degrades to a stale score rather than a failed mutation. That is
 * deliberate: a user's edit must not be lost because a derived number could not
 * be updated.
 *
 * When a scheduling ticket introduces a real transport, this class becomes its
 * producer and no call site changes.
 */
export class SnapshotScoreRecalculationQueue implements ScoreRecalculationQueue {
  private readonly score: PrivacyScoreService;

  constructor(score: PrivacyScoreService) {
    this.score = score;
  }

  static create(): SnapshotScoreRecalculationQueue {
    return new SnapshotScoreRecalculationQueue(PrivacyScoreService.create());
  }

  async enqueue(request: ScoreRecalculationRequest): Promise<void> {
    const result = await this.score.createSnapshot(request.userId, request.reason);

    /**
     * Reported rather than thrown. The caller's catch already keeps the user's
     * mutation intact, and §14 requires jobs to be observable — a recalculation
     * that failed silently is exactly what someone would look for when a score
     * stops moving. No user id and no score value: architecture §10.
     */
    if (!result.ok) {
      logger.error("score.recalculation_failed", {
        operation: request.reason,
        provider: "database",
        providerAvailable: false,
      });
    }
  }
}
