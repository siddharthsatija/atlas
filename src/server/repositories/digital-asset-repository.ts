import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database.generated";
import { EncryptionService } from "@/server/crypto/encryption-service";
import { redactAssetMetadata, type AssetMetadata } from "@/lib/assets/asset-metadata";
import type { AssetQuery } from "@/lib/assets/asset-query";
import {
  DEFAULT_ASSET_CONFIDENCE,
  DEFAULT_ASSET_SOURCE_TYPE,
  DEFAULT_ASSET_STATUS,
  type AssetConfidence,
  type AssetSourceType,
  type AssetStatus,
} from "@/lib/assets/asset-fields";
import { logger } from "@/lib/telemetry/logger";

/**
 * Data access for `digital_assets` (ATL-027).
 *
 * Owns exactly one thing beyond storage: the encryption round trip for
 * `account_identifier_encrypted`. Authorized CRUD, archive/restore, activity
 * events, and findings recompute are **ATL-030**, which will call this.
 *
 * Used with the **service-role** client, which bypasses RLS, so ownership is
 * filtered explicitly in every query. A missing `user_id` predicate here would
 * silently operate on somebody else's assets — the policies exist as the second
 * gate, not as this layer's excuse to omit the first.
 */

export const AAD_TABLE = "digital_assets";
export const AAD_COLUMN = "account_identifier_encrypted";

export type DigitalAssetRow = Database["public"]["Tables"]["digital_assets"]["Row"];

/**
 * An asset as the application sees it.
 *
 * `accountIdentifier` is **absent**, not null-when-unread. Decryption costs a key
 * fetch per record, and the asset list never needs it — §8 puts identifiers
 * behind masking (ATL-035) and forbids them in URLs. A field that were sometimes
 * populated would invite a caller to render whatever happened to be there.
 * `readAccountIdentifier` is the deliberate, single way to obtain one.
 */
export interface DigitalAssetRecord {
  id: string;
  userId: string;
  serviceName: string;
  serviceDomain: string | null;
  category: string;
  /** Whether an identifier is stored, without revealing it. */
  hasAccountIdentifier: boolean;
  status: AssetStatus;
  sourceType: AssetSourceType;
  sourceLabel: string | null;
  confidence: AssetConfidence;
  lastVerifiedAt: string | null;
  notes: string | null;
  metadata: AssetMetadata;
  createdAt: string;
  updatedAt: string;
  /** Present when source_type = 'discovery'; the candidate that produced this asset (ATL-208). */
  candidateId: string | null;
  /** Non-null when the asset has been soft-deleted by a deconfirm (ATL-208). */
  deletedAt: string | null;
}

function toRecord(row: DigitalAssetRow): DigitalAssetRecord {
  return {
    id: row.id,
    userId: row.user_id,
    serviceName: row.service_name,
    serviceDomain: row.service_domain,
    category: row.category,
    hasAccountIdentifier: row.account_identifier_encrypted !== null,
    status: row.status as AssetStatus,
    sourceType: row.source_type as AssetSourceType,
    sourceLabel: row.source_label,
    confidence: row.confidence as AssetConfidence,
    lastVerifiedAt: row.last_verified_at,
    notes: row.notes,
    // Re-filtered on read as well as write: a row written before a policy
    // narrowed, or by anything that bypassed this repository, must not hand a
    // caller a value the allowlist would reject today.
    metadata: redactAssetMetadata((row.metadata_json ?? {}) as AssetMetadata).value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    candidateId: row.candidate_id ?? null,
    deletedAt: row.deleted_at ?? null,
  };
}

/** Raised for any asset storage failure. Carries no database detail. */
export class DigitalAssetStoreError extends Error {
  constructor() {
    super("digital asset store unavailable");
    this.name = "DigitalAssetStoreError";
  }
}

export interface CreateDigitalAssetInput {
  userId: string;
  serviceName: string;
  category: string;
  serviceDomain?: string | null;
  /** Plaintext. Encrypted before it reaches the database, never stored as given. */
  accountIdentifier?: string | null;
  status?: AssetStatus;
  sourceType?: AssetSourceType;
  sourceLabel?: string | null;
  confidence?: AssetConfidence;
  lastVerifiedAt?: string | null;
  notes?: string | null;
  metadata?: AssetMetadata;
  /**
   * The discovery candidate that produced this asset (ATL-208).
   * Required when source_type = 'discovery' (ATL-200 pairing constraint).
   * The confirm RPC sets this; direct creates via this method may also set it.
   */
  candidateId?: string | null;
}

/**
 * The fields an update may change.
 *
 * Deliberately narrower than the row. `user_id` is absent because ownership is
 * never editable; `status` is absent because lifecycle moves through
 * `setStatus`, which can make the transition conditional; and
 * `account_identifier_encrypted` is absent because changing it means
 * re-encrypting against the same AAD, which belongs with the reveal/edit flow
 * ATL-033 and ATL-035 own.
 */
export interface UpdateDigitalAssetInput {
  serviceName?: string;
  serviceDomain?: string | null;
  category?: string;
  sourceLabel?: string | null;
  confidence?: AssetConfidence;
  lastVerifiedAt?: string | null;
  notes?: string | null;
  metadata?: AssetMetadata;
}

export class DigitalAssetRepository {
  private readonly db: SupabaseClient<Database>;
  private readonly crypto: EncryptionService;

  constructor(db: SupabaseClient<Database>, crypto?: EncryptionService) {
    this.db = db;
    this.crypto = crypto ?? new EncryptionService(db);
  }

  /**
   * Creates one asset, encrypting the identifier if there is one.
   *
   * The row id is generated here rather than by the database default. ADR-003
   * binds the AAD to `digital_assets.account_identifier_encrypted:<record id>`,
   * so the id has to exist before the ciphertext does — and generating it in the
   * application is what lets the encrypt and the insert be a single round trip
   * instead of an insert followed by an update that could fail in between,
   * leaving a row whose identifier is permanently unreadable.
   */
  async create(input: CreateDigitalAssetInput): Promise<DigitalAssetRecord> {
    const id = randomUUID();

    const { value: metadata, droppedKeys, redactedKeys } = redactAssetMetadata(input.metadata);
    if (droppedKeys.length > 0 || redactedKeys.length > 0) {
      /**
       * Counts only — never the keys, and never the values. A dropped key name
       * can itself describe the user ("employerEmail"), and the whole point of
       * the drop was that the value did not belong in storage.
       */
      logger.warn("asset.metadata_filtered", {
        operation: "asset.create",
        count: droppedKeys.length + redactedKeys.length,
      });
    }

    const identifier = input.accountIdentifier?.trim();
    const encrypted = identifier
      ? await this.crypto.encrypt(input.userId, identifier, {
          table: AAD_TABLE,
          column: AAD_COLUMN,
          recordId: id,
        })
      : null;

    const { data, error } = await this.db
      .from("digital_assets")
      .insert({
        id,
        user_id: input.userId,
        service_name: input.serviceName,
        category: input.category,
        service_domain: input.serviceDomain ?? null,
        account_identifier_encrypted: encrypted,
        status: input.status ?? DEFAULT_ASSET_STATUS,
        source_type: input.sourceType ?? DEFAULT_ASSET_SOURCE_TYPE,
        source_label: input.sourceLabel ?? null,
        confidence: input.confidence ?? DEFAULT_ASSET_CONFIDENCE,
        last_verified_at: input.lastVerifiedAt ?? null,
        notes: input.notes ?? null,
        metadata_json: metadata as Json,
        candidate_id: input.candidateId ?? null,
      })
      .select("*")
      .single();

    if (error || !data) throw new DigitalAssetStoreError();
    return toRecord(data);
  }

  /** One asset, scoped to its owner. Returns null rather than throwing on a miss. */
  async find(userId: string, assetId: string): Promise<DigitalAssetRecord | null> {
    const { data, error } = await this.db
      .from("digital_assets")
      .select("*")
      .eq("id", assetId)
      // Ownership is a predicate, not an assumption. Without it, a caller
      // holding any asset id would read another user's row through service-role.
      .eq("user_id", userId)
      // Exclude soft-deleted assets (deconfirmed discovery assets — ATL-208).
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw new DigitalAssetStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * One page of a user's assets, filtered and keyset-paginated (ATL-030).
   *
   * Fetches `limit + 1` rows so the caller can tell "there is more" from the
   * extra row rather than paying for a second count query on every page.
   *
   * The ordering is `(created_at desc, id desc)` — the exact shape of
   * `digital_assets_status_idx` and `digital_assets_category_idx`, so a filtered
   * page is an index scan rather than a scan plus a sort. The `id` tiebreak is
   * what makes the ordering total; without it two rows sharing a timestamp make
   * the page boundary ambiguous and cursor pagination can repeat or skip one.
   */
  async list(userId: string, query: AssetQuery): Promise<DigitalAssetRecord[]> {
    let builder = this.db
      .from("digital_assets")
      .select("*")
      .eq("user_id", userId)
      // Exclude soft-deleted assets (deconfirmed discovery assets — ATL-208).
      .is("deleted_at", null);

    if (query.category?.length) builder = builder.in("category", query.category);
    if (query.status?.length) builder = builder.in("status", query.status);
    if (query.source?.length) builder = builder.in("source_type", query.source);

    /**
     * ATL-036's default exclusion, executed rather than decided here.
     *
     * `parseAssetQuery` already resolved whether it applies — an explicit status
     * turns it off — so this is one predicate on the query that was going to run
     * anyway, not a second read and not a policy this layer owns.
     *
     * `listAllForUser` deliberately has no equivalent: the rules engine needs
     * every status, and R-006 reads archived assets specifically.
     */
    if (query.excludeArchived) builder = builder.neq("status", "archived");

    if (query.reviewedBefore) {
      // Never-verified assets are included: they are at least as stale as
      // anything verified long ago, and hiding them would conceal exactly the
      // assets most in need of review.
      builder = builder.or(`last_verified_at.is.null,last_verified_at.lt.${query.reviewedBefore}`);
    }

    if (query.search) {
      /**
       * Search over the two non-restricted text columns (ATL-031).
       *
       * The term is **quoted and escaped** before it reaches PostgREST. An `or`
       * expression is a comma-separated mini-language, so a raw term containing
       * `,` or `)` would not merely fail — it would let a user rewrite the
       * filter, which on a service-role client is a query-injection surface
       * rather than a formatting bug. Quoting confines the value; escaping
       * backslash and quote closes the way out of the quotes.
       */
      const escaped = query.search.replace(/[\\"]/g, "\\$&");
      builder = builder.or(`service_name.ilike."*${escaped}*",service_domain.ilike."*${escaped}*"`);
    }

    if (query.cursor) {
      /**
       * The keyset predicate, written as a compound rather than PostgREST's
       * row-value syntax — which it does not support (the same constraint
       * ATL-104 recorded). Reads as: strictly older, or the same instant with a
       * smaller id.
       */
      const { createdAt, id } = query.cursor;
      builder = builder.or(
        `created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`,
      );
    }

    const ascending = query.sort === "oldest";

    const { data, error } = await builder
      .order("created_at", { ascending })
      .order("id", { ascending })
      .limit(query.limit + 1);

    if (error) throw new DigitalAssetStoreError();
    return (data ?? []).map(toRecord);
  }

  /**
   * Applies an ownership-scoped partial update.
   *
   * `updated_at` is **not** set here. `digital_assets_set_updated_at` (ATL-113)
   * maintains it from the database clock, which is what the ordering and the
   * staleness rules are compared against — a timestamp supplied by every caller
   * is one that is eventually wrong, and one supplied by a *different clock*
   * than the constraint judging it is wrong on a schedule.
   *
   * Returns null when nothing matched — which covers both "no such asset" and
   * "not yours", deliberately indistinguishable at this layer.
   */
  /**
   * Every asset the user has, whatever its status.
   *
   * `list` is keyset-paginated for the UI; the rules engine (ATL-101) needs the
   * whole set in one snapshot, and every status matters — R-002 reads inactive
   * assets and R-006 reads archived ones, so a status filter here would make
   * those rules silently unable to fire.
   */
  async listAllForUser(userId: string): Promise<DigitalAssetRecord[]> {
    const { data, error } = await this.db
      .from("digital_assets")
      .select("*")
      .eq("user_id", userId)
      // Exclude soft-deleted assets (deconfirmed discovery assets — ATL-208).
      // Soft-deleted rows are rejected candidates; the rules engine must not
      // reason from them — they carry no live exposure.
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) throw new DigitalAssetStoreError();
    return (data ?? []).map(toRecord);
  }

  async update(
    userId: string,
    assetId: string,
    changes: UpdateDigitalAssetInput,
  ): Promise<DigitalAssetRecord | null> {
    const patch: Database["public"]["Tables"]["digital_assets"]["Update"] = {};

    if (changes.serviceName !== undefined) patch.service_name = changes.serviceName;
    if (changes.serviceDomain !== undefined) patch.service_domain = changes.serviceDomain;
    if (changes.category !== undefined) patch.category = changes.category;
    if (changes.sourceLabel !== undefined) patch.source_label = changes.sourceLabel;
    if (changes.confidence !== undefined) patch.confidence = changes.confidence;
    if (changes.lastVerifiedAt !== undefined) patch.last_verified_at = changes.lastVerifiedAt;
    if (changes.notes !== undefined) patch.notes = changes.notes;
    if (changes.metadata !== undefined) {
      patch.metadata_json = redactAssetMetadata(changes.metadata).value as Json;
    }

    const { data, error } = await this.db
      .from("digital_assets")
      .update(patch)
      .eq("id", assetId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();

    if (error) throw new DigitalAssetStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * Moves an asset between lifecycle states, optionally requiring a current one.
   *
   * `expectedStatus` makes the transition conditional in SQL rather than in the
   * service. Checking first and then updating leaves a window in which two
   * requests both read `active` and both archive — harmless here, but the same
   * shape as the double-completion bug ATL-104 exists to prevent, and free to
   * design out.
   */
  async setStatus(
    userId: string,
    assetId: string,
    status: AssetStatus,
    expectedStatus?: AssetStatus,
  ): Promise<DigitalAssetRecord | null> {
    let builder = this.db
      .from("digital_assets")
      .update({ status })
      .eq("id", assetId)
      .eq("user_id", userId);

    if (expectedStatus) builder = builder.eq("status", expectedStatus);

    const { data, error } = await builder.select("*").maybeSingle();

    if (error) throw new DigitalAssetStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * Permanently removes an asset and everything hanging off it.
   *
   * The child tables cascade in the database (ATL-028, ATL-029), so this is one
   * statement rather than an application-level fan-out that could partially
   * fail. Returns whether a row actually went, so the caller can tell "deleted"
   * from "was not yours".
   */
  async remove(userId: string, assetId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("digital_assets")
      .delete()
      .eq("id", assetId)
      .eq("user_id", userId)
      .select("id");

    if (error) throw new DigitalAssetStoreError();
    return (data ?? []).length > 0;
  }

  /**
   * Soft-deletes an asset by setting `deleted_at` (ATL-208 deconfirm).
   *
   * The deconfirm RPC performs the soft-delete atomically; this method exists
   * as a standalone escape hatch. Idempotent: if `deleted_at` is already set
   * (already soft-deleted), the WHERE clause matches 0 rows and returns false.
   *
   * Returns true when a row was actually updated, false when the asset was not
   * found, not owned by the user, or already soft-deleted.
   */
  async softDelete(userId: string, assetId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("digital_assets")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", assetId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .select("id");

    if (error) throw new DigitalAssetStoreError();
    return (data ?? []).length > 0;
  }

  /**
   * Finds the asset linked to a discovery candidate, regardless of `deleted_at`.
   *
   * The `deleted_at IS NULL` exclusion is deliberately absent here.  The
   * deconfirm flow must be able to verify an asset exists even after it has
   * been soft-deleted (idempotency on retry), so filtering it out would break
   * re-entrant deconfirm.
   *
   * Throws `DigitalAssetStoreError` on a database error; returns null when no
   * row matches `(user_id, candidate_id)` (covers both "not found" and
   * "not yours" — non-oracle pattern).
   */
  async findByCandidateId(userId: string, candidateId: string): Promise<DigitalAssetRecord | null> {
    const { data, error } = await this.db
      .from("digital_assets")
      .select("*")
      .eq("user_id", userId)
      .eq("candidate_id", candidateId)
      .maybeSingle();

    if (error) throw new DigitalAssetStoreError();
    return data ? toRecord(data) : null;
  }

  /**
   * Decrypts the account identifier.
   *
   * Separate from `find` on purpose. Security §8 masks identifiers by default
   * and ATL-035 owns reveal, which is an explicit, audited user action — so
   * obtaining plaintext is a distinct call a reviewer can find, not a property
   * that arrives with every read.
   *
   * Returns null when the asset has no identifier or does not belong to the
   * user. The two are not distinguished: telling a caller that an asset exists
   * but is not theirs is the leak ATL-034 avoids by returning 404 rather than
   * 403.
   */
  async readAccountIdentifier(userId: string, assetId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("digital_assets")
      .select("id, account_identifier_encrypted")
      .eq("id", assetId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw new DigitalAssetStoreError();
    if (!data?.account_identifier_encrypted) return null;

    // Fail-closed by design: `decrypt` throws on a bad envelope or a shredded
    // key rather than returning a placeholder a UI might render.
    return this.crypto.decrypt(userId, data.account_identifier_encrypted, {
      table: AAD_TABLE,
      column: AAD_COLUMN,
      recordId: data.id,
    });
  }
}
