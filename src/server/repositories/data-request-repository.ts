import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { EncryptionService } from "@/server/crypto/encryption-service";
import { maskValue } from "@/lib/formatting/mask";
import { isPersonalFieldKey, type PersonalFieldKey } from "@/lib/personal-fields";
import {
  EXTERNAL_REFERENCE_MAX_LENGTH,
  type DeliveryMethod,
  type RequestStatus,
  type RequestType,
} from "@/lib/requests/requests";

/**
 * Data access for `data_requests` (ATL-056, architecture §7.7, ADR-003).
 *
 * Owns exactly one thing beyond storage: the encryption round trip for the four
 * restricted columns. It does **not** validate transitions — `status` is written
 * here as a value like any other, and deciding whether a move is legal, claiming
 * an idempotency key, writing the `request_events` row and emitting audit and
 * activity are all ATL-057's. A repository that decided whether a transition was
 * allowed would put the rule and the write in one place, and the rule would be
 * as easy to bypass as calling the other method.
 *
 * Used with the **service-role** client, which bypasses RLS, so ownership is
 * filtered explicitly in every query. The policies are the second gate, not this
 * layer's excuse to omit the first.
 *
 * ## Four columns, four AADs
 *
 * `recipient_encrypted`, `subject_encrypted`, `body_encrypted` and
 * `last_status_note` are each sealed against `data_requests.<column>:<row id>`,
 * so a ciphertext cannot be moved between rows **or** between columns — pasting
 * a body into the recipient field fails to decrypt rather than silently
 * succeeding. That requires the row id to exist before any value is sealed, so
 * the application generates it (`randomUUID()`) rather than relying on the
 * column default, exactly as `digital_assets.account_identifier_encrypted` and
 * `user_personal_fields.value_encrypted` do.
 *
 * `last_status_note` keeps §7.7's column name and is encrypted anyway — the
 * migration comment and security §8's inventory both record that, because a
 * name without the `_encrypted` suffix is the one thing that could mislead a
 * later reader here.
 *
 * ## Plaintext has narrow doors
 *
 * `DataRequestRecord` carries **no restricted value at all** — not the
 * plaintext, not a mask. `readContent` is the single way to obtain the draft in
 * full, and `readMaskedRecipient` is the list view's read, which decrypts and
 * masks inside the method so it cannot return plaintext through that path. Same
 * shape as `AssetService.readMaskedAccountIdentifier`, and for the same reason:
 * a useful mask (`a•••@example.com`) requires the plaintext, so masking the
 * ciphertext would hand every request an identical meaningless placeholder.
 */

export type DataRequestRow = Database["public"]["Tables"]["data_requests"]["Row"];

export const AAD_TABLE = "data_requests";
export const AAD_RECIPIENT = "recipient_encrypted";
export const AAD_SUBJECT = "subject_encrypted";
export const AAD_BODY = "body_encrypted";
export const AAD_STATUS_NOTE = "last_status_note";

/**
 * One request as the application sees it, carrying no restricted value.
 *
 * `hasRecipient` and friends exist because a surface has to know whether a draft
 * is complete without being handed the content to find out — frontend §10's
 * Step 3 enables "Mark sent" only once there is something to send.
 */
export interface DataRequestRecord {
  id: string;
  userId: string;
  assetId: string;
  requestType: RequestType;
  status: RequestStatus;
  /** Approved personal-field keys. Never values (ADR-002, FR-08). */
  includedFieldKeys: PersonalFieldKey[];
  deliveryMethod: DeliveryMethod | null;
  sentAt: string | null;
  followUpAt: string | null;
  completedAt: string | null;
  externalReference: string | null;
  hasRecipient: boolean;
  hasSubject: boolean;
  hasBody: boolean;
  hasStatusNote: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The restricted half, decrypted. Returned only by `readContent`. */
export interface DataRequestContent {
  recipient: string | null;
  subject: string | null;
  body: string | null;
  lastStatusNote: string | null;
}

export interface CreateDataRequestInput {
  userId: string;
  assetId: string;
  requestType: RequestType;
  /** Optional at creation: a draft exists before Step 1 is finished. */
  recipient?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  includedFieldKeys?: readonly PersonalFieldKey[] | undefined;
}

/**
 * What a caller may change on an existing request.
 *
 * **`status` is absent, deliberately.** Moving a request through §13's lifecycle
 * is a transition, not an edit, and ATL-057 owns it — including validation,
 * idempotency and the two event writes. `updateStatus` below is the seam it will
 * call, kept separate so no caller can change a status by accident while editing
 * a subject line.
 */
export interface UpdateDataRequestInput {
  recipient?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  lastStatusNote?: string | undefined;
  includedFieldKeys?: readonly PersonalFieldKey[] | undefined;
  deliveryMethod?: DeliveryMethod | undefined;
  externalReference?: string | null | undefined;
  followUpAt?: string | null | undefined;
}

/** The lifecycle fields a transition may stamp alongside the new status. */
export interface StatusStampInput {
  sentAt?: string | undefined;
  completedAt?: string | null | undefined;
  followUpAt?: string | null | undefined;
  deliveryMethod?: DeliveryMethod | undefined;
}

export class DataRequestStoreError extends Error {
  constructor(operation: string) {
    super(`data request store failed: ${operation}`);
    this.name = "DataRequestStoreError";
  }
}

/** Raised when a field key outside the ADR-002 vocabulary is offered. */
export class UnknownPersonalFieldKeyError extends Error {
  constructor() {
    super("included field key is not in the personal-field vocabulary");
    this.name = "UnknownPersonalFieldKeyError";
  }
}

/** Raised when an external reference exceeds its cap (D10). */
export class ExternalReferenceTooLongError extends Error {
  constructor() {
    super("external reference exceeds the permitted length");
    this.name = "ExternalReferenceTooLongError";
  }
}

/**
 * The non-restricted columns.
 *
 * The four encrypted columns are absent by design: only `readContent` and
 * `readMaskedRecipient` select them, and only for the row they are about to
 * decrypt — so no record-returning query carries an envelope on an object a
 * surface renders.
 */
/**
 * One string literal, never a concatenation.
 *
 * `.select()` is generic over the **literal type** of what it is given: supabase-js
 * parses that literal at compile time to derive the row shape. TypeScript widens
 * `"a" + "b"` to plain `string`, and a `string` the parser cannot read resolves to
 * `GenericStringError` — so every `.select(COLUMNS)` in this file silently lost the
 * generated row type and `toRecord` was handed an error object instead of a row.
 * Splitting this list across concatenated lines for width is the whole cause.
 */
const COLUMNS =
  "id, user_id, asset_id, request_type, status, included_fields_json, delivery_method, sent_at, follow_up_at, completed_at, external_reference, created_at, updated_at, recipient_encrypted, subject_encrypted, body_encrypted, last_status_note";

export class DataRequestRepository {
  private readonly db: SupabaseClient<Database>;
  private readonly crypto: EncryptionService;

  constructor(db: SupabaseClient<Database>, crypto?: EncryptionService) {
    this.db = db;
    this.crypto = crypto ?? new EncryptionService(db);
  }

  /**
   * Creates one request, encrypting whatever restricted content it was given.
   *
   * The id is generated here rather than by the column default, because each
   * AAD binds its ciphertext to `data_requests.<column>:<id>` and the id
   * therefore has to exist before any value is sealed.
   */
  async create(input: CreateDataRequestInput): Promise<DataRequestRecord> {
    const id = randomUUID();
    const keys = normaliseKeys(input.includedFieldKeys);

    /**
     * Each value is sealed only if it was supplied. The absence check belongs at
     * the call site rather than inside `seal`, because "encrypt nothing" is not a
     * meaningful operation — and a `seal` that returned `string | undefined` made
     * every patch assignment below optional-typed for no reason, which is what
     * `exactOptionalPropertyTypes` correctly refuses.
     */
    const [recipient, subject, body] = await Promise.all([
      input.recipient === undefined
        ? undefined
        : this.seal(input.userId, id, AAD_RECIPIENT, input.recipient),
      input.subject === undefined
        ? undefined
        : this.seal(input.userId, id, AAD_SUBJECT, input.subject),
      input.body === undefined ? undefined : this.seal(input.userId, id, AAD_BODY, input.body),
    ]);

    const { data, error } = await this.db
      .from("data_requests")
      .insert({
        id,
        user_id: input.userId,
        asset_id: input.assetId,
        request_type: input.requestType,
        included_fields_json: keys,
        ...(recipient === undefined ? {} : { recipient_encrypted: recipient }),
        ...(subject === undefined ? {} : { subject_encrypted: subject }),
        ...(body === undefined ? {} : { body_encrypted: body }),
      })
      .select(COLUMNS)
      .single();

    if (error || !data) throw new DataRequestStoreError("create");
    return toRecord(data);
  }

  /** One person's requests, newest first (frontend §9). */
  async list(userId: string): Promise<DataRequestRecord[]> {
    const { data, error } = await this.db
      .from("data_requests")
      .select(COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) throw new DataRequestStoreError("list");
    return (data ?? []).map(toRecord);
  }

  /** The requests about one service, for the asset detail section. */
  async listForAsset(userId: string, assetId: string): Promise<DataRequestRecord[]> {
    const { data, error } = await this.db
      .from("data_requests")
      .select(COLUMNS)
      .eq("user_id", userId)
      .eq("asset_id", assetId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) throw new DataRequestStoreError("list for asset");
    return (data ?? []).map(toRecord);
  }

  /**
   * Requests still in `sent` whose `sent_at` is older than `cutoff` (ATL-057).
   *
   * The read behind §13's three-day `sent -> awaiting_response` job. **Crosses
   * users deliberately** — a sweep is not about one person, and every other
   * method here is owner-scoped precisely because it serves a person's own
   * request. The job-read precedent is `NotificationRepository.purgeOlderThan`,
   * which is unscoped for the same reason.
   *
   * The predicate is the idempotency: only rows still in `sent` match, so a row
   * this run has already moved cannot be picked up by the next one. Bounded by
   * `limit` so one busy account cannot starve a run, and ordered oldest-first so
   * a backlog drains in the order it accumulated rather than by chance.
   */
  async listSentBefore(cutoff: string, limit: number): Promise<DataRequestRecord[]> {
    const { data, error } = await this.db
      .from("data_requests")
      .select(COLUMNS)
      .eq("status", "sent")
      .not("sent_at", "is", null)
      .lt("sent_at", cutoff)
      .order("sent_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit);

    if (error) throw new DataRequestStoreError("list sent before");
    return (data ?? []).map(toRecord);
  }

  /** One request, or null when it does not exist or is not this person's. */
  async find(userId: string, requestId: string): Promise<DataRequestRecord | null> {
    const { data, error } = await this.db
      .from("data_requests")
      .select(COLUMNS)
      .eq("user_id", userId)
      .eq("id", requestId)
      .maybeSingle();

    if (error) throw new DataRequestStoreError("find");
    return data ? toRecord(data) : null;
  }

  /**
   * Edits the draft. Re-encrypts each supplied value against the same AAD.
   *
   * The record id has not changed, so the AAD has not either. `updated_at` is
   * left to the shared trigger — no caller supplies it, so no caller can get it
   * wrong (ATL-113).
   *
   * Cannot change `status`: see `UpdateDataRequestInput`.
   */
  async update(
    userId: string,
    requestId: string,
    input: UpdateDataRequestInput,
  ): Promise<DataRequestRecord | null> {
    /**
     * The generated `Update` type, matching `digital-asset-repository.ts`. A
     * `Record<string, unknown>` compiles here but is rejected by `.update()`,
     * whose parameter rejects excess properties — and, worse, would accept a
     * misspelled column name that the database would then ignore.
     */
    const patch: Database["public"]["Tables"]["data_requests"]["Update"] = {};

    if (input.recipient !== undefined) {
      patch.recipient_encrypted = await this.seal(
        userId,
        requestId,
        AAD_RECIPIENT,
        input.recipient,
      );
    }
    if (input.subject !== undefined) {
      patch.subject_encrypted = await this.seal(userId, requestId, AAD_SUBJECT, input.subject);
    }
    if (input.body !== undefined) {
      patch.body_encrypted = await this.seal(userId, requestId, AAD_BODY, input.body);
    }
    if (input.lastStatusNote !== undefined) {
      patch.last_status_note = await this.seal(
        userId,
        requestId,
        AAD_STATUS_NOTE,
        input.lastStatusNote,
      );
    }
    if (input.includedFieldKeys !== undefined) {
      patch.included_fields_json = normaliseKeys(input.includedFieldKeys);
    }
    if (input.deliveryMethod !== undefined) patch.delivery_method = input.deliveryMethod;
    if (input.followUpAt !== undefined) patch.follow_up_at = input.followUpAt;
    if (input.externalReference !== undefined) {
      patch.external_reference = normaliseExternalReference(input.externalReference);
    }

    /** Nothing to change is not a failure, and must not clear anything. */
    if (Object.keys(patch).length === 0) return this.find(userId, requestId);

    const { data, error } = await this.db
      .from("data_requests")
      .update(patch)
      .eq("user_id", userId)
      .eq("id", requestId)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw new DataRequestStoreError("update");
    return data ? toRecord(data) : null;
  }

  /**
   * Writes a new status, with the lifecycle timestamps that belong to it.
   *
   * **The seam ATL-057 will call, and it validates nothing.** Whether the move is
   * legal is `isAllowedTransition`'s question and ATL-057's decision; whether it
   * has already happened is an idempotency key's; whether it is recorded is the
   * event writers'. This performs the write and no more, which is what keeps all
   * four obligations in one place upstream instead of split across two layers.
   *
   * `expectedStatus` is the optimistic-concurrency guard: the update matches
   * only while the row still holds the status the caller validated against, so
   * two concurrent transitions cannot both succeed. Returns null when nothing
   * matched — which ATL-057 reads as "the row moved underneath me" and, per the
   * non-oracle rule, is the same answer a missing or foreign request gives.
   */
  async updateStatus(
    userId: string,
    requestId: string,
    expectedStatus: RequestStatus,
    nextStatus: RequestStatus,
    stamp: StatusStampInput = {},
  ): Promise<DataRequestRecord | null> {
    const patch: Database["public"]["Tables"]["data_requests"]["Update"] = { status: nextStatus };

    if (stamp.sentAt !== undefined) patch.sent_at = stamp.sentAt;
    if (stamp.completedAt !== undefined) patch.completed_at = stamp.completedAt;
    if (stamp.followUpAt !== undefined) patch.follow_up_at = stamp.followUpAt;
    if (stamp.deliveryMethod !== undefined) patch.delivery_method = stamp.deliveryMethod;

    const { data, error } = await this.db
      .from("data_requests")
      .update(patch)
      .eq("user_id", userId)
      .eq("id", requestId)
      .eq("status", expectedStatus)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw new DataRequestStoreError("update status");
    return data ? toRecord(data) : null;
  }

  /**
   * The draft in full, decrypted. The only path to the restricted content.
   *
   * Returns null for a missing or foreign row rather than throwing, so the
   * service can answer `NOT_FOUND` identically for "no such request" and "not
   * yours" — the non-oracle rule ATL-030 established.
   */
  async readContent(userId: string, requestId: string): Promise<DataRequestContent | null> {
    const { data, error } = await this.db
      .from("data_requests")
      .select("id, recipient_encrypted, subject_encrypted, body_encrypted, last_status_note")
      .eq("user_id", userId)
      .eq("id", requestId)
      .maybeSingle();

    if (error) throw new DataRequestStoreError("read content");
    if (!data) return null;

    const [recipient, subject, body, lastStatusNote] = await Promise.all([
      this.open(userId, data.id, AAD_RECIPIENT, data.recipient_encrypted),
      this.open(userId, data.id, AAD_SUBJECT, data.subject_encrypted),
      this.open(userId, data.id, AAD_BODY, data.body_encrypted),
      this.open(userId, data.id, AAD_STATUS_NOTE, data.last_status_note),
    ]);

    return { recipient, subject, body, lastStatusNote };
  }

  /**
   * The recipient, masked. What §7.7 says list views show.
   *
   * Decrypt-then-mask, inside the method, so there is no way to obtain the full
   * address through this path at all — the shape
   * `AssetService.readMaskedAccountIdentifier` established. Masking the envelope
   * instead would give every request the same meaningless placeholder.
   *
   * Null when no recipient has been entered yet; a draft legitimately has none.
   */
  async readMaskedRecipient(userId: string, requestId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("data_requests")
      .select("id, recipient_encrypted")
      .eq("user_id", userId)
      .eq("id", requestId)
      .maybeSingle();

    if (error) throw new DataRequestStoreError("read masked recipient");
    if (!data?.recipient_encrypted) return null;

    const plaintext = await this.crypto.decrypt(userId, data.recipient_encrypted, {
      table: AAD_TABLE,
      column: AAD_RECIPIENT,
      recordId: data.id,
    });

    return maskValue(plaintext);
  }

  /** Encrypts one optional value, or reports that it was not supplied. */
  private async seal(
    userId: string,
    recordId: string,
    column: string,
    value: string,
  ): Promise<string> {
    return this.crypto.encrypt(userId, value, {
      table: AAD_TABLE,
      column,
      recordId,
    });
  }

  /** Decrypts one nullable envelope. */
  private async open(
    userId: string,
    recordId: string,
    column: string,
    envelope: string | null,
  ): Promise<string | null> {
    if (envelope === null) return null;

    return this.crypto.decrypt(userId, envelope, {
      table: AAD_TABLE,
      column,
      recordId,
    });
  }
}

/**
 * Validates the approved keys against ADR-002's vocabulary.
 *
 * Refused here rather than at the database, because the column is constrained
 * only to be a JSON array — a check constraint cannot enumerate array members
 * usefully, so this is the gate that keeps an unrecognised key out. A key
 * outside the vocabulary would name a personal field that cannot exist, and
 * ATL-050's subset check would later fail closed against it.
 */
function normaliseKeys(keys: readonly PersonalFieldKey[] | undefined): PersonalFieldKey[] {
  if (!keys) return [];

  for (const key of keys) {
    if (!isPersonalFieldKey(key)) throw new UnknownPersonalFieldKeyError();
  }

  /** Deduplicated: one approval per key, whatever the caller passed. */
  return [...new Set(keys)];
}

/** Enforces D10's cap at the boundary; the constraint is the second gate. */
function normaliseExternalReference(value: string | null): string | null {
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > EXTERNAL_REFERENCE_MAX_LENGTH) throw new ExternalReferenceTooLongError();

  return trimmed;
}

function toRecord(row: DataRequestRow): DataRequestRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    requestType: row.request_type as RequestType,
    status: row.status as RequestStatus,
    includedFieldKeys: readKeys(row.included_fields_json),
    deliveryMethod: (row.delivery_method as DeliveryMethod | null) ?? null,
    sentAt: row.sent_at,
    followUpAt: row.follow_up_at,
    completedAt: row.completed_at,
    externalReference: row.external_reference,
    hasRecipient: row.recipient_encrypted !== null,
    hasSubject: row.subject_encrypted !== null,
    hasBody: row.body_encrypted !== null,
    hasStatusNote: row.last_status_note !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reads the stored keys defensively.
 *
 * The column is user-influenced through an earlier write and constrained only to
 * be an array, so an unrecognised member is possible in principle — from an
 * older vocabulary, or a direct database edit. Unknown members are dropped
 * rather than surfaced: a key that names no field would render as a blank row in
 * the included-fields summary, and `parseOnboardingState` sets the precedent
 * that a malformed stored value degrades to something usable.
 */
function readKeys(value: unknown): PersonalFieldKey[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (entry): entry is PersonalFieldKey => typeof entry === "string" && isPersonalFieldKey(entry),
  );
}
