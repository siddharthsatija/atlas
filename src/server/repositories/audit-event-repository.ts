import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { AuditEventRecord, AuditEventType, ActorType } from "@/server/audit/audit-event";

/**
 * Data access for `audit_events` (ATL-103, ADR-006).
 *
 * Requires the service-role client: the table has RLS enabled with no policies,
 * so no other role can reach it at all. The grant itself withholds UPDATE and
 * DELETE, so this class deliberately exposes **no** mutation or removal method —
 * there is no code path to write, because there is no method to call.
 */

export type AuditRow = Database["public"]["Tables"]["audit_events"]["Row"];

/** A stored event as this layer exposes it. */
export interface StoredAuditEvent extends AuditEventRecord {
  id: string;
}

function toRecord(row: AuditRow): StoredAuditEvent {
  return {
    id: row.id,
    eventType: row.event_type as AuditEventType,
    subjectRef: row.subject_ref,
    actorType: row.actor_type as ActorType,
    entityType: row.entity_type,
    entityId: row.entity_id,
    context: (row.context_json ?? {}) as Record<string, unknown>,
    occurredAt: row.occurred_at,
    prevHash: row.prev_hash,
    eventHash: row.event_hash,
  };
}

/** Raised when the chain link is already taken — a concurrent writer won. */
export class AuditChainConflictError extends Error {
  constructor() {
    super("audit chain link already claimed");
    this.name = "AuditChainConflictError";
  }
}

/** Raised for any other audit storage failure. Carries no database detail. */
export class AuditWriteError extends Error {
  constructor() {
    super("audit event could not be written");
    this.name = "AuditWriteError";
  }
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

export class AuditEventRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * The subject's most recent event, used as the next event's `prev_hash`.
   *
   * Ordered by `occurred_at` then `id` so the result is total rather than
   * merely usually-deterministic: two events can share a timestamp at
   * millisecond resolution, and an unstable tail would produce a chain that
   * verifies differently on different reads.
   */
  async findLatestForSubject(subjectRef: string): Promise<StoredAuditEvent | null> {
    const { data, error } = await this.db
      .from("audit_events")
      .select("*")
      .eq("subject_ref", subjectRef)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1);

    if (error) throw new AuditWriteError();
    const row = (data ?? [])[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Appends one event.
   *
   * A unique violation is surfaced as `AuditChainConflictError` rather than a
   * generic failure, because it is the one error the caller can act on: it means
   * a concurrent writer claimed the same chain link, and the correct response is
   * to re-read the tail and retry, not to give up.
   */
  async append(record: AuditEventRecord): Promise<StoredAuditEvent> {
    const { data, error } = await this.db
      .from("audit_events")
      .insert({
        event_type: record.eventType,
        subject_ref: record.subjectRef,
        actor_type: record.actorType,
        entity_type: record.entityType,
        entity_id: record.entityId,
        context_json: record.context as never,
        occurred_at: record.occurredAt,
        prev_hash: record.prevHash,
        event_hash: record.eventHash,
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION) throw new AuditChainConflictError();
      throw new AuditWriteError();
    }
    if (!data) throw new AuditWriteError();

    return toRecord(data);
  }

  /**
   * Every event for one subject in chain order.
   *
   * Verification needs the whole chain: a gap in the middle is exactly what the
   * chain exists to reveal, so this deliberately does not paginate by default.
   */
  async listForSubject(subjectRef: string, limit = 10_000): Promise<StoredAuditEvent[]> {
    const { data, error } = await this.db
      .from("audit_events")
      .select("*")
      .eq("subject_ref", subjectRef)
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit);

    if (error) throw new AuditWriteError();
    return (data ?? []).map(toRecord);
  }

  /** Distinct subjects with events, for the verification job to walk. */
  async listSubjects(limit = 10_000): Promise<string[]> {
    const { data, error } = await this.db.from("audit_events").select("subject_ref").limit(limit);

    if (error) throw new AuditWriteError();
    return [...new Set((data ?? []).map((row) => row.subject_ref))];
  }
}
