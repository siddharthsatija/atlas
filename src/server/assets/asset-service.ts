import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { ActivityWriter } from "@/server/activity/activity-writer";
import {
  NoopFindingsRecomputeQueue,
  type FindingsRecomputeQueue,
  type RecomputeRequest,
} from "@/server/findings/recompute-queue";
import {
  NoopScoreRecalculationQueue,
  type ScoreRecalculationQueue,
} from "@/server/score/recalculation-queue";
import {
  AssetDataCategoryRepository,
  AssetDataCategoryStoreError,
  type AssetDataCategoryRecord,
} from "@/server/repositories/asset-data-category-repository";
import {
  AssetPermissionRepository,
  AssetPermissionStoreError,
  type AssetPermissionRecord,
} from "@/server/repositories/asset-permission-repository";
import {
  isPermissionType,
  type PermissionScope,
  type PermissionStatus,
} from "@/lib/assets/permissions";
import type { AssetStatus } from "@/lib/assets/asset-fields";
import {
  DigitalAssetRepository,
  DigitalAssetStoreError,
  type CreateDigitalAssetInput,
  type DigitalAssetRecord,
  type UpdateDigitalAssetInput,
} from "@/server/repositories/digital-asset-repository";
import { toAssetPage, type AssetPage, type AssetQuery } from "@/lib/assets/asset-query";
import type { ApiErrorCode } from "@/lib/api/response-envelope";
import { maskValue } from "@/lib/formatting/mask";
import { logger } from "@/lib/telemetry/logger";

/**
 * AssetService (ATL-030, architecture §9).
 *
 * The seven operations §9 names, and nothing else. ATL-031/032/033/034 build the
 * surfaces that call these; ATL-036 adds archive's undo affordance and copy;
 * ATL-037 adds permanent deletion's confirmation flow and audit event.
 *
 * ## Ownership is verified here *and* by RLS
 *
 * Architecture §10: "Enforce entity ownership in service layer and RLS" and
 * "Never accept `user_id` from the client as authority". Every method below takes
 * the user id as its first argument, supplied by the caller from a verified
 * session — never from a payload — and every repository call filters on it. The
 * policies remain the second, independent gate: this layer runs as service-role,
 * which bypasses them, so a missing predicate here would not be caught by the
 * database.
 *
 * ## Failures are typed results, not exceptions or envelopes
 *
 * Methods return a discriminated result carrying an `ApiErrorCode`. The route
 * handler or Server Action adds `requestId` and builds the `ApiEnvelope` —
 * `requestId` is a request-scoped concern this layer has no business knowing,
 * and threading it through every service call to satisfy a response shape would
 * be the tail wagging the dog. Failure modes stay visible in each signature,
 * which throwing would hide.
 *
 * ## Missing and foreign look identical
 *
 * Every read and mutation answers `NOT_FOUND` for an asset that does not exist
 * *and* for one belonging to someone else. ATL-034 requires exactly this: a
 * `FORBIDDEN` on a record you do not own confirms the record exists, which turns
 * a guessed id into an oracle.
 */

export type AssetResult<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode };

const ok = <T>(data: T): AssetResult<T> => ({ ok: true, data });
const fail = <T>(code: ApiErrorCode): AssetResult<T> => ({ ok: false, code });

/** Input for creating an asset. `userId` comes from the session, never the payload. */
export type CreateAssetInput = Omit<CreateDigitalAssetInput, "userId">;

export type UpdateAssetInput = UpdateDigitalAssetInput;

export class AssetService {
  private readonly assets: DigitalAssetRepository;
  private readonly categories: AssetDataCategoryRepository;
  private readonly permissions: AssetPermissionRepository;
  private readonly activity: ActivityWriter;
  private readonly recompute: FindingsRecomputeQueue;
  private readonly score: ScoreRecalculationQueue;

  constructor(
    db: SupabaseClient<Database>,
    activity?: ActivityWriter,
    recompute?: FindingsRecomputeQueue,
    score?: ScoreRecalculationQueue,
  ) {
    this.assets = new DigitalAssetRepository(db);
    this.categories = new AssetDataCategoryRepository(db);
    this.permissions = new AssetPermissionRepository(db);
    this.activity = activity ?? new ActivityWriter(db);
    this.recompute = recompute ?? new NoopFindingsRecomputeQueue();
    this.score = score ?? new NoopScoreRecalculationQueue();
  }

  static create(): AssetService {
    const db = createServiceRoleClient();
    return new AssetService(
      db,
      new ActivityWriter(db),
      new NoopFindingsRecomputeQueue(),
      new NoopScoreRecalculationQueue(),
    );
  }

  /**
   * One page of the user's assets.
   *
   * The query is already validated and its cursor decoded by
   * `parseAssetQuery` — this layer does not re-parse, so there is one definition
   * of what a legal filter is rather than two that can disagree.
   */
  async listAssets(
    userId: string,
    query: AssetQuery,
  ): Promise<AssetResult<AssetPage<DigitalAssetRecord>>> {
    try {
      const rows = await this.assets.list(userId, query);
      return ok(toAssetPage(rows, query.limit));
    } catch (error) {
      return this.storeFailure("asset.list", error);
    }
  }

  async getAsset(userId: string, assetId: string): Promise<AssetResult<DigitalAssetRecord>> {
    try {
      const asset = await this.assets.find(userId, assetId);
      return asset ? ok(asset) : fail("NOT_FOUND");
    } catch (error) {
      return this.storeFailure("asset.get", error);
    }
  }

  /**
   * The account identifier, already masked.
   *
   * **Never returns plaintext.** Masking happens here rather than in a caller so
   * there is no way to obtain the full value through this method at all — a
   * method that returned plaintext "for the caller to mask" is one a future
   * caller renders directly.
   *
   * Not one of §9's seven operations, and deliberately not a reveal: ATL-035
   * owns reveal, which is an explicit user action that emits an audit event
   * (security §8). This is the default read that every surface showing an
   * identifier uses, and it is safe precisely because it is not reversible.
   */
  async readMaskedAccountIdentifier(
    userId: string,
    assetId: string,
  ): Promise<AssetResult<string | null>> {
    try {
      const plaintext = await this.assets.readAccountIdentifier(userId, assetId);
      return ok(plaintext ? maskValue(plaintext) : null);
    } catch (error) {
      return this.storeFailure("asset.read_identifier", error);
    }
  }

  async createAsset(
    userId: string,
    input: CreateAssetInput,
  ): Promise<AssetResult<DigitalAssetRecord>> {
    try {
      const asset = await this.assets.create({ ...input, userId });
      await this.afterMutation(asset, "asset.created");
      return ok(asset);
    } catch (error) {
      return this.storeFailure("asset.create", error);
    }
  }

  async updateAsset(
    userId: string,
    assetId: string,
    changes: UpdateAssetInput,
  ): Promise<AssetResult<DigitalAssetRecord>> {
    try {
      const asset = await this.assets.update(userId, assetId, changes);
      if (!asset) return fail("NOT_FOUND");

      await this.afterMutation(asset, "asset.updated");
      return ok(asset);
    } catch (error) {
      return this.storeFailure("asset.update", error);
    }
  }

  /**
   * Archives an asset, if it is not archived already.
   *
   * The transition is conditional in SQL (`expectedStatus`), so a repeat archive
   * answers `NOT_FOUND` rather than emitting a second activity event for
   * something that did not change. A timeline claiming a user archived the same
   * asset twice is a small lie, and the sort of thing nobody notices until they
   * are trying to reconstruct what happened.
   *
   * Archiving is reversible and is *not* deletion from the external service —
   * ATL-036 owns saying so to the user.
   */
  async archiveAsset(userId: string, assetId: string): Promise<AssetResult<DigitalAssetRecord>> {
    return this.transition(userId, assetId, "archived", "active", "asset.archived");
  }

  /** Restores an archived asset to active. The inverse of `archiveAsset`. */
  async restoreAsset(userId: string, assetId: string): Promise<AssetResult<DigitalAssetRecord>> {
    return this.transition(userId, assetId, "active", "archived", "asset.restored");
  }

  /**
   * Permanently deletes an asset and its children.
   *
   * **No audit event.** ATL-037 owns permanent deletion's confirmation flow, its
   * audit event, and the auto-resolution of related findings; writing the audit
   * record here would be implementing that ticket early. What this provides is
   * the authorized operation §9 names, so ATL-037 has something to call.
   *
   * The asset is read before it is removed, because the activity event needs the
   * service name and it will not exist afterwards.
   */
  async deleteAsset(userId: string, assetId: string): Promise<AssetResult<{ id: string }>> {
    try {
      const asset = await this.assets.find(userId, assetId);
      if (!asset) return fail("NOT_FOUND");

      const removed = await this.assets.remove(userId, assetId);
      if (!removed) return fail("NOT_FOUND");

      await this.afterMutation(asset, "asset.deleted");
      return ok({ id: assetId });
    } catch (error) {
      return this.storeFailure("asset.delete", error);
    }
  }

  /**
   * Changes an asset's lifecycle status (ATL-033).
   *
   * **`archived` is refused here on purpose.** Archiving is reversible and comes
   * with an undo affordance and copy explaining that it is not deletion from the
   * external service — all of which belong to ATL-036 and reach the database
   * through `archiveAsset`. Allowing a plain edit form to set it would ship the
   * transition without the safeguards that make it honest.
   *
   * Emits `asset.updated` carrying `fromStatus` and `toStatus`. ATL-069's
   * metadata policy already declares both keys, so the timeline can say what
   * actually changed without a new event type.
   */
  async setAssetStatus(
    userId: string,
    assetId: string,
    status: Exclude<AssetStatus, "archived">,
  ): Promise<AssetResult<DigitalAssetRecord>> {
    try {
      const current = await this.assets.find(userId, assetId);
      if (!current) return fail("NOT_FOUND");

      // Nothing changed: no write, and no timeline entry claiming one happened.
      if (current.status === status) return ok(current);

      const asset = await this.assets.setStatus(userId, assetId, status);
      if (!asset) return fail("NOT_FOUND");

      await this.afterMutation(asset, "asset.updated", {
        fromStatus: current.status,
        toStatus: status,
      });
      return ok(asset);
    } catch (error) {
      return this.storeFailure("asset.set_status", error);
    }
  }

  /**
   * Records that the user has reviewed this asset (ATL-033).
   *
   * Separate from `updateAsset` because the acceptance criterion is explicit:
   * `last_verified_at` moves "on explicit review action, not on every save". It
   * feeds R-001 (stale_review) and the score's verification-freshness factor, so
   * touching it on an unrelated edit — fixing a typo in the notes — would claim
   * the user re-checked something they never looked at.
   */
  async markReviewed(userId: string, assetId: string): Promise<AssetResult<DigitalAssetRecord>> {
    try {
      const asset = await this.assets.update(userId, assetId, {
        lastVerifiedAt: new Date().toISOString(),
      });
      if (!asset) return fail("NOT_FOUND");

      await this.afterMutation(asset, "asset.updated", { reason: "reviewed" });
      return ok(asset);
    } catch (error) {
      return this.storeFailure("asset.mark_reviewed", error);
    }
  }

  /** What one asset holds and is allowed to do — the ATL-033 edit surface. */
  async listAssetDetails(
    userId: string,
    assetId: string,
  ): Promise<
    AssetResult<{
      asset: DigitalAssetRecord;
      dataCategories: AssetDataCategoryRecord[];
      permissions: AssetPermissionRecord[];
    }>
  > {
    try {
      const asset = await this.assets.find(userId, assetId);
      if (!asset) return fail("NOT_FOUND");

      const [dataCategories, permissions] = await Promise.all([
        this.categories.listForAsset(userId, assetId),
        this.permissions.listForAsset(userId, assetId),
      ]);

      return ok({ asset, dataCategories, permissions });
    } catch (error) {
      return this.storeFailure("asset.list_details", error);
    }
  }

  /**
   * Records that an asset holds a category of data (ATL-033).
   *
   * Ownership is checked here *and* structurally: the composite foreign key on
   * `(user_id, asset_id)` has no matching parent unless the asset really belongs
   * to this user, so a cross-user pairing cannot be written even if this check
   * were removed.
   */
  async addDataCategory(
    userId: string,
    assetId: string,
    category: string,
    description?: string | null,
  ): Promise<AssetResult<AssetDataCategoryRecord>> {
    try {
      const asset = await this.assets.find(userId, assetId);
      if (!asset) return fail("NOT_FOUND");

      const record = await this.categories.record({
        userId,
        assetId,
        category,
        ...(description === undefined ? {} : { description }),
      });

      await this.afterMutation(asset, "asset.updated", { category });
      return ok(record);
    } catch (error) {
      // A duplicate is the user re-adding something already recorded, not an
      // outage — the unique constraint is doing its job.
      if (error instanceof AssetDataCategoryStoreError) return fail("INVALID_REQUEST");
      return this.storeFailure("asset.add_data_category", error);
    }
  }

  async removeDataCategory(
    userId: string,
    assetId: string,
    categoryId: string,
  ): Promise<AssetResult<{ id: string }>> {
    try {
      const asset = await this.assets.find(userId, assetId);
      if (!asset) return fail("NOT_FOUND");

      const removed = await this.categories.remove(userId, categoryId);
      if (!removed) return fail("NOT_FOUND");

      await this.afterMutation(asset, "asset.updated", { reason: "category_removed" });
      return ok({ id: categoryId });
    } catch (error) {
      return this.storeFailure("asset.remove_data_category", error);
    }
  }

  /**
   * Records a permission an asset has been granted (ATL-033).
   *
   * The type is checked against the closed vocabulary here, not merely against
   * the column's shape. ATL-029 split the two deliberately — the database
   * constrains the shape, the application constrains the meaning — and without
   * this half `oauth` and `oauth_access` would be two permissions describing one
   * grant, both counting in ADR-004's "total recorded" denominator.
   */
  async addPermission(
    userId: string,
    assetId: string,
    permissionType: string,
    scope: PermissionScope,
  ): Promise<AssetResult<AssetPermissionRecord>> {
    if (!isPermissionType(permissionType)) return fail("INVALID_REQUEST");

    try {
      const asset = await this.assets.find(userId, assetId);
      if (!asset) return fail("NOT_FOUND");

      const record = await this.permissions.record({ userId, assetId, permissionType, scope });

      await this.afterMutation(asset, "asset.updated", { reason: "permission_added" });
      return ok(record);
    } catch (error) {
      if (error instanceof AssetPermissionStoreError) return fail("INVALID_REQUEST");
      return this.storeFailure("asset.add_permission", error);
    }
  }

  /**
   * Revokes or reinstates a permission (ATL-033).
   *
   * A status change rather than a delete, so the row stays in ADR-004's "total
   * recorded" denominator — which is what makes revoking *improve* the
   * permission factor instead of merely erasing the evidence.
   */
  async setPermissionStatus(
    userId: string,
    assetId: string,
    permissionId: string,
    status: PermissionStatus,
  ): Promise<AssetResult<{ id: string }>> {
    try {
      const asset = await this.assets.find(userId, assetId);
      if (!asset) return fail("NOT_FOUND");

      const changed = await this.permissions.setStatus(userId, permissionId, status);
      if (!changed) return fail("NOT_FOUND");

      await this.afterMutation(asset, "asset.updated", { toStatus: status });
      return ok({ id: permissionId });
    } catch (error) {
      return this.storeFailure("asset.set_permission_status", error);
    }
  }

  /** Removes a permission recorded by mistake — distinct from revoking it. */
  async removePermission(
    userId: string,
    assetId: string,
    permissionId: string,
  ): Promise<AssetResult<{ id: string }>> {
    try {
      const asset = await this.assets.find(userId, assetId);
      if (!asset) return fail("NOT_FOUND");

      const removed = await this.permissions.remove(userId, permissionId);
      if (!removed) return fail("NOT_FOUND");

      await this.afterMutation(asset, "asset.updated", { reason: "permission_removed" });
      return ok({ id: permissionId });
    } catch (error) {
      return this.storeFailure("asset.remove_permission", error);
    }
  }

  private async transition(
    userId: string,
    assetId: string,
    to: "active" | "archived",
    from: "active" | "archived",
    event: RecomputeRequest["reason"],
  ): Promise<AssetResult<DigitalAssetRecord>> {
    try {
      const asset = await this.assets.setStatus(userId, assetId, to, from);
      if (!asset) return fail("NOT_FOUND");

      await this.afterMutation(asset, event);
      return ok(asset);
    } catch (error) {
      return this.storeFailure(event, error);
    }
  }

  /**
   * The two things every mutation owes: a timeline entry and a recompute.
   *
   * Both are best effort and neither can undo the mutation. The write already
   * succeeded and is the user's; failing their request afterwards because a
   * timeline row did not persist would lose the change they actually asked for.
   * This is the same trade ATL-069's emitter and ATL-016's completion make, and
   * the reason the failure is logged loudly instead.
   *
   * `entityType`/`entityId` are passed together — the table's constraint requires
   * both or neither — so the Activity page can link the entry to the asset.
   */
  private async afterMutation(
    asset: DigitalAssetRecord,
    reason: RecomputeRequest["reason"],
    /**
     * Extra allowlisted metadata for the timeline, e.g. a status transition.
     * Filtered by ATL-069's policy before it is stored, so an unlisted key is
     * dropped rather than persisted.
     */
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.activity.write({
        userId: asset.userId,
        type: reason,
        // `service` is the vocabulary's name for a product or service name
        // (ATL-069) — never a personal value, which is why it may be rendered
        // into the timeline sentence unmasked.
        params: { service: asset.serviceName },
        entityType: "asset",
        entityId: asset.id,
        metadata: { category: asset.category, status: asset.status, ...extra },
      });
    } catch {
      logger.error("activity.write_failed", { operation: reason, count: 1 });
    }

    try {
      await this.recompute.enqueue({ userId: asset.userId, reason });
    } catch {
      // A dropped recompute costs a stale finding until the nightly sweep, which
      // §11 runs regardless. It must never cost the user their edit.
      logger.error("findings.recompute_enqueue_failed", { operation: reason, count: 1 });
    }

    try {
      /**
       * Separately from the recompute above, and caught separately.
       *
       * ADR-004 and §14 treat these as two jobs, and one failing must not stop
       * the other being asked for — a score that never recalculates because the
       * findings queue was down would be a second outage caused by the first.
       */
      await this.score.enqueue({ userId: asset.userId, reason });
    } catch {
      logger.error("score.recalculation_enqueue_failed", { operation: reason, count: 1 });
    }
  }

  /**
   * Maps a storage failure to a code, and lets anything else through.
   *
   * Only `DigitalAssetStoreError` becomes `UNAVAILABLE`. Swallowing every
   * exception here would turn a programming error into a calm "try again later"
   * that nobody investigates — the store error is the one the repository raises
   * deliberately, with no provider detail attached (architecture §10: "return
   * typed error codes, not raw provider errors").
   */
  private storeFailure<T>(operation: string, error: unknown): AssetResult<T> {
    if (!(error instanceof DigitalAssetStoreError)) throw error;

    logger.error("asset.store_unavailable", {
      operation,
      provider: "database",
      providerAvailable: false,
    });
    return fail("UNAVAILABLE");
  }
}
