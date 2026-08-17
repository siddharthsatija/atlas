import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { NotificationType } from "@/lib/notifications/notification-types";

/**
 * Data access for `notifications` (ATL-107, ADR-005, architecture §7.14).
 *
 * Stores what it is given. Type validation, template composition, the redaction
 * scan and the preference check are **not** here — they belong to
 * `NotificationService`, which owns the vocabulary. This is the split
 * `activity-event-repository.ts` and `ActivityWriter` already use, and it exists
 * so no caller can reach storage without passing the checks: nothing may call
 * this layer except that service.
 *
 * Used with the **service-role** client, which bypasses RLS, so ownership is
 * filtered explicitly in every query. The policies are the second gate, not this
 * layer's excuse to omit the first.
 *
 * Every method corresponds to a granted verb, and there is no method the grants
 * would refuse — a repository method that cannot succeed is one someone will
 * eventually try to make succeed.
 */

export type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];

/** One notification as the application sees it. */
export interface NotificationRecord {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  /** Null means unread. */
  readAt: string | null;
  createdAt: string;
}

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  /** Already composed by the service. This layer never builds a string. */
  title: string;
  body: string;
  /** Both or neither, matching the table's constraint. */
  entityType?: string | undefined;
  entityId?: string | undefined;
}

export interface ListNotificationsInput {
  userId: string;
  limit: number;
  /** Newest-first cursor: rows strictly older than this `(createdAt, id)`. */
  before?: { createdAt: string; id: string } | undefined;
}

/** Raised for any notification storage failure. Carries no database detail. */
export class NotificationStoreError extends Error {
  constructor(operation: string) {
    super(`notification store failed: ${operation}`);
    this.name = "NotificationStoreError";
  }
}

const COLUMNS = "id, user_id, type, title, body, entity_type, entity_id, read_at, created_at";

export class NotificationRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /** Inserts one notification. Server-side only, per ADR-005. */
  async create(input: CreateNotificationInput): Promise<NotificationRecord> {
    const { data, error } = await this.db
      .from("notifications")
      .insert({
        user_id: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        /**
         * Both or neither. Spread conditionally rather than passing `undefined`,
         * so a half-supplied link never reaches the paired check constraint as
         * one null and one value — the service refuses that case first, and this
         * keeps the insert from depending on which of the two it forgot.
         */
        ...(input.entityType && input.entityId
          ? { entity_type: input.entityType, entity_id: input.entityId }
          : {}),
      })
      .select(COLUMNS)
      .single();

    if (error || !data) throw new NotificationStoreError("create");
    return toRecord(data);
  }

  /**
   * One person's notifications, newest first (frontend §4.1).
   *
   * Paginated by `(created_at, id)` rather than by offset, which is what the
   * `notifications_user_created_idx` tiebreak exists for: `created_at` can tie,
   * and an offset over a tie can repeat or skip a row at a page boundary
   * (ATL-114).
   */
  async list(input: ListNotificationsInput): Promise<NotificationRecord[]> {
    let query = this.db
      .from("notifications")
      .select(COLUMNS)
      .eq("user_id", input.userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(input.limit);

    if (input.before) {
      /**
       * Strictly older than the cursor, with the id breaking a tie. Expressed as
       * an `or` over the two disjoint cases rather than a compound comparison,
       * because PostgREST has no row-value syntax.
       */
      const { createdAt, id } = input.before;
      query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`);
    }

    const { data, error } = await query;

    if (error) throw new NotificationStoreError("list");
    return (data ?? []).map(toRecord);
  }

  /**
   * How many unread notifications this person has.
   *
   * A real count, uncapped (D7): the "9+" ceiling is a display decision and
   * belongs to ATL-108. `head: true` asks Postgres for the count without
   * transferring rows, and the partial `notifications_unread_idx` is what keeps
   * it cheap as history grows.
   */
  async countUnread(userId: string): Promise<number> {
    const { count, error } = await this.db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null);

    if (error) throw new NotificationStoreError("count unread");
    return count ?? 0;
  }

  /**
   * Marks one notification read.
   *
   * Returns false when the row was absent, not this person's, or already read, so
   * a caller cannot report a change that did not happen. `is("read_at", null)`
   * makes this idempotent at the database rather than in a read-then-write, which
   * two concurrent tabs would race.
   */
  async markRead(userId: string, notificationId: string, readAt: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("notifications")
      .update({ read_at: readAt })
      .eq("user_id", userId)
      .eq("id", notificationId)
      .is("read_at", null)
      .select("id");

    if (error) throw new NotificationStoreError("mark read");
    return (data ?? []).length > 0;
  }

  /** Marks every unread notification read. Returns how many changed. */
  async markAllRead(userId: string, readAt: string): Promise<number> {
    const { data, error } = await this.db
      .from("notifications")
      .update({ read_at: readAt })
      .eq("user_id", userId)
      .is("read_at", null)
      .select("id");

    if (error) throw new NotificationStoreError("mark all read");
    return (data ?? []).length;
  }

  /**
   * Marks the notifications that link to one entity read (ADR-005: "Opening a
   * linked entity marks its notification read").
   *
   * Plural because more than one notification can point at the same request — a
   * status change and a follow-up reminder both do — and opening it addresses all
   * of them.
   */
  async markEntityRead(
    userId: string,
    entityType: string,
    entityId: string,
    readAt: string,
  ): Promise<number> {
    const { data, error } = await this.db
      .from("notifications")
      .update({ read_at: readAt })
      .eq("user_id", userId)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .is("read_at", null)
      .select("id");

    if (error) throw new NotificationStoreError("mark entity read");
    return (data ?? []).length;
  }

  /**
   * Deletes notifications created before `cutoff` (security §14: 90 days).
   *
   * Bounded per call so the job cannot issue an unbounded delete against a table
   * that has grown unexpectedly; the caller loops until it returns less than the
   * batch size. Select-then-delete rather than a delete with a limit, because
   * PostgREST cannot bound a delete directly — the shape
   * `IdempotencyKeyRepository.purgeExpired` established.
   */
  async purgeOlderThan(cutoff: string, limit: number): Promise<number> {
    const { data: stale, error: findError } = await this.db
      .from("notifications")
      .select("id")
      .lt("created_at", cutoff)
      .limit(limit);

    if (findError) throw new NotificationStoreError("purge find");

    const ids = (stale ?? []).map((row) => row.id);
    if (ids.length === 0) return 0;

    const { data, error } = await this.db.from("notifications").delete().in("id", ids).select("id");

    if (error) throw new NotificationStoreError("purge delete");
    return (data ?? []).length;
  }
}

function toRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}
