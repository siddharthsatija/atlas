import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { sensitivityFor, type DataSensitivity } from "@/lib/assets/data-categories";
import type { AssetConfidence } from "@/lib/assets/asset-fields";

/**
 * Data access for `asset_data_categories` (ATL-028).
 *
 * Deliberately thin: this ticket owns the schema, and ATL-030 owns the service
 * layer that applies authorization, emits activity, and enqueues recompute.
 * What lives here is the ownership predicate every query needs and the read
 * shape callers will use.
 *
 * Nothing on this table is Restricted — security §3 classifies asset metadata as
 * Confidential and the §8 encrypted-column inventory names no column here — so
 * unlike `digital_assets` there is no encryption round trip. `description` is
 * free text and is treated accordingly: never logged, never sent to an AI prompt
 * without passing the redaction path first.
 *
 * Used with the **service-role** client, which bypasses RLS, so ownership is
 * filtered explicitly in every query. The policies are the second gate, not this
 * layer's excuse to skip the first.
 */

export type AssetDataCategoryRow = Database["public"]["Tables"]["asset_data_categories"]["Row"];

export interface AssetDataCategoryRecord {
  id: string;
  userId: string;
  assetId: string;
  category: string;
  /**
   * Derived from `category` by the database, never supplied.
   *
   * ADR-004 fixes the high-sensitivity set, and the score reads it — so a
   * writable value could disagree with the number it feeds.
   */
  sensitivity: DataSensitivity;
  description: string | null;
  source: string | null;
  confidence: AssetConfidence;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: AssetDataCategoryRow): AssetDataCategoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    category: row.category,
    /**
     * Falls back to the application mapping if the column is ever absent.
     *
     * Belt and braces: the database generates it, so this should never fire —
     * but a caller reading a partial projection would otherwise get `undefined`
     * where the score expects a level.
     */
    sensitivity: (row.sensitivity as DataSensitivity | null) ?? sensitivityFor(row.category),
    description: row.description,
    source: row.source,
    confidence: row.confidence as AssetConfidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Raised for any data-category storage failure. Carries no database detail. */
export class AssetDataCategoryStoreError extends Error {
  constructor() {
    super("asset data category store unavailable");
    this.name = "AssetDataCategoryStoreError";
  }
}

export interface RecordDataCategoryInput {
  userId: string;
  assetId: string;
  category: string;
  description?: string | null;
  source?: string | null;
  confidence?: AssetConfidence;
}

export class AssetDataCategoryRepository {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  /**
   * Records that an asset holds a category of data.
   *
   * `sensitivity` is never passed: it is a generated column, and Postgres
   * rejects a write to one outright (`428C9`). That refusal is the point — the
   * value cannot drift from ADR-004 even by accident.
   *
   * A cross-user pairing is impossible here regardless of what the caller
   * supplies: the composite foreign key on `(user_id, asset_id)` has no matching
   * parent unless the asset really belongs to that user.
   */
  async record(input: RecordDataCategoryInput): Promise<AssetDataCategoryRecord> {
    const { data, error } = await this.db
      .from("asset_data_categories")
      .insert({
        user_id: input.userId,
        asset_id: input.assetId,
        category: input.category,
        description: input.description ?? null,
        source: input.source ?? null,
        ...(input.confidence ? { confidence: input.confidence } : {}),
      })
      .select("*")
      .single();

    if (error || !data) throw new AssetDataCategoryStoreError();
    return toRecord(data);
  }

  /** Everything one asset holds — the "information held" section of frontend §7. */
  async listForAsset(userId: string, assetId: string): Promise<AssetDataCategoryRecord[]> {
    const { data, error } = await this.db
      .from("asset_data_categories")
      .select("*")
      .eq("user_id", userId)
      .eq("asset_id", assetId)
      .order("category", { ascending: true });

    if (error) throw new AssetDataCategoryStoreError();
    return (data ?? []).map(toRecord);
  }

  /**
   * Every high-sensitivity row for a user.
   *
   * Serves ADR-004's data-sensitivity factor and §11's R-003 and R-008, all of
   * which ask only about the high set. Filtered on the generated column so the
   * partial index applies and the definition of "high" stays in one place.
   */
  /**
   * Every category the user has recorded, across all their assets.
   *
   * The rules engine (ATL-101) evaluates a whole-footprint snapshot, so it needs
   * one query rather than one per asset. Added here rather than assembled by the
   * engine so the ownership predicate stays in the layer that owns it.
   */
  async listForUser(userId: string): Promise<AssetDataCategoryRecord[]> {
    const { data, error } = await this.db
      .from("asset_data_categories")
      .select("*")
      .eq("user_id", userId);

    if (error) throw new AssetDataCategoryStoreError();
    return (data ?? []).map(toRecord);
  }

  async listHighSensitivity(userId: string): Promise<AssetDataCategoryRecord[]> {
    const { data, error } = await this.db
      .from("asset_data_categories")
      .select("*")
      .eq("user_id", userId)
      .eq("sensitivity", "high");

    if (error) throw new AssetDataCategoryStoreError();
    return (data ?? []).map(toRecord);
  }

  /**
   * Removes one category from one asset.
   *
   * Scoped by `user_id` as well as `id`: without it, a caller holding any row id
   * would delete another user's record through service-role. Returns whether a
   * row actually went, so a caller can tell "removed" from "was not yours".
   */
  async remove(userId: string, id: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("asset_data_categories")
      .delete()
      .eq("id", id)
      .eq("user_id", userId)
      .select("id");

    if (error) throw new AssetDataCategoryStoreError();
    return (data ?? []).length > 0;
  }
}
