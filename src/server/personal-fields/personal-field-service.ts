import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { ApiErrorCode } from "@/lib/api/response-envelope";
import { maskValue } from "@/lib/formatting/mask";
import type { PersonalFieldKey } from "@/lib/personal-fields";
import { AuditWriter } from "@/server/audit/audit-writer";
import { ConsentService } from "@/server/consent/consent-service";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import {
  PersonalFieldRepository,
  type PersonalFieldRecord,
} from "@/server/repositories/personal-field-repository";
import { logger } from "@/lib/telemetry/logger";

/**
 * Personal-field storage and reads (ATL-105, ADR-002).
 *
 * ## The consent gate is here, and it only ever reads
 *
 * Every write requires an existing `personal_fields_storage` consent, and this
 * service **never creates one**. Consent is a user action, not a side effect of
 * persistence: a storage layer that manufactured a consent record would make the
 * record worthless as evidence that anyone agreed to anything. `ConsentService`
 * stays the single source of truth, the consent flow (ATL-106) records the
 * decision, and this refuses until it exists.
 *
 * The gate inherits `ConsentService.hasConsent`'s fail-closed behaviour: false
 * for never-decided, for revoked, and for a decision recorded against a
 * superseded policy version. Absence of a positive record is not permission.
 *
 * ## Masking is the default, plaintext is an event
 *
 * `listMasked` decrypts and masks, following
 * `AssetService.readMaskedAccountIdentifier` — masking happens inside the method
 * so there is no way to obtain the full value through it at all. `reveal` is the
 * only method that returns plaintext, it is an explicit user action, and it emits
 * `personal_field.revealed` (security §8), the event `asset-service.ts` already
 * uses for the equivalent action on an account identifier.
 *
 * ## What this ticket deliberately does not do
 *
 * Nothing here puts a personal field into AI context. ADR-002 requires
 * per-request approval and that step is ATL-058; `policy-map.ts` still supplies
 * no stored values to `draft_request`. Storage existing is not the same as
 * retrieval being permitted, and conflating the two is the failure this
 * separation prevents.
 */

export type PersonalFieldResult<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode };

const ok = <T>(data: T): PersonalFieldResult<T> => ({ ok: true, data });
const fail = <T>(code: ApiErrorCode): PersonalFieldResult<T> => ({ ok: false, code });

/** A field as a settings surface sees it: identified, labelled, masked. */
export interface MaskedPersonalField extends PersonalFieldRecord {
  /** Derived from the plaintext, then discarded. Never reversible. */
  maskedValue: string;
}

export interface SavePersonalFieldInput {
  fieldKey: PersonalFieldKey;
  label: string;
  value: string;
}

export interface EditPersonalFieldInput {
  label?: string | undefined;
  value?: string | undefined;
}

interface PersonalFieldDependencies {
  fields: PersonalFieldRepository;
  consent: ConsentService;
  audit: AuditWriter;
}

export class PersonalFieldService {
  private readonly fields: PersonalFieldRepository;
  private readonly consent: ConsentService;
  private readonly audit: AuditWriter;

  constructor(dependencies: PersonalFieldDependencies) {
    this.fields = dependencies.fields;
    this.consent = dependencies.consent;
    this.audit = dependencies.audit;
  }

  /** Uses the service-role client: every write here is server-side by design. */
  static create(db: SupabaseClient<Database> = createServiceRoleClient()): PersonalFieldService {
    return new PersonalFieldService({
      fields: new PersonalFieldRepository(db),
      consent: new ConsentService(db),
      audit: new AuditWriter(db),
    });
  }

  /** Whether storing identity fields is currently permitted for this person. */
  async isStoragePermitted(userId: string): Promise<boolean> {
    return this.consent.hasConsent(userId, "personal_fields_storage");
  }

  /**
   * Stores one field, if and only if consent already exists.
   *
   * `CONSENT_REQUIRED` rather than `FORBIDDEN`: the remedy is a consent prompt,
   * which is a control ATL-106 can offer, where `FORBIDDEN` would tell the
   * surface that nothing the person does will help.
   */
  async save(
    userId: string,
    input: SavePersonalFieldInput,
  ): Promise<PersonalFieldResult<PersonalFieldRecord>> {
    if (!(await this.isStoragePermitted(userId))) return fail("CONSENT_REQUIRED");

    const label = input.label.trim();
    const value = input.value.trim();
    if (label.length === 0 || value.length === 0) return fail("INVALID_REQUEST");

    try {
      return ok(await this.fields.create({ userId, fieldKey: input.fieldKey, label, value }));
    } catch (error) {
      return this.storeFailure("personalfields.save", error);
    }
  }

  /**
   * Edits a label, a value, or both — also gated.
   *
   * Revoking consent must not leave an editable vault: an edit writes restricted
   * data exactly as a save does, so it answers to the same gate.
   */
  async edit(
    userId: string,
    fieldId: string,
    input: EditPersonalFieldInput,
  ): Promise<PersonalFieldResult<PersonalFieldRecord>> {
    if (!(await this.isStoragePermitted(userId))) return fail("CONSENT_REQUIRED");

    const label = input.label?.trim();
    const value = input.value?.trim();
    if (label !== undefined && label.length === 0) return fail("INVALID_REQUEST");
    if (value !== undefined && value.length === 0) return fail("INVALID_REQUEST");

    try {
      const updated = await this.fields.update(userId, fieldId, {
        ...(label === undefined ? {} : { label }),
        ...(value === undefined ? {} : { value }),
      });
      return updated ? ok(updated) : fail("NOT_FOUND");
    } catch (error) {
      return this.storeFailure("personalfields.edit", error);
    }
  }

  /**
   * The person's fields with masked values.
   *
   * **Not consent-gated.** Reading back what is already stored is not a new act
   * of storage, and gating it would hide a person's own data from them the moment
   * they revoked — leaving values they can neither see nor decide about. Deletion
   * and reading stay available; only writing stops.
   */
  async listMasked(userId: string): Promise<PersonalFieldResult<MaskedPersonalField[]>> {
    try {
      const records = await this.fields.list(userId);

      const masked = await Promise.all(
        records.map(async (record) => {
          const plaintext = await this.fields.readValue(userId, record.id);
          return { ...record, maskedValue: plaintext ? maskValue(plaintext) : "" };
        }),
      );

      return ok(masked);
    } catch (error) {
      return this.storeFailure("personalfields.list", error);
    }
  }

  /**
   * One field's plaintext, for a deliberate reveal (ATL-035, security §8).
   *
   * The only method here that returns a stored value in full. Audited *after* the
   * value is obtained, so the event never claims a disclosure that failed — and
   * the context carries `reason` and `method` only, both allowlisted, neither
   * derived from the value.
   */
  async reveal(userId: string, fieldId: string): Promise<PersonalFieldResult<string>> {
    try {
      const plaintext = await this.fields.readValue(userId, fieldId);

      /**
       * Existence and ownership answered identically, so a guessed id cannot
       * become an oracle — the rule ATL-030 set and `asset-service` follows.
       */
      if (plaintext === null) return fail("NOT_FOUND");

      await this.audit.write({
        userId,
        eventType: "personal_field.revealed",
        actorType: "user",
        entityType: "personal_field",
        entityId: fieldId,
        context: { reason: "user_action", method: "ui" },
      });

      return ok(plaintext);
    } catch (error) {
      return this.storeFailure("personalfields.reveal", error);
    }
  }

  /**
   * Hard-deletes one field.
   *
   * **Not consent-gated**, deliberately: deletion is the safe direction, and a
   * gate here would mean a person who revoked consent could no longer remove the
   * values that revocation was about. ADR-002 makes every field deletable at any
   * time and security §14 repeats it.
   */
  async remove(userId: string, fieldId: string): Promise<PersonalFieldResult<{ id: string }>> {
    try {
      const removed = await this.fields.remove(userId, fieldId);
      return removed ? ok({ id: fieldId }) : fail("NOT_FOUND");
    } catch (error) {
      return this.storeFailure("personalfields.remove", error);
    }
  }

  /**
   * Stamps `last_used_at` on the fields a draft included (ADR-002).
   *
   * **No production caller yet.** The only thing that uses a field is a request
   * draft, which is ATL-058/ATL-059; this is the seam they will call. Implemented
   * and tested rather than deferred, so the column has a maintainer the moment
   * drafting lands — and no write is manufactured here to make it look busy.
   *
   * Not consent-gated: it records that an already-approved draft used a stored
   * value, which is a fact about the past rather than new storage.
   */
  async markUsed(
    userId: string,
    fieldIds: readonly string[],
  ): Promise<PersonalFieldResult<number>> {
    try {
      return ok(await this.fields.markUsed(userId, fieldIds));
    } catch (error) {
      return this.storeFailure("personalfields.markused", error);
    }
  }

  /**
   * One place where a store failure becomes a result.
   *
   * The caught error is never returned or logged as a value: it may carry a
   * database message, and §16 forbids those reaching a log sink. Only the
   * operation name and a code go out.
   *
   * `operation` values carry no underscore. `LOG_FIELD_POLICY` requires
   * /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/, so `personal_field.save` would fail
   * redaction and vanish from the record — a log line that looks complete and
   * silently is not. Two existing call sites have that defect
   * (`require-user.ts` "auth.verify_session", `asset-service.ts`
   * "asset.read_identifier"); this does not add a third.
   */
  private storeFailure<T>(operation: string, error: unknown): PersonalFieldResult<T> {
    logger.error("personal_field.store_failed", {
      operation,
      errorCode: error instanceof Error ? "STORE_ERROR" : "UNKNOWN_ERROR",
    });
    return fail("UNAVAILABLE");
  }
}
