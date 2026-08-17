import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { ApiErrorCode } from "@/lib/api/response-envelope";
import {
  buildNotificationBody,
  buildNotificationTitle,
  isConfigurable,
  isNotificationType,
  resolveEnabled,
  NOTIFICATION_TYPES,
  type NotificationParams,
  type NotificationType,
} from "@/lib/notifications/notification-types";
import { scrubString } from "@/lib/telemetry/redaction";
import { logger } from "@/lib/telemetry/logger";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import {
  NotificationRepository,
  type NotificationRecord,
} from "@/server/repositories/notification-repository";
import { NotificationPreferenceRepository } from "@/server/repositories/notification-preference-repository";

/**
 * Notification creation, reads, read-state and retention (ATL-107, ADR-005).
 *
 * The **only** module that writes `notifications`. Everything that makes a
 * notification safe happens here — type validation, template composition, the
 * restricted-pattern scan, and the preference check — so no caller can skip a
 * step by building a row itself. The table grants INSERT to `service_role` alone
 * and the repository is server-only, so this is the whole write surface. That is
 * `ActivityWriter`'s design, adopted rather than reinvented.
 *
 * ## Three independent guards on content
 *
 *  1. **Unknown types are rejected.** An unrecognised type renders as a blank
 *     panel row and is invisible to preference checks, so it fails here.
 *  2. **Titles and bodies are composed, never accepted.** `create` takes a type
 *     and typed parameters; there is no parameter that carries free text, so a
 *     caller holding a recipient address or a draft body cannot put either into a
 *     notification even by accident (ADR-005, FR-14).
 *  3. **The composed strings are scanned** for emails, phones and credentials
 *     (ATL-085) and the write is refused if any survive.
 *
 * The third is defence in depth and should never fire: templates interpolate only
 * allowlisted parameters. It exists because the guard that catches a mistake is
 * the one nobody expected to need — if a future template interpolates something
 * unmasked, this is what stops it reaching a person.
 *
 * Unlike `ActivityWriter` there is no `maskedIdentifier` escape hatch, because
 * `NotificationParams` has no such member: ADR-005 permits "service names and
 * statuses" and nothing else, so an unscrubbed value here has no legitimate case
 * to be confused with.
 *
 * ## Preferences: overrides in data, defaults in code
 *
 * `create` consults the effective preference and silently declines when a type is
 * switched off. `security` bypasses the lookup entirely — not "looks it up and
 * ignores it", which would leave a row that appears to matter — and
 * `setPreference` refuses to persist one, with the table's own check constraint
 * behind that refusal (D2, ADR-005, FR-14).
 *
 * ## No audit event, deliberately
 *
 * ADR-006's inventory lists no notification event and D5 keeps it that way.
 * Creating a notification is not itself a security event; the thing that *caused*
 * it — a status transition, a consent change, a sign-in — is audited in its own
 * right by the service that did it. Adding one would put a 90-day-retained audit
 * row behind every reminder, which is noise in the log that exists to make real
 * events findable.
 *
 * ## No creators are wired yet
 *
 * Every future caller is a later ticket: the follow-up job (ATL-066), the findings
 * sweep, and security events. This is the seam they will call, implemented and
 * tested rather than deferred, with no write manufactured to make it look busy —
 * the discipline ATL-105 applied to `markUsed`.
 */

export type NotificationResult<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode };

const ok = <T>(data: T): NotificationResult<T> => ({ ok: true, data });
const fail = <T>(code: ApiErrorCode): NotificationResult<T> => ({ ok: false, code });

/** Raised when a composed title or body would carry a restricted value. */
export class UnsafeNotificationContentError extends Error {
  constructor() {
    super("composed notification content contained a restricted value");
    this.name = "UnsafeNotificationContentError";
  }
}

export interface CreateNotificationRequest {
  userId: string;
  type: NotificationType;
  /** Typed template parameters. No free-text field exists. */
  params?: NotificationParams;
  /** Both or neither, matching the table's constraint. */
  entityType?: string;
  entityId?: string;
}

/**
 * What `create` answers with.
 *
 * A suppressed notification is a **success**: the person asked not to receive
 * this type and Atlas honoured it, which is the system working. Returning a
 * failure would invite a caller to retry, and a job that retried a suppression
 * would either loop or eventually find a way to write the row anyway.
 */
export type CreateNotificationOutcome =
  | { created: true; notification: NotificationRecord }
  | { created: false; reason: "preference_disabled" };

/** One type's effective state, for Settings → Notifications (ATL-077). */
export interface NotificationPreferenceState {
  type: NotificationType;
  enabled: boolean;
  configurable: boolean;
  /** True when this reflects an explicit choice rather than the declared default. */
  overridden: boolean;
}

/** Notifications plus the cursor a caller needs to ask for the next page. */
export interface NotificationPage {
  notifications: NotificationRecord[];
  /** Null when this is the last page. */
  nextCursor: { createdAt: string; id: string } | null;
}

export const NOTIFICATION_PAGE_SIZE = 20;

/** Security §14: "Notifications: purged after 90 days." */
export const NOTIFICATION_RETENTION_DAYS = 90;

const PURGE_BATCH_SIZE = 1000;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface NotificationDependencies {
  notifications: NotificationRepository;
  preferences: NotificationPreferenceRepository;
}

export class NotificationService {
  private readonly notifications: NotificationRepository;
  private readonly preferences: NotificationPreferenceRepository;

  constructor(dependencies: NotificationDependencies) {
    this.notifications = dependencies.notifications;
    this.preferences = dependencies.preferences;
  }

  /** Uses the service-role client: creation is server-side only (ADR-005). */
  static create(db: SupabaseClient<Database> = createServiceRoleClient()): NotificationService {
    return new NotificationService({
      notifications: new NotificationRepository(db),
      preferences: new NotificationPreferenceRepository(db),
    });
  }

  /**
   * Creates one notification, if the person wants that type.
   *
   * The order matters and is the design: validate the type, resolve the
   * preference, compose the content, scan it, then write. Composing before
   * checking the preference would waste nothing but would put a rendered string
   * for a notification nobody will see into memory; checking after writing would
   * be a notification that exists and should not.
   */
  async create(
    request: CreateNotificationRequest,
  ): Promise<NotificationResult<CreateNotificationOutcome>> {
    if (!isNotificationType(request.type)) return fail("INVALID_REQUEST");

    /**
     * Both or neither. The table's paired constraint would refuse it, but
     * answering here keeps the database as the second gate rather than the first
     * — and a half-supplied link is a caller bug worth naming, not a store error.
     */
    const hasEntityType = request.entityType !== undefined && request.entityType.length > 0;
    const hasEntityId = request.entityId !== undefined && request.entityId.length > 0;
    if (hasEntityType !== hasEntityId) return fail("INVALID_REQUEST");

    try {
      if (!(await this.isEnabled(request.userId, request.type))) {
        /**
         * Logged at info with the type only. A suppression is worth being able to
         * see when a person asks why they were not notified, and the type is not
         * personal data — but the user id, the entity and the content stay out
         * (security §12, ATL-085).
         */
        logger.info("notification.suppressed", {
          operation: "notification.create",
          count: 1,
        });
        return ok({ created: false, reason: "preference_disabled" });
      }

      const params = request.params ?? {};
      const title = buildNotificationTitle(request.type, params);
      const body = buildNotificationBody(request.type, params);

      /**
       * The composed strings are scanned, not the parameters.
       *
       * Scanning inputs would miss a template that concatenated two safe values
       * into an unsafe one. Checking the finished text is the only version of this
       * that covers what the person actually reads.
       */
      if (scrubString(title).scrubbed || scrubString(body).scrubbed) {
        throw new UnsafeNotificationContentError();
      }

      const notification = await this.notifications.create({
        userId: request.userId,
        type: request.type,
        title,
        body,
        ...(hasEntityType && hasEntityId
          ? { entityType: request.entityType, entityId: request.entityId }
          : {}),
      });

      return ok({ created: true, notification });
    } catch (error) {
      /**
       * An unsafe composition is not a store outage and must not be reported as
       * one: it is a bug in a template or a caller, and `INVALID_REQUEST` is what
       * says so. Reporting `UNAVAILABLE` would invite a retry of something that
       * will fail identically forever.
       */
      if (error instanceof UnsafeNotificationContentError) {
        logger.error("notification.unsafe_content", { operation: "notification.create" });
        return fail("INVALID_REQUEST");
      }
      return this.storeFailure("notification.create", error);
    }
  }

  /** One page of notifications, newest first (frontend §4.1). */
  async list(
    userId: string,
    cursor?: { createdAt: string; id: string },
    pageSize: number = NOTIFICATION_PAGE_SIZE,
  ): Promise<NotificationResult<NotificationPage>> {
    try {
      /**
       * One extra row is fetched to learn whether another page exists, then
       * dropped. Asking for `pageSize` and inferring "full page means more"
       * reports a next page that does not exist whenever the total is an exact
       * multiple — a panel that offers an empty page.
       */
      const rows = await this.notifications.list({
        userId,
        limit: pageSize + 1,
        ...(cursor ? { before: cursor } : {}),
      });

      const page = rows.slice(0, pageSize);
      const last = page.at(-1);
      const nextCursor =
        rows.length > pageSize && last ? { createdAt: last.createdAt, id: last.id } : null;

      return ok({ notifications: page, nextCursor });
    } catch (error) {
      return this.storeFailure("notification.list", error);
    }
  }

  /**
   * The unread count for the badge.
   *
   * A true count, uncapped (D7). Frontend §4.1 calls "9+" a *display* cap, so it
   * belongs to ATL-108 — a service that capped would make the number it returns
   * unusable for anything else, including deciding whether to announce.
   */
  async unreadCount(userId: string): Promise<NotificationResult<number>> {
    try {
      return ok(await this.notifications.countUnread(userId));
    } catch (error) {
      return this.storeFailure("notification.unread", error);
    }
  }

  /**
   * Marks one notification read.
   *
   * `NOT_FOUND` covers absent, not-yours, and already-read alike. The first two
   * are indistinguishable by design — the non-oracle rule ATL-030 set — and
   * folding in the third costs nothing, since a caller has no action to take that
   * differs between "you already read this" and "there is nothing there".
   */
  async markRead(
    userId: string,
    notificationId: string,
  ): Promise<NotificationResult<{ id: string }>> {
    try {
      const changed = await this.notifications.markRead(
        userId,
        notificationId,
        new Date().toISOString(),
      );
      return changed ? ok({ id: notificationId }) : fail("NOT_FOUND");
    } catch (error) {
      return this.storeFailure("notification.markread", error);
    }
  }

  /** Marks everything read. Returns how many changed; zero is a success. */
  async markAllRead(userId: string): Promise<NotificationResult<number>> {
    try {
      return ok(await this.notifications.markAllRead(userId, new Date().toISOString()));
    } catch (error) {
      return this.storeFailure("notification.markallread", error);
    }
  }

  /**
   * Marks the notifications pointing at one entity read (ADR-005: "Opening a
   * linked entity marks its notification read").
   *
   * Returns a count rather than a boolean, and zero is a success: opening a
   * request that had no notification is entirely normal, and a failure there
   * would make every navigation look broken.
   */
  async markEntityRead(
    userId: string,
    entityType: string,
    entityId: string,
  ): Promise<NotificationResult<number>> {
    try {
      return ok(
        await this.notifications.markEntityRead(
          userId,
          entityType,
          entityId,
          new Date().toISOString(),
        ),
      );
    } catch (error) {
      return this.storeFailure("notification.markentityread", error);
    }
  }

  /**
   * Whether this person currently receives this type.
   *
   * `security` short-circuits **before** the lookup. That is the difference
   * between "cannot be disabled" and "is enabled by default": there is no row to
   * read, so there is no row whose value could be honoured by mistake, and the
   * guarantee does not depend on the table's contents.
   */
  async isEnabled(userId: string, type: NotificationType): Promise<boolean> {
    if (!isConfigurable(type)) return true;

    const override = await this.preferences.find(userId, type);
    return resolveEnabled(type, override?.enabled ?? null);
  }

  /**
   * Every type's effective state, for Settings → Notifications (ATL-077).
   *
   * Built from the vocabulary rather than from the rows, so a type the person has
   * never touched still appears — with its declared default and `overridden:
   * false`, which is what lets the UI show a toggle in the right position without
   * knowing what a default is.
   */
  async preferenceStates(
    userId: string,
  ): Promise<NotificationResult<NotificationPreferenceState[]>> {
    try {
      const overrides = await this.preferences.list(userId);
      const byType = new Map(overrides.map((row) => [row.notificationType, row.enabled]));

      return ok(
        NOTIFICATION_TYPES.map((type) => {
          const override = byType.get(type);
          const configurable = isConfigurable(type);
          return {
            type,
            /**
             * `resolveEnabled` ignores the override for a non-configurable type,
             * so `security` reads as enabled here even if a row somehow existed.
             */
            enabled: resolveEnabled(type, override ?? null),
            configurable,
            overridden: configurable && override !== undefined,
          };
        }),
      );
    } catch (error) {
      return this.storeFailure("notification.preferences", error);
    }
  }

  /**
   * Records a person's choice for one type.
   *
   * Refuses `security` with `INVALID_REQUEST` before touching the store. The
   * table's check constraint would refuse it too, and both exist on purpose: the
   * constraint makes the row unrepresentable by *any* path, and this makes the
   * refusal explainable to the surface that asked (ADR-005, FR-14, D2).
   */
  async setPreference(
    userId: string,
    type: NotificationType,
    enabled: boolean,
  ): Promise<NotificationResult<NotificationPreferenceState>> {
    if (!isNotificationType(type)) return fail("INVALID_REQUEST");
    if (!isConfigurable(type)) return fail("INVALID_REQUEST");

    try {
      const saved = await this.preferences.upsert(userId, type, enabled);
      return ok({
        type,
        enabled: saved.enabled,
        configurable: true,
        overridden: true,
      });
    } catch (error) {
      return this.storeFailure("notification.setpreference", error);
    }
  }

  /**
   * Clears a person's choice, returning the type to its declared default.
   *
   * Distinct from setting it back to the default's current value: a cleared
   * preference follows the default if it ever changes, where a stored value pins
   * today's answer with nothing recording that it was ever a default.
   */
  async clearPreference(
    userId: string,
    type: NotificationType,
  ): Promise<NotificationResult<{ cleared: boolean }>> {
    if (!isNotificationType(type)) return fail("INVALID_REQUEST");
    if (!isConfigurable(type)) return fail("INVALID_REQUEST");

    try {
      return ok({ cleared: await this.preferences.clear(userId, type) });
    } catch (error) {
      return this.storeFailure("notification.clearpreference", error);
    }
  }

  /**
   * Purges notifications older than 90 days (security §14, architecture §14).
   *
   * **No scheduler.** The job runtime — Edge Functions versus a dedicated worker —
   * is a deferred architecture decision (§21), and `src/server/jobs/README.md`
   * holds the requirements rather than a runner. So this is the job's *body*,
   * callable and tested, exactly as `IdempotencyService.purgeExpired` and
   * `PrivacyScoreService.compactSnapshots` already are. Whatever runs it later
   * calls this.
   *
   * Idempotent: the predicate is the age of the row, so a second run over the
   * same window deletes nothing and returns zero. Bounded: it loops in batches so
   * one large account cannot make a single unbounded delete, and drains a backlog
   * without one enormous statement.
   *
   * The clock is a parameter so the boundary can be tested without waiting 90
   * days — and, per ATL-113, so the caller cannot accidentally introduce a second
   * clock: production passes nothing and gets `new Date()`.
   */
  async purgeOlderThan(
    now: Date = new Date(),
    batchSize: number = PURGE_BATCH_SIZE,
  ): Promise<NotificationResult<number>> {
    const cutoff = new Date(
      now.getTime() - NOTIFICATION_RETENTION_DAYS * MILLISECONDS_PER_DAY,
    ).toISOString();

    let total = 0;

    try {
      for (;;) {
        const removed = await this.notifications.purgeOlderThan(cutoff, batchSize);
        total += removed;
        if (removed < batchSize) break;
      }
    } catch (error) {
      /**
       * Reported with the count already removed. A partial purge is not a
       * corruption — the rows that went were all past retention — and the next
       * run continues from where this one stopped, so the honest report is how far
       * it got.
       */
      logger.error("notification.purge_failed", {
        jobName: "notification-purge",
        jobStatus: "failed",
        count: total,
      });
      return this.storeFailure("notification.purge", error);
    }

    logger.info("notification.purged", {
      jobName: "notification-purge",
      jobStatus: "succeeded",
      count: total,
    });

    return ok(total);
  }

  /**
   * One place where a store failure becomes a result.
   *
   * The caught error is never returned or logged as a value: it may carry a
   * database message, and security §16 forbids those reaching a log sink. Only the
   * operation name and a code go out.
   *
   * `operation` values carry no underscore. `LOG_FIELD_POLICY` requires
   * /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/, so `notification.mark_read` would fail
   * redaction and vanish from the record — a log line that looks complete and
   * silently is not.
   */
  private storeFailure<T>(operation: string, error: unknown): NotificationResult<T> {
    logger.error("notification.store_failed", {
      operation,
      errorCode: error instanceof Error ? "STORE_ERROR" : "UNKNOWN_ERROR",
    });
    return fail("UNAVAILABLE");
  }
}
