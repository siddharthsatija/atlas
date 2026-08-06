import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import {
  DEFAULT_PERMISSION_STATUS,
  type PermissionScope,
  type PermissionStatus,
} from "@/lib/assets/permissions";

/**
 * Data access for `asset_permissions` (ATL-029).
 *
 * Deliberately thin: this ticket owns the schema, and ATL-030 owns the service
 * layer that applies authorization, emits activity, and enqueues findings
 * recompute. What lives here is the ownership predicate every query needs and
 * the read shapes the rules engine and score will use.
 *
 * Nothing on this table is Restricted — the §8 encrypted-column inventory names
 * no column here, and `permission_type` and `scope` are closed vocabularies with
 * nowhere for a personal value to travel. There is no free-text column at all,
 * which is why this repository has no redaction step.
 *
 * Used with the **service-role** client, which bypasses RLS, so ownership is
 * filtered explicitly in every query. The policies are the second gate, not this
 * layer's excuse to skip the first.
 */

export type AssetPermissionRow = Database["public"]["Tables"]["asset_permissions"]["Row"];

export interface AssetPermissionRecord {
  id: string;
  userId: string;
  assetId: string;
  permissionType: string;
  scope: PermissionScope;
  status: PermissionStatus;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: AssetPermissionRow): AssetPermissionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    permissionType: row.permission_type,
    scope: row.scope as PermissionScope,
    status: row.status as PermissionStatus,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Raised for any permission storage failure. Carries no database detail. */
export class AssetPermissionStoreError extends Error {
  constructor() {
    super("asset permission store unavailable");
    this.name = "AssetPermissionStoreError";
  }
}

export interface RecordPermissionInput {
  userId: string;
  assetId: string;
  permissionType: string;
  scope: PermissionScope;
  status?: PermissionStatus;
  lastVerifiedAt?: string | null;
}

export class AssetPermissionRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Records a permission an asset has been granted.
   *
   * A cross-user pairing is impossible regardless of what the caller supplies:
   * the composite foreign key on `(user_id, asset_id)` has no matching parent
   * unless the asset really belongs to that user.
   */
  async record(input: RecordPermissionInput): Promise<AssetPermissionRecord> {
    const { data, error } = await this.db
      .from("asset_permissions")
      .insert({
        user_id: input.userId,
        asset_id: input.assetId,
        permission_type: input.permissionType,
        scope: input.scope,
        status: input.status ?? DEFAULT_PERMISSION_STATUS,
        last_verified_at: input.lastVerifiedAt ?? null,
      })
      .select("*")
      .single();

    if (error || !data) throw new AssetPermissionStoreError();
    return toRecord(data);
  }

  /** Every permission on one asset — the permissions section of frontend §7. */
  async listForAsset(userId: string, assetId: string): Promise<AssetPermissionRecord[]> {
    const { data, error } = await this.db
      .from("asset_permissions")
      .select("*")
      .eq("user_id", userId)
      .eq("asset_id", assetId)
      .order("permission_type", { ascending: true });

    if (error) throw new AssetPermissionStoreError();
    return (data ?? []).map(toRecord);
  }

  /**
   * Every permission a user has recorded, whatever its status.
   *
   * The whole set, deliberately: ADR-004's factor divides broad-active by
   * **total recorded**, so filtering here would silently change the denominator
   * and with it the user's score. The caller classifies; this returns the
   * population.
   */
  async listForUser(userId: string): Promise<AssetPermissionRecord[]> {
    const { data, error } = await this.db
      .from("asset_permissions")
      .select("*")
      .eq("user_id", userId);

    if (error) throw new AssetPermissionStoreError();
    return (data ?? []).map(toRecord);
  }

  /**
   * Active permissions with broad scope — R-004's population and ADR-004's
   * numerator.
   *
   * Both predicates, matching the partial index. A revoked broad permission is
   * not current exposure, and counting it would mean revoking never improved the
   * score.
   */
  async listBroadActive(userId: string): Promise<AssetPermissionRecord[]> {
    const { data, error } = await this.db
      .from("asset_permissions")
      .select("*")
      .eq("user_id", userId)
      .eq("scope", "broad")
      .eq("status", "active");

    if (error) throw new AssetPermissionStoreError();
    return (data ?? []).map(toRecord);
  }

  /**
   * Active permissions not verified since `before` — R-005's population.
   *
   * Rows with a null `last_verified_at` are **included**: never verified is at
   * least as stale as verified long ago, and a rule that skipped them would let
   * the least-checked permissions escape the check entirely.
   */
  async listStale(userId: string, before: string): Promise<AssetPermissionRecord[]> {
    const { data, error } = await this.db
      .from("asset_permissions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .or(`last_verified_at.is.null,last_verified_at.lt.${before}`);

    if (error) throw new AssetPermissionStoreError();
    return (data ?? []).map(toRecord);
  }

  /**
   * Changes a permission's status — the revoke path.
   *
   * An update rather than a delete, so the row stays in ADR-004's "total
   * recorded" denominator. That is what makes revoking improve the factor
   * instead of merely erasing the evidence.
   *
   * Scoped by `user_id` as well as `id`: without it, a caller holding any row id
   * would rewrite another user's record through service-role.
   */
  async setStatus(userId: string, id: string, status: PermissionStatus): Promise<boolean> {
    const { data, error } = await this.db
      .from("asset_permissions")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId)
      .select("id");

    if (error) throw new AssetPermissionStoreError();
    return (data ?? []).length > 0;
  }

  /**
   * Deletes a permission recorded by mistake.
   *
   * Distinct from revoking. Revoking is a fact about the world worth keeping;
   * this is for a row that was never true, where leaving it would both mislead
   * the user and skew their own score.
   */
  async remove(userId: string, id: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("asset_permissions")
      .delete()
      .eq("id", id)
      .eq("user_id", userId)
      .select("id");

    if (error) throw new AssetPermissionStoreError();
    return (data ?? []).length > 0;
  }
}
