import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { NotificationType } from "@/lib/notifications/notification-types";

/**
 * Data access for `notification_preferences` (ATL-107, D1).
 *
 * Stores overrides. It does **not** know what a default is, and deliberately so:
 * defaults live beside each type in `src/lib/notifications/notification-types.ts`,
 * and a repository that substituted one would make the absence of a row
 * indistinguishable from a stored value — which is the distinction D1 rests on.
 * `find` therefore returns `null` for "no choice made" and never a fallback.
 *
 * Nor does it know that `security` is not configurable. That refusal belongs to
 * `NotificationService`, which can explain it; the check constraint on the table
 * is the gate behind that. This layer has no rule of its own to enforce, which is
 * why it has no branch that could forget one.
 *
 * Used with the **service-role** client, which bypasses RLS, so ownership is
 * filtered explicitly in every query.
 */

export type NotificationPreferenceRow =
  Database["public"]["Tables"]["notification_preferences"]["Row"];

export interface NotificationPreferenceRecord {
  id: string;
  userId: string;
  notificationType: NotificationType;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export class NotificationPreferenceStoreError extends Error {
  constructor(operation: string) {
    super(`notification preference store failed: ${operation}`);
    this.name = "NotificationPreferenceStoreError";
  }
}

const COLUMNS = "id, user_id, notification_type, enabled, created_at, updated_at";

export class NotificationPreferenceRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * This person's override for one type, or null when they have not set one.
   *
   * Null is meaningful — see the module note. It is the answer that lets the
   * caller apply the declared default rather than a stored guess at it.
   */
  async find(
    userId: string,
    notificationType: NotificationType,
  ): Promise<NotificationPreferenceRecord | null> {
    const { data, error } = await this.db
      .from("notification_preferences")
      .select(COLUMNS)
      .eq("user_id", userId)
      .eq("notification_type", notificationType)
      .maybeSingle();

    if (error) throw new NotificationPreferenceStoreError("find");
    return data ? toRecord(data) : null;
  }

  /** Every override this person has set. Types they never touched are absent. */
  async list(userId: string): Promise<NotificationPreferenceRecord[]> {
    const { data, error } = await this.db
      .from("notification_preferences")
      .select(COLUMNS)
      .eq("user_id", userId)
      .order("notification_type", { ascending: true });

    if (error) throw new NotificationPreferenceStoreError("list");
    return (data ?? []).map(toRecord);
  }

  /**
   * Records a choice, replacing any previous one for the same type.
   *
   * An upsert on `(user_id, notification_type)` rather than an insert, because a
   * preference is current state and not history: a person who toggles a type
   * twice has one preference, not two rows whose order decides the answer. The
   * unique index is what makes the conflict target exact, and `updated_at` is
   * maintained by the shared trigger.
   *
   * `consents` is the table that appends instead, and it does so because a consent
   * is evidence of an agreement at a moment in time. A toggle is not evidence of
   * anything; it is a setting.
   */
  async upsert(
    userId: string,
    notificationType: NotificationType,
    enabled: boolean,
  ): Promise<NotificationPreferenceRecord> {
    const { data, error } = await this.db
      .from("notification_preferences")
      .upsert(
        { user_id: userId, notification_type: notificationType, enabled },
        { onConflict: "user_id,notification_type" },
      )
      .select(COLUMNS)
      .single();

    if (error || !data) throw new NotificationPreferenceStoreError("upsert");
    return toRecord(data);
  }

  /**
   * Clears an override, returning the type to its declared default.
   *
   * Not the same as storing `enabled = true`. A cleared preference follows the
   * default if the default ever changes; a stored `true` pins today's value
   * forever, and the person who cleared it would have no way to tell.
   *
   * Returns false when there was nothing to clear.
   */
  async clear(userId: string, notificationType: NotificationType): Promise<boolean> {
    const { data, error } = await this.db
      .from("notification_preferences")
      .delete()
      .eq("user_id", userId)
      .eq("notification_type", notificationType)
      .select("id");

    if (error) throw new NotificationPreferenceStoreError("clear");
    return (data ?? []).length > 0;
  }
}

function toRecord(row: NotificationPreferenceRow): NotificationPreferenceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    notificationType: row.notification_type as NotificationType,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
