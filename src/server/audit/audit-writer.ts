import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { logger } from "@/lib/telemetry/logger";
import {
  AuditChainConflictError,
  AuditEventRepository,
  type StoredAuditEvent,
} from "@/server/repositories/audit-event-repository";
import { GENESIS_HASH, buildAuditEvent, subjectRefFor, type AuditEventInput } from "./audit-event";
import { ActivityWriter, type ActivityInput } from "@/server/activity/activity-writer";
import type { ActivityEventRecord } from "@/server/repositories/activity-event-repository";

/**
 * The audit writer and the shared emitter (ATL-103, ADR-006).
 *
 * The **only** module that writes `audit_events`. Everything that makes an event
 * trustworthy — pseudonymisation, the context allowlist, the hash chain — is
 * applied here, so no caller can skip a step by constructing a row itself.
 *
 * ## Concurrency
 *
 * Appending is read-then-write: take the subject's latest `event_hash`, claim it
 * as `prev_hash`. Two concurrent writers for the same subject read the same tail
 * and both try to claim it. The `(subject_ref, prev_hash)` unique index turns
 * that into a unique violation for the loser, which retries against the new
 * tail. Without the index both would succeed and the chain would fork silently —
 * and a fork is indistinguishable from the branch a tamperer would create.
 *
 * Retries are bounded. Under sustained contention the write fails loudly rather
 * than looping, because a hung request is a worse outcome than a failed audit
 * write that the caller can see and handle.
 */

/** Bounded because contention should degrade into an error, not a hang. */
const MAX_APPEND_ATTEMPTS = 5;

export interface EmitResult {
  event: StoredAuditEvent;
  droppedKeys: string[];
  redactedKeys: string[];
}

export class AuditWriter {
  private readonly events: AuditEventRepository;

  constructor(db: SupabaseClient<Database>) {
    this.events = new AuditEventRepository(db);
  }

  /** Uses the service-role client — the only role that can reach the table. */
  static create(): AuditWriter {
    return new AuditWriter(createServiceRoleClient());
  }

  /**
   * Appends one audit event, retrying on chain contention.
   *
   * Throws on failure rather than swallowing. An audit record that silently did
   * not happen is worse than a visible error: the entire value of the log is
   * that its absence means the event did not occur. Callers that genuinely
   * cannot fail — a best-effort background job — opt out explicitly via
   * `tryWrite`, which makes the decision visible at the call site.
   */
  async write(input: AuditEventInput): Promise<EmitResult> {
    const subjectRef = subjectRefFor(input.userId);
    let lastConflict: unknown;

    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
      // Re-read the tail on every attempt. A retry that reused the stale tail
      // would claim the same link again and conflict forever.
      const latest = await this.events.findLatestForSubject(subjectRef);
      const prevHash = latest?.eventHash ?? GENESIS_HASH;

      const { record, droppedKeys, redactedKeys } = buildAuditEvent(input, prevHash);

      try {
        const event = await this.events.append(record);

        // ADR-006: "unknown keys are dropped and counted as a telemetry
        // warning". Counted, never echoed — the key NAMES are logged, never the
        // values, because a dropped value is dropped precisely because it was
        // not safe to keep.
        if (droppedKeys.length > 0 || redactedKeys.length > 0) {
          logger.warn("audit.context_filtered", {
            operation: "audit.write",
            count: droppedKeys.length + redactedKeys.length,
          });
        }

        return { event, droppedKeys, redactedKeys };
      } catch (error) {
        if (!(error instanceof AuditChainConflictError)) throw error;
        lastConflict = error;
      }
    }

    throw lastConflict;
  }

  /**
   * Best-effort append. Returns null instead of throwing.
   *
   * Deliberately a separate method rather than a flag on `write`: swallowing an
   * audit failure is a decision that should be legible in the calling code, not
   * hidden in an options object.
   */
  async tryWrite(input: AuditEventInput): Promise<EmitResult | null> {
    try {
      return await this.write(input);
    } catch {
      logger.error("audit.write_failed", { operation: "audit.write" });
      return null;
    }
  }
}

/**
 * The shared activity + audit emitter (ADR-006, completed by ATL-069).
 *
 * ADR-006 requires user-facing activity and internal audit to be written "from a
 * single call site so the two cannot drift". This is that call site, and both
 * halves are now implemented.
 *
 * ## Ordering, and why it is not atomic
 *
 * PostgREST cannot open a transaction, so these are two independent inserts and
 * a partial failure is unavoidable rather than a bug to be fixed. The ordering
 * is therefore the design:
 *
 *  1. **Audit first, and its failure propagates.** ATL-103 makes an audit write
 *     fail loudly because the whole value of the log is that its absence means
 *     the event did not occur.
 *  2. **Activity second, best effort.** A missing timeline row is a cosmetic gap
 *     the user might notice. Failing a completed asset creation because the
 *     timeline insert failed would turn a display problem into a data problem,
 *     and a timeline outage would take the product down.
 *
 * The failure is logged at error level with a count, so "best effort" means
 * *observably* best effort rather than silently.
 *
 * `activity` is optional: some audited events — DEK destruction, operator
 * elevation — are security records with no user-facing counterpart. Omitting it
 * is a deliberate statement, not a default.
 */
export interface EmitEventInput {
  audit: AuditEventInput;
  activity?: ActivityInput;
}

export interface EmitEventResult extends EmitResult {
  /** Null when no activity was requested, or when its write failed. */
  activity: ActivityEventRecord | null;
}

export async function emitEvent(
  input: EmitEventInput,
  writer: AuditWriter = AuditWriter.create(),
  activityWriter?: ActivityWriter,
): Promise<EmitEventResult> {
  const audited = await writer.write(input.audit);

  if (!input.activity) return { ...audited, activity: null };

  try {
    const activity = await (activityWriter ?? ActivityWriter.create()).write(input.activity);
    return { ...audited, activity };
  } catch {
    /**
     * The audit record already exists, so the event *is* recorded — just not on
     * the user's timeline. Reporting the gap is what keeps this honest; the
     * event name and count carry no personal data.
     */
    logger.error("activity.write_failed", { operation: "activity.emit", count: 1 });
    return { ...audited, activity: null };
  }
}
