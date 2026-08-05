import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { ActivityMetadata } from "@/lib/activity/activity-metadata";

/**
 * Data access for `activity_events` (ATL-068, architecture §7.9).
 *
 * Exposes `append` and the two read shapes the indexes exist for. There is
 * deliberately **no** update or delete method: the table grants neither, and a
 * repository method that could not succeed is a method someone will eventually
 * try to make succeed.
 *
 * Event-type validation and summary redaction are **not** here — they belong to
 * the writer (ATL-069), which owns the enumeration. This layer stores what it is
 * given, which is why nothing may call it directly except that writer.
 */

export type ActivityRow = Database["public"]["Tables"]["activity_events"]["Row"];

export interface ActivityEventRecord {
  id: string;
  userId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  metadata: ActivityMetadata;
  occurredAt: string;
}

function toRecord(row: ActivityRow): ActivityEventRecord {
  return {
    id: row.id,
    userId: row.user_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    metadata: (row.metadata_redacted_json ?? {}) as ActivityMetadata,
    occurredAt: row.occurred_at,
  };
}

/** Raised for any activity storage failure. Carries no database detail. */
export class ActivityStoreError extends Error {
  constructor() {
    super("activity store unavailable");
    this.name = "ActivityStoreError";
  }
}

export interface AppendActivityInput {
  userId: string;
  eventType: string;
  summary: string;
  entityType?: string | undefined;
  entityId?: string | undefined;
  metadata?: ActivityMetadata | undefined;
  occurredAt?: string | undefined;
}

/** A page of the timeline, with the cursor needed to fetch the next one. */
export interface ActivityPage {
  events: ActivityEventRecord[];
  /** Pass to the next call. Null when the timeline is exhausted. */
  nextCursor: ActivityCursor | null;
}

/**
 * Cursor position.
 *
 * Both fields, not just the timestamp: `occurred_at` is millisecond resolution,
 * so two events can share one. Paginating on the timestamp alone would repeat or
 * skip whichever rows straddle a page boundary — and the index is ordered
 * `(occurred_at desc, id desc)` precisely so this pair is a total ordering.
 */
export interface ActivityCursor {
  occurredAt: string;
  id: string;
}

export class ActivityEventRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /** Records one event. Called only by the ATL-069 writer. */
  async append(input: AppendActivityInput): Promise<ActivityEventRecord> {
    const { data, error } = await this.db
      .from("activity_events")
      .insert({
        user_id: input.userId,
        event_type: input.eventType,
        summary: input.summary,
        entity_type: input.entityType ?? null,
        entity_id: input.entityId ?? null,
        metadata_redacted_json: (input.metadata ?? {}) as never,
        ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
      })
      .select("*")
      .single();

    if (error || !data) throw new ActivityStoreError();
    return toRecord(data);
  }

  /**
   * One page of the timeline, newest first (ATL-070).
   *
   * Keyset pagination rather than offset: an offset re-scans everything it skips
   * and, worse, shifts under inserts — a user reading page two while a new event
   * arrives would see a row twice. The cursor names a position instead, so pages
   * stay stable while the timeline grows at the top.
   *
   * The ordering matches `activity_events_timeline_idx` exactly, so this reads
   * the index rather than sorting.
   */
  async timeline(
    userId: string,
    options: { limit?: number; cursor?: ActivityCursor | undefined; eventType?: string } = {},
  ): Promise<ActivityPage> {
    const limit = options.limit ?? 50;

    let query = this.db
      .from("activity_events")
      .select("*")
      // Ownership is filtered explicitly: the service-role client bypasses RLS,
      // so this is the only gate when the writer reads back.
      .eq("user_id", userId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      // One extra row, to learn whether another page exists without a count query.
      .limit(limit + 1);

    if (options.eventType) query = query.eq("event_type", options.eventType);

    if (options.cursor) {
      // "Strictly older than the cursor": either an earlier timestamp, or the
      // same timestamp with a lower id. Expressed as an `or` because PostgREST
      // has no row-value comparison.
      const { occurredAt, id } = options.cursor;
      query = query.or(
        `occurred_at.lt.${occurredAt},and(occurred_at.eq.${occurredAt},id.lt.${id})`,
      );
    }

    const { data, error } = await query;
    if (error) throw new ActivityStoreError();

    const rows = (data ?? []).map(toRecord);
    const events = rows.slice(0, limit);
    const last = events[events.length - 1];

    return {
      events,
      nextCursor: rows.length > limit && last ? { occurredAt: last.occurredAt, id: last.id } : null,
    };
  }

  /** Everything that happened to one entity, newest first (frontend §13 entity links). */
  async forEntity(
    userId: string,
    entityType: string,
    entityId: string,
    limit = 50,
  ): Promise<ActivityEventRecord[]> {
    const { data, error } = await this.db
      .from("activity_events")
      .select("*")
      .eq("user_id", userId)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);

    if (error) throw new ActivityStoreError();
    return (data ?? []).map(toRecord);
  }
}
