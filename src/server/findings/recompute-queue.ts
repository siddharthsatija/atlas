import "server-only";

import { logger } from "@/lib/telemetry/logger";

/**
 * The findings-recompute seam (ATL-030, architecture §11 and §14).
 *
 * §11: "mutations to assets, permissions, data categories, or requests enqueue a
 * per-user recompute job". §14 lists that job among the MVP background jobs and
 * requires jobs to be idempotent and observable. **ATL-101 owns the job itself**;
 * ATL-030's acceptance criterion is only that mutations enqueue it, explicitly
 * "no-op until ATL-101".
 *
 * ## Why an interface and not a table
 *
 * No queue table, runner, or transport is specified anywhere in the
 * documentation — §7 has no jobs table and §14 names the jobs without saying how
 * they are dispatched. Inventing durable infrastructure here would be an
 * architectural decision this ticket has no mandate to make, and ATL-101 would
 * likely have to replace it.
 *
 * So this is a seam: a named interface with a no-op default, injected exactly as
 * `ConsentService` and `ActivityWriter` are injected into `OnboardingService`.
 * ATL-101 substitutes a real implementation and every call site here already
 * points at it. The value of shipping it now is that the *call sites* are
 * correct — finding every mutation that should trigger a recompute is much
 * harder later than writing them down as they are built.
 */

export interface RecomputeRequest {
  userId: string;
  /**
   * What changed. Not used by the no-op, but ATL-101's engine can narrow which
   * rules to evaluate rather than re-running all eight.
   */
  reason: "asset.created" | "asset.updated" | "asset.archived" | "asset.restored" | "asset.deleted";
}

export interface FindingsRecomputeQueue {
  enqueue(request: RecomputeRequest): Promise<void>;
}

/**
 * The default until ATL-101 lands.
 *
 * Records at debug level rather than doing nothing silently. §14 requires jobs
 * to be observable, and a recompute that was requested and dropped is exactly
 * the thing a reader of the logs would want to see once findings exist and a
 * score fails to move.
 *
 * No asset id is logged — architecture §10: "avoid exposing internal record
 * identifiers in logs". The user is identified only by the reason for the
 * recompute, which carries no identity at all.
 */
export class NoopFindingsRecomputeQueue implements FindingsRecomputeQueue {
  enqueue(request: RecomputeRequest): Promise<void> {
    logger.debug("findings.recompute_skipped", {
      operation: request.reason,
      provider: "findings",
      providerAvailable: false,
    });
    return Promise.resolve();
  }
}
