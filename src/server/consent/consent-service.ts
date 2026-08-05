import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { CONSENT_POLICY_VERSION } from "@/config/app";
import type { ConsentType } from "@/lib/consent";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { ConsentRepository, type ConsentRecord } from "@/server/repositories/consent-repository";
import { AuditWriter, emitEvent } from "@/server/audit/audit-writer";

/**
 * Consent recording and the server-side consent gate (ATL-078).
 *
 * Two responsibilities that belong together because they must not disagree:
 * writing what a user decided, and answering whether that decision currently
 * permits an operation.
 *
 * ## Append-only
 *
 * A grant and a revoke are both inserts. Current state is the newest row for a
 * `(user, consent_type)` pair. Nothing is ever edited, so
 * grant -> revoke -> re-grant is reconstructible from the table alone — which is
 * the property a consent record exists to provide.
 *
 * ## Every write is audited
 *
 * Security §12 lists consent changes in the audit inventory, so recording goes
 * through the ATL-103 emitter rather than writing the row directly. The audit
 * context carries the consent type and policy version — both allowlisted, both
 * free of personal data.
 *
 * ## The gate fails closed
 *
 * `hasConsent` returns false for "never decided", for "revoked", and for a
 * decision recorded against a superseded policy version. Absence of a positive
 * record is not permission.
 */

export interface ConsentDecision {
  record: ConsentRecord;
}

export class ConsentService {
  private readonly consents: ConsentRepository;
  private readonly audit: AuditWriter;

  constructor(db: SupabaseClient<Database>, audit?: AuditWriter) {
    this.consents = new ConsentRepository(db);
    this.audit = audit ?? new AuditWriter(db);
  }

  /** Uses the service-role client — writes bypass RLS and are server-only. */
  static create(): ConsentService {
    const db = createServiceRoleClient();
    return new ConsentService(db, new AuditWriter(db));
  }

  /**
   * Records a grant against the current policy version.
   *
   * The version is stamped from the server constant rather than accepted from
   * the caller: a value supplied by a client would let consent be recorded
   * against terms the user never saw.
   */
  async grant(userId: string, consentType: ConsentType): Promise<ConsentDecision> {
    return this.record(userId, consentType, true);
  }

  /**
   * Records a revocation.
   *
   * Also stamped with the *current* policy version rather than the version of
   * the grant being withdrawn. The row answers "what did the user decide, and
   * against which terms, at this moment" — rewriting history to match an older
   * grant would misstate when the withdrawal happened.
   */
  async revoke(userId: string, consentType: ConsentType): Promise<ConsentDecision> {
    return this.record(userId, consentType, false);
  }

  private async record(
    userId: string,
    consentType: ConsentType,
    granted: boolean,
  ): Promise<ConsentDecision> {
    const record = await this.consents.append(userId, consentType, CONSENT_POLICY_VERSION, granted);

    /**
     * Audited after the row exists, so an audit event never claims a consent
     * change that failed to persist. The reverse ordering would be worse in the
     * direction that matters: an unaudited write is a gap, but an audit entry
     * for a write that never happened is a false record.
     */
    await emitEvent(
      {
        audit: {
          userId,
          eventType: granted ? "consent.granted" : "consent.revoked",
          actorType: "user",
          entityType: "consent",
          entityId: record.id,
          context: { consentType, policyVersion: record.policyVersion },
        },
      },
      this.audit,
    );

    return { record };
  }

  /**
   * The gate. True only when the newest decision is a grant against the current
   * policy version.
   *
   * Three distinct situations all deny, and all three are deliberate:
   *
   *  - **Never decided.** Silence is not consent.
   *  - **Revoked.** The newest row says no.
   *  - **Stale policy version.** The user agreed to terms that have since
   *    changed, so the agreement no longer covers what would happen now.
   *    Treating an old grant as current would be the one failure mode with legal
   *    consequences, so it denies and the surface re-asks.
   */
  async hasConsent(userId: string, consentType: ConsentType): Promise<boolean> {
    const latest = await this.consents.latestFor(userId, consentType);
    if (!latest) return false;
    return latest.granted && latest.policyVersion === CONSENT_POLICY_VERSION;
  }

  /**
   * Whether re-consent is needed: previously granted, but under older terms.
   *
   * Distinct from `hasConsent` returning false, because the surfaces differ — a
   * user who never decided is asked, while a user whose grant went stale is told
   * what changed.
   */
  async needsReconsent(userId: string, consentType: ConsentType): Promise<boolean> {
    const latest = await this.consents.latestFor(userId, consentType);
    if (!latest) return false;
    return latest.granted && latest.policyVersion !== CONSENT_POLICY_VERSION;
  }

  /** Full history, newest first. Rendered by Settings (ATL-076). */
  async history(userId: string): Promise<ConsentRecord[]> {
    return this.consents.history(userId);
  }

  /** The newest decision per type, for surfaces that show current state. */
  async currentState(userId: string): Promise<Record<string, ConsentRecord>> {
    const rows = await this.consents.history(userId);
    const current: Record<string, ConsentRecord> = {};

    // History is newest-first, so the first occurrence of each type wins.
    for (const row of rows) {
      current[row.consentType] ??= row;
    }

    return current;
  }
}
