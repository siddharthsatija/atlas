import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { EncryptionService } from "@/server/crypto/encryption-service";
import type { PersonalFieldKey } from "@/lib/personal-fields";

/**
 * Data access for `user_personal_fields` (ATL-105, ADR-002).
 *
 * Owns exactly one thing beyond storage: the encryption round trip for
 * `value_encrypted`. The consent gate is **not** here — it belongs to
 * `PersonalFieldService`, because a repository that decided whether it was
 * allowed to store something would put the permission check and the write in the
 * same place, and the check would be as easy to bypass as calling the other
 * method.
 *
 * Used with the **service-role** client, which bypasses RLS, so ownership is
 * filtered explicitly in every query. The policies are the second gate, not this
 * layer's excuse to omit the first.
 *
 * ## Plaintext has exactly one door
 *
 * `PersonalFieldRecord` carries **no value at all** — not the plaintext and not a
 * mask. `readValue` is the single way to obtain the real thing, which is the
 * shape `digital-asset-repository` uses for `accountIdentifier` and for the same
 * reason: a field that were *sometimes* populated would invite a caller to render
 * whatever happened to be there.
 *
 * Masking lives one layer up, in `PersonalFieldService.listMasked`, because a
 * useful mask requires the plaintext — `a•••@example.com` cannot be derived from
 * ciphertext. Masking the envelope instead would hand every field the same
 * meaningless placeholder and make the settings list unreadable, so this follows
 * `AssetService.readMaskedAccountIdentifier`: decrypt, then mask, and never
 * return the plaintext from the masking method.
 */

export const AAD_TABLE = "user_personal_fields";
export const AAD_COLUMN = "value_encrypted";

/** A stored field as the application sees it. Carries no value, masked or not. */
export interface PersonalFieldRecord {
  id: string;
  userId: string;
  fieldKey: PersonalFieldKey;
  label: string;
  lastUsedAt: string | null;
  /** ATL-204: whether this field is included in the discovery dispatch engine's eligible set. */
  includeInDiscovery: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePersonalFieldInput {
  userId: string;
  fieldKey: PersonalFieldKey;
  label: string;
  value: string;
}

/** Only what a person can edit. `fieldKey` is fixed at creation. */
export interface UpdatePersonalFieldInput {
  label?: string | undefined;
  value?: string | undefined;
}

export class PersonalFieldStoreError extends Error {
  constructor(operation: string) {
    super(`personal field store failed: ${operation}`);
    this.name = "PersonalFieldStoreError";
  }
}

const COLUMNS =
  "id, user_id, field_key, label, last_used_at, created_at, updated_at, include_in_discovery";

export class PersonalFieldRepository {
  private readonly db: SupabaseClient<Database>;
  private readonly crypto: EncryptionService;

  constructor(db: SupabaseClient<Database>, crypto?: EncryptionService) {
    this.db = db;
    this.crypto = crypto ?? new EncryptionService(db);
  }

  /**
   * Creates one field, encrypting the value.
   *
   * The id is generated here rather than by the column default, because the AAD
   * binds the ciphertext to `user_personal_fields.value_encrypted:<id>` and the
   * id therefore has to exist before the value is sealed. Generating it in the
   * application is what lets the encrypt and the insert be a single round trip.
   */
  async create(input: CreatePersonalFieldInput): Promise<PersonalFieldRecord> {
    const id = randomUUID();

    const valueEncrypted = await this.crypto.encrypt(input.userId, input.value, {
      table: AAD_TABLE,
      column: AAD_COLUMN,
      recordId: id,
    });

    const { data, error } = await this.db
      .from("user_personal_fields")
      .insert({
        id,
        user_id: input.userId,
        field_key: input.fieldKey,
        label: input.label,
        value_encrypted: valueEncrypted,
      })
      .select(COLUMNS)
      .single();

    if (error || !data) throw new PersonalFieldStoreError("create");
    return toRecord(data);
  }

  /** One person's fields, newest first. No values — see `readValue`. */
  async list(userId: string): Promise<PersonalFieldRecord[]> {
    const { data, error } = await this.db
      .from("user_personal_fields")
      .select(COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) throw new PersonalFieldStoreError("list");
    return (data ?? []).map(toRecord);
  }

  /** One field, or null when it does not exist or is not this person's. */
  async find(userId: string, fieldId: string): Promise<PersonalFieldRecord | null> {
    const { data, error } = await this.db
      .from("user_personal_fields")
      .select(COLUMNS)
      .eq("user_id", userId)
      .eq("id", fieldId)
      .maybeSingle();

    if (error) throw new PersonalFieldStoreError("find");
    return data ? toRecord(data) : null;
  }

  /**
   * Updates the label, the value, or both.
   *
   * A new value is re-encrypted against the **same** AAD, because the record id
   * has not changed. `updated_at` is left to the shared trigger — no caller
   * supplies it, so no caller can get it wrong.
   */
  async update(
    userId: string,
    fieldId: string,
    input: UpdatePersonalFieldInput,
  ): Promise<PersonalFieldRecord | null> {
    const patch: { label?: string; value_encrypted?: string } = {};

    if (input.label !== undefined) patch.label = input.label;

    if (input.value !== undefined) {
      patch.value_encrypted = await this.crypto.encrypt(userId, input.value, {
        table: AAD_TABLE,
        column: AAD_COLUMN,
        recordId: fieldId,
      });
    }

    /** Nothing to change is not a failure, and must not clear anything. */
    if (Object.keys(patch).length === 0) return this.find(userId, fieldId);

    const { data, error } = await this.db
      .from("user_personal_fields")
      .update(patch)
      .eq("user_id", userId)
      .eq("id", fieldId)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw new PersonalFieldStoreError("update");
    return data ? toRecord(data) : null;
  }

  /**
   * Hard delete. ADR-002 requires each field to be individually deletable, and
   * security §14 repeats it; there is no soft-delete column to set.
   *
   * Returns false when the row was already absent or is not this person's, so a
   * caller cannot report a deletion that did not happen.
   */
  async remove(userId: string, fieldId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("user_personal_fields")
      .delete()
      .eq("user_id", userId)
      .eq("id", fieldId)
      .select("id");

    if (error) throw new PersonalFieldStoreError("remove");
    return (data ?? []).length > 0;
  }

  /**
   * The plaintext, decrypted. The only path to it.
   *
   * Returns null rather than throwing for a missing or foreign row, so the
   * service can answer `NOT_FOUND` identically for "no such field" and "not
   * yours" — the same non-oracle behaviour ATL-030 established.
   */
  async readValue(userId: string, fieldId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("user_personal_fields")
      .select("id, value_encrypted")
      .eq("user_id", userId)
      .eq("id", fieldId)
      .maybeSingle();

    if (error) throw new PersonalFieldStoreError("read value");
    if (!data) return null;

    return this.crypto.decrypt(userId, data.value_encrypted, {
      table: AAD_TABLE,
      column: AAD_COLUMN,
      recordId: data.id,
    });
  }

  /**
   * Stamps `last_used_at` on the fields a draft actually included.
   *
   * Written from the database clock (`now()`), never the application's — ATL-113
   * removed the second clock from every lifecycle timestamp after an application
   * value was compared against a database constraint and lost the race.
   *
   * No production caller yet: the only thing that *uses* a field is a request
   * draft, which is ATL-058/ATL-059. The seam is implemented and tested rather
   * than deferred, so the column has a maintainer the moment drafting lands.
   *
   * Returns the number of rows stamped, so a caller cannot assume a key it
   * supplied matched anything.
   */
  async markUsed(userId: string, fieldIds: readonly string[]): Promise<number> {
    if (fieldIds.length === 0) return 0;

    const { data, error } = await this.db
      .from("user_personal_fields")
      .update({ last_used_at: new Date().toISOString() })
      .eq("user_id", userId)
      .in("id", [...fieldIds])
      .select("id");

    if (error) throw new PersonalFieldStoreError("mark used");
    return (data ?? []).length;
  }

  // ---------------------------------------------------------------------------
  // ATL-204: discovery eligibility
  // ---------------------------------------------------------------------------

  /**
   * Toggles `include_in_discovery` on one field.
   *
   * Only updates the `include_in_discovery` column. `value_encrypted` is never
   * re-encrypted and the record id does not change, so the AAD binding is
   * preserved exactly as it was created (ADR-008 §7). Ownership is enforced by
   * the `user_id` filter in the query.
   *
   * Returns `null` when the row is absent or belongs to another user, so the
   * caller receives the same response for both — non-oracle behaviour
   * established by ATL-030.
   */
  async setIncludeInDiscovery(
    userId: string,
    fieldId: string,
    enabled: boolean,
  ): Promise<PersonalFieldRecord | null> {
    const { data, error } = await this.db
      .from("user_personal_fields")
      .update({ include_in_discovery: enabled })
      .eq("user_id", userId)
      .eq("id", fieldId)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw new PersonalFieldStoreError("setIncludeInDiscovery");
    return data ? toRecord(data) : null;
  }

  /**
   * All fields for a user that have `include_in_discovery = true`.
   *
   * Returns records only — no values. The dispatch engine calls `readValue` for
   * each field it actually uses; returning values here would force decryption of
   * the full eligible set even when the caller only needs the field list.
   *
   * Ordered newest-first (same tiebreak as `list`) so the eligible set is stable
   * under concurrent inserts.
   */
  async listEligible(userId: string): Promise<PersonalFieldRecord[]> {
    const { data, error } = await this.db
      .from("user_personal_fields")
      .select(COLUMNS)
      .eq("user_id", userId)
      .eq("include_in_discovery", true)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) throw new PersonalFieldStoreError("listEligible");
    return (data ?? []).map(toRecord);
  }

  /**
   * Whether any in-progress discovery invocation references this field.
   *
   * "In-progress" is the ATL-201 lifecycle invariant: `invocation_status IS NULL`
   * in `discovery_provider_invocations`. Terminal values (`success`, `blocked`,
   * `error`, `rate_limited`) are not in-progress and do not block deletion.
   *
   * Two queries rather than a JOIN, because the composite FK on
   * `discovery_provider_invocation_fields` uses `(user_id, invocation_id)` and
   * PostgREST join filtering on composite keys is fragile across client versions.
   * Both queries are indexed: `discovery_provider_invocation_fields_field_idx` on
   * `(user_id, field_id)` and the primary key on `discovery_provider_invocations`.
   *
   * **Fail-closed contract**: any query error throws `PersonalFieldStoreError`.
   * The caller must treat a thrown error as a blocked deletion. A lookup failure
   * must never be treated as "no active reference found" — that would allow
   * deletion to corrupt an active run whose status could not be confirmed.
   */
  async hasActiveInvocationReference(userId: string, fieldId: string): Promise<boolean> {
    // Step 1: all invocation_ids for this (user, field) pair.
    const { data: fieldRefs, error: fieldError } = await this.db
      .from("discovery_provider_invocation_fields")
      .select("invocation_id")
      .eq("user_id", userId)
      .eq("field_id", fieldId);

    if (fieldError) throw new PersonalFieldStoreError("hasActiveInvocationReference");
    if (!fieldRefs || fieldRefs.length === 0) return false;

    const invocationIds = fieldRefs.map((r) => r.invocation_id);

    // Step 2: any of those invocations still non-terminal?
    const { data: active, error: activeError } = await this.db
      .from("discovery_provider_invocations")
      .select("id")
      .eq("user_id", userId)
      .in("id", invocationIds)
      .is("invocation_status", null)
      .limit(1);

    if (activeError) throw new PersonalFieldStoreError("hasActiveInvocationReference");
    return (active ?? []).length > 0;
  }
}

interface PersonalFieldRow {
  id: string;
  user_id: string;
  field_key: string;
  label: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  include_in_discovery: boolean;
}

/**
 * Row to record.
 *
 * `value_encrypted` is not in `COLUMNS` at all. Only `readValue` selects it, and
 * only for the row it is about to decrypt — so no record-returning query carries
 * an envelope on an object that surfaces render.
 */
function toRecord(row: PersonalFieldRow): PersonalFieldRecord {
  return {
    id: row.id,
    userId: row.user_id,
    fieldKey: row.field_key as PersonalFieldKey,
    label: row.label,
    lastUsedAt: row.last_used_at,
    includeInDiscovery: row.include_in_discovery,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
