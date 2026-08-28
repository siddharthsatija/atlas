import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import { CONSENT_POLICY_VERSION } from "@/config/app";
import type { DiscoveryConsentType } from "@/lib/consent";
import { AuditWriter, emitEvent } from "@/server/audit/audit-writer";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { ConsentRepository } from "@/server/repositories/consent-repository";
import { DisclosureAcknowledgmentRepository } from "@/server/repositories/disclosure-acknowledgment-repository";

// ---------------------------------------------------------------------------
// ConsentProof — nominal value object (ATL-205, ADR-007 §6)
// ---------------------------------------------------------------------------

/**
 * Nominal brand token. Declared but never exported.
 *
 * Because `CONSENT_PROOF_BRAND` is a `unique symbol` and is not exported from
 * this module, no code outside this file can reference it as a property key.
 * This has two consequences:
 *
 *   1. **Structural forgery is impossible.** An object literal cannot satisfy
 *      `ConsentProof` unless the compiler can prove it carries
 *      `[CONSENT_PROOF_BRAND]: true`. It cannot, because the property key is
 *      not nameable outside this file.
 *
 *   2. **Factory calls from other files are blocked.** `buildConsentProof` is
 *      not exported; `ConsentProofImpl` is not exported. No external code can
 *      reach a constructor capable of setting the branded field.
 *
 * The net effect is that `DiscoveryConsentService.issueConsentProof` is the
 * sole proof-issuance boundary in the codebase.
 */
const CONSENT_PROOF_BRAND: unique symbol = Symbol("ConsentProof.brand");

/**
 * An unforgeable proof that discovery consent was active at issue time.
 *
 * Exported so ATL-206+ can type-check parameters. The brand field makes the
 * type nominal: only code in this module can produce a conforming value.
 */
export interface ConsentProof {
  readonly [CONSENT_PROOF_BRAND]: true;
  readonly userId: string;
  readonly consentType: DiscoveryConsentType;
  readonly providerClass: string;
  readonly authorizedFieldIds: readonly string[];
  readonly issuedAt: string;
  readonly discoveryRunId: string;
  readonly invocationId: string;
}

/** Unexported. The only code that can set the branded property. */
class ConsentProofImpl implements ConsentProof {
  readonly [CONSENT_PROOF_BRAND] = true as const;
  readonly userId: string;
  readonly consentType: DiscoveryConsentType;
  readonly providerClass: string;
  readonly authorizedFieldIds: readonly string[];
  readonly issuedAt: string;
  readonly discoveryRunId: string;
  readonly invocationId: string;

  constructor(
    userId: string,
    consentType: DiscoveryConsentType,
    providerClass: string,
    authorizedFieldIds: readonly string[],
    issuedAt: string,
    discoveryRunId: string,
    invocationId: string,
  ) {
    this.userId = userId;
    this.consentType = consentType;
    this.providerClass = providerClass;
    this.authorizedFieldIds = authorizedFieldIds;
    this.issuedAt = issuedAt;
    this.discoveryRunId = discoveryRunId;
    this.invocationId = invocationId;
  }
}

/** Unexported. Called only by `DiscoveryConsentService.issueConsentProof`. */
function buildConsentProof(
  userId: string,
  consentType: DiscoveryConsentType,
  providerClass: string,
  authorizedFieldIds: readonly string[],
  discoveryRunId: string,
  invocationId: string,
): ConsentProof {
  return new ConsentProofImpl(
    userId,
    consentType,
    providerClass,
    authorizedFieldIds,
    new Date().toISOString(),
    discoveryRunId,
    invocationId,
  );
}

// ---------------------------------------------------------------------------
// DiscoveryConsentService
// ---------------------------------------------------------------------------

/**
 * Discovery consent lifecycle and proof issuance (ATL-205, ADR-007 §5,
 * ADR-008 §3, §12).
 *
 * ## Why this is not ConsentService
 *
 * `ConsentService` emits `consent.granted` / `consent.revoked`. Discovery
 * consent belongs in the audit trail as `discovery.consent.granted` /
 * `discovery.consent.revoked` — the event type tells an incident responder
 * immediately which subsystem the decision applied to. The different event
 * types also carry different context (`providerClass`), which `ConsentService`
 * does not know. Delegating to `ConsentService` would either suppress that
 * context or require polluting its interface with discovery-specific concepts.
 *
 * This service injects `ConsentRepository` directly, bypassing
 * `ConsentService`. It writes to the same `consents` table, which is the sole
 * durable source of truth for discovery consent (architecture ruling I-1).
 *
 * ## Fail-closed on consent checks
 *
 * `hasActiveConsent` throws on any query error. It never returns `true` when
 * it could not read the table. A call that can't determine consent must not
 * proceed as if consent were granted.
 *
 * ## Proof issuance does not re-check consent
 *
 * `issueConsentProof` is called by the dispatch layer after it has already
 * checked consent (ATL-206, dispatch check 5). The proof packages that
 * decision; it does not repeat the check. Repeating it would create a TOCTOU
 * gap without any real protection gain — if consent is revoked between check
 * and dispatch, the proof reflects the check's verdict, and the audit trail
 * records all subsequent events against the issued proof, making any
 * discrepancy visible.
 *
 * ## Construction boundary
 *
 * `ConsentProof`, `ConsentProofImpl`, and `buildConsentProof` all live in this
 * module. The brand symbol is declared here and never exported. No code outside
 * this file can construct a valid `ConsentProof` — not by calling a factory
 * (none is exported), not by satisfying the interface structurally (the brand
 * property key is inaccessible externally).
 */

export interface GrantConsentResult {
  consentId: string;
  recordedAt: string;
}

export interface RevokeConsentResult {
  consentId: string;
  recordedAt: string;
}

interface DiscoveryConsentDependencies {
  consents: ConsentRepository;
  acknowledgments: DisclosureAcknowledgmentRepository;
  audit: AuditWriter;
}

export class DiscoveryConsentService {
  private readonly consents: ConsentRepository;
  private readonly acknowledgments: DisclosureAcknowledgmentRepository;
  private readonly audit: AuditWriter;

  constructor(dependencies: DiscoveryConsentDependencies) {
    this.consents = dependencies.consents;
    this.acknowledgments = dependencies.acknowledgments;
    this.audit = dependencies.audit;
  }

  static create(db: SupabaseClient<Database> = createServiceRoleClient()): DiscoveryConsentService {
    return new DiscoveryConsentService({
      consents: new ConsentRepository(db),
      acknowledgments: new DisclosureAcknowledgmentRepository(db),
      audit: new AuditWriter(db),
    });
  }

  /**
   * Records a discovery consent grant and emits `discovery.consent.granted`.
   *
   * Per ADR-007 §5, the provider-class string and the consent-type string are
   * identical for all three discovery consent types. No lookup table is needed;
   * `providerClass` is `consentType` cast to string.
   */
  async grantConsent(
    userId: string,
    consentType: DiscoveryConsentType,
  ): Promise<GrantConsentResult> {
    const record = await this.consents.append(userId, consentType, CONSENT_POLICY_VERSION, true);

    await emitEvent(
      {
        audit: {
          userId,
          eventType: "discovery.consent.granted",
          actorType: "user",
          entityType: "consent",
          entityId: record.id,
          context: {
            consentType,
            providerClass: consentType,
            policyVersion: CONSENT_POLICY_VERSION,
          },
        },
      },
      this.audit,
    );

    return { consentId: record.id, recordedAt: record.recordedAt };
  }

  /**
   * Records a discovery consent revocation and emits
   * `discovery.consent.revoked`.
   */
  async revokeConsent(
    userId: string,
    consentType: DiscoveryConsentType,
  ): Promise<RevokeConsentResult> {
    const record = await this.consents.append(userId, consentType, CONSENT_POLICY_VERSION, false);

    await emitEvent(
      {
        audit: {
          userId,
          eventType: "discovery.consent.revoked",
          actorType: "user",
          entityType: "consent",
          entityId: record.id,
          context: {
            consentType,
            providerClass: consentType,
            policyVersion: CONSENT_POLICY_VERSION,
          },
        },
      },
      this.audit,
    );

    return { consentId: record.id, recordedAt: record.recordedAt };
  }

  /**
   * Records first-disclosure acknowledgment for one field / provider /
   * contract-version tuple and emits `discovery.disclosure.acknowledged`.
   *
   * Idempotent: a second call for the same tuple completes without error. The
   * audit event IS still emitted on repeat calls — the user acknowledged again,
   * which is itself a fact worth recording. (The repository uses ON CONFLICT DO
   * NOTHING; the audit writer does not deduplicate.)
   */
  async recordFirstDisclosureAcknowledgment(
    userId: string,
    fieldId: string,
    providerClass: string,
    contractVersion: string,
  ): Promise<void> {
    await this.acknowledgments.record(userId, fieldId, providerClass, contractVersion);

    await emitEvent(
      {
        audit: {
          userId,
          eventType: "discovery.disclosure.acknowledged",
          actorType: "user",
          entityType: "personal_field",
          entityId: fieldId,
          context: {
            providerClass,
            fieldId,
            disclosureContractVersion: contractVersion,
          },
        },
      },
      this.audit,
    );
  }

  /**
   * Returns true if the user's most recent decision for this consent type is
   * a grant recorded against a non-superseded policy version.
   *
   * Fail-closed: throws on any query error. Never returns true when the result
   * is uncertain.
   *
   * Policy-version gating matches `ConsentService.hasConsent`: a grant against
   * an older version is treated as not-consented, forcing re-consent when the
   * policy changes.
   */
  async hasActiveConsent(userId: string, consentType: DiscoveryConsentType): Promise<boolean> {
    const latest = await this.consents.latestFor(userId, consentType);
    if (!latest) return false;
    if (!latest.granted) return false;
    if (latest.policyVersion !== CONSENT_POLICY_VERSION) return false;
    return true;
  }

  /**
   * Packages an already-verified consent decision as an unforgeable proof.
   *
   * The caller (ATL-206 dispatch) has already performed the consent check
   * (dispatch check 5). This method does NOT re-check; it only builds the
   * value object. See the class-level doc for why.
   *
   * This is the only exported API capable of producing a `ConsentProof`.
   * `buildConsentProof` is not exported; `ConsentProofImpl` is not exported;
   * the brand symbol is not exported. External code cannot forge or construct
   * a proof without going through this method.
   */
  issueConsentProof(
    userId: string,
    consentType: DiscoveryConsentType,
    providerClass: string,
    authorizedFieldIds: readonly string[],
    discoveryRunId: string,
    invocationId: string,
  ): ConsentProof {
    return buildConsentProof(
      userId,
      consentType,
      providerClass,
      authorizedFieldIds,
      discoveryRunId,
      invocationId,
    );
  }
}
