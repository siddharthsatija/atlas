import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.generated";
import type { ConsentProof } from "@/server/discovery/discovery-consent-service";
import { DiscoveryConsentService } from "@/server/discovery/discovery-consent-service";
import { createServiceRoleClient } from "@/server/db/service-role-client";
import { AuditWriter } from "@/server/audit/audit-writer";
import { DisclosureAcknowledgmentRepository } from "@/server/repositories/disclosure-acknowledgment-repository";
import { PersonalFieldService } from "@/server/personal-fields/personal-field-service";
import { DiscoveryInvocationRepository } from "@/server/repositories/discovery-invocation-repository";
import type { DiscoveryProviderAdapter } from "./provider-adapter";

/**
 * Block codes for all authorization failures (ATL-206, ADR-008 §4).
 *
 * A closed union rather than free strings: the test suite can exhaustively
 * match every code, and a new failure mode cannot be silently swallowed
 * by a caller that matches on the string value.
 *
 * Codes are prefixed by the check that produces them:
 *   `proof.*`        — checks 1–4: binding checks (stateless)
 *   `consent.*`      — check 5:    live consent
 *   `mapping.*`      — check 6:    field mapping validation
 *   `field.*`        — check 7:    live field eligibility
 *   `acknowledgment.*` — check 8:  first-disclosure acknowledgment
 */
export type BlockCode =
  // Check 1 – run binding: ConsentProof.discoveryRunId must match invocation row's run_id
  | "proof.run_id_mismatch"
  // Check 2 – invocation binding: ConsentProof.invocationId must equal the dispatched id
  | "proof.invocation_id_mismatch"
  // Check 3 – provider-class binding: proof, row, and adapter must all agree
  | "proof.provider_class_mismatch"
  // Check 4 – consent-type binding: proof.consentType must match adapter.consentType
  | "proof.consent_type_mismatch"
  // Check 5 – live consent: the user's consent record must be currently active
  | "consent.inactive"
  // Check 6 – field mapping: non-empty, every field must be in the proof's authorized set
  | "mapping.empty"
  | "mapping.unauthorized_field"
  // Check 7 – live field eligibility: field must exist, have discovery enabled, have eligible type
  | "field.not_found"
  | "field.discovery_disabled"
  | "field.type_ineligible"
  // Check 8 – first-disclosure acknowledgment: user must have acknowledged for this field/provider/version
  | "acknowledgment.missing";

/**
 * The outcome of one `dispatch` call.
 *
 * `already_dispatched` means the invocation was claimed by a concurrent caller
 * before this one could stamp `started_at`. It is not an error and requires no
 * further action — no terminal state was written and no audit event was emitted.
 *
 * All other outcomes correspond to a written terminal DB state and an emitted
 * `discovery.provider.invoked` audit event.
 */
export type DispatchResult =
  | { outcome: "blocked"; blockCode: BlockCode }
  | { outcome: "success"; providerData: unknown }
  | { outcome: "rate_limited" }
  | { outcome: "error"; errorCode: string }
  | { outcome: "already_dispatched" };

export interface DispatchEngineDependencies {
  invocations: DiscoveryInvocationRepository;
  consentService: DiscoveryConsentService;
  personalFields: PersonalFieldService;
  acknowledgments: DisclosureAcknowledgmentRepository;
  audit: AuditWriter;
}

/**
 * The discovery dispatch engine (ATL-206, ADR-008).
 *
 * The single choke point between Atlas and every discovery provider. No code
 * path reaches a provider without passing through `dispatch` and satisfying all
 * eight authorization checks in the documented sequence.
 *
 * ## Eight-check sequence (ADR-008 §4)
 *
 * 1. Run binding        — `ConsentProof.discoveryRunId === invocation.run_id`
 * 2. Invocation binding — `ConsentProof.invocationId === invocationId`
 * 3. Provider-class     — proof, row, and adapter all agree on `providerClass`
 * 4. Consent-type       — `proof.consentType === adapter.consentType`
 * 5. Live consent       — `DiscoveryConsentService.hasActiveConsent`
 * 6. Field mapping      — non-empty; every field in the proof's authorized set
 * 7. Live eligibility   — `include_in_discovery = true` and type in `adapter.eligibleFieldTypes`
 * 8. Acknowledgment     — `DisclosureAcknowledgmentRepository.hasAcknowledged` per field
 *
 * Decryption (`PersonalFieldService.getDiscoveryEligibleFields`) happens only
 * after all eight checks pass. Plaintext never enters the DB, audit context,
 * or logs at any point.
 *
 * ## Failure semantics
 *
 *   Authorization failure → DB `blocked`,      audit `invocationStatus: "blocked"`
 *   Infrastructure error  → DB `error`,         audit `invocationStatus: "blocked"`
 *   Provider called       → DB success/error/rate_limited, audit `invocationStatus: "dispatched"`
 *
 * Infrastructure errors before any provider call produce DB `error` but audit
 * `blocked`: the audit vocabulary describes whether disclosure crossed the
 * outbound boundary, not the outcome of the call.
 *
 * ## Concurrency
 *
 * The claim is an atomic conditional UPDATE (`WHERE started_at IS NULL`). Only
 * one concurrent caller wins; the rest receive `already_dispatched` without
 * writing any state. The terminal write is guarded on `completed_at IS NULL`
 * for idempotency.
 *
 * ## Store-first, audit-second
 *
 * The terminal DB state is committed before the audit event is emitted,
 * consistent with the ATL-205 pattern (`DiscoveryConsentService`). An audit
 * failure after a committed terminal state is logged but does not undo the
 * state; `tryWrite` is used for audit so the caller never sees an audit error.
 */
export class DispatchEngine {
  private readonly invocations: DiscoveryInvocationRepository;
  private readonly consentService: DiscoveryConsentService;
  private readonly personalFields: PersonalFieldService;
  private readonly acknowledgments: DisclosureAcknowledgmentRepository;
  private readonly audit: AuditWriter;

  constructor(deps: DispatchEngineDependencies) {
    this.invocations = deps.invocations;
    this.consentService = deps.consentService;
    this.personalFields = deps.personalFields;
    this.acknowledgments = deps.acknowledgments;
    this.audit = deps.audit;
  }

  /** Uses the service-role client — the only role that can reach these tables. */
  static create(db: SupabaseClient<Database> = createServiceRoleClient()): DispatchEngine {
    return new DispatchEngine({
      invocations: new DiscoveryInvocationRepository(db),
      consentService: DiscoveryConsentService.create(db),
      personalFields: PersonalFieldService.create(db),
      acknowledgments: new DisclosureAcknowledgmentRepository(db),
      audit: new AuditWriter(db),
    });
  }

  /**
   * Runs the eight-check authorization sequence and, on success, calls the
   * provider adapter.
   *
   * @param consentProof - A proof issued by `DiscoveryConsentService.issueConsentProof`.
   *   The nominal brand guarantees the caller went through the consent service;
   *   this engine cannot be bypassed by constructing a plain object.
   * @param invocationId - The `discovery_provider_invocations.id` to dispatch.
   * @param providerAdapter - The adapter for the provider class bound to this
   *   invocation.
   *
   * @returns A `DispatchResult` describing the outcome. Throws only when the
   *   invocation row cannot be found (invalid ID) or when a terminal write fails
   *   after an infrastructure error (the invocation state cannot be committed).
   *   All other outcomes — authorization failures, provider errors, concurrency
   *   races — are returned rather than thrown.
   */
  async dispatch(
    consentProof: ConsentProof,
    invocationId: string,
    providerAdapter: DiscoveryProviderAdapter,
  ): Promise<DispatchResult> {
    const { userId } = consentProof;

    // ── Atomic claim ─────────────────────────────────────────────────────────
    // Stamps `started_at` WHERE started_at IS NULL. The winner gets the row;
    // concurrent callers get null. If the row does not exist, claimForDispatch
    // throws — propagated as a hard failure since there is no row to write
    // terminal state to.
    let invocationRow;
    try {
      invocationRow = await this.invocations.claimForDispatch(userId, invocationId);
    } catch (err) {
      throw new Error(
        `dispatch: failed to claim invocation ${invocationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (invocationRow === null) {
      // Another caller claimed this invocation first. No terminal write, no audit.
      return { outcome: "already_dispatched" };
    }

    const runId = invocationRow.runId;

    // ── Checks 1–4: ConsentProof binding (stateless) ──────────────────────────
    // These checks verify that the proof, the invocation row, and the adapter
    // describe the same dispatching context. No additional DB reads are needed.

    // Check 1 — run binding
    if (consentProof.discoveryRunId !== runId) {
      return this.block(userId, invocationId, runId, providerAdapter, "proof.run_id_mismatch");
    }

    // Check 2 — invocation binding
    if (consentProof.invocationId !== invocationId) {
      return this.block(
        userId,
        invocationId,
        runId,
        providerAdapter,
        "proof.invocation_id_mismatch",
      );
    }

    // Check 3 — provider-class binding (proof ↔ row AND proof ↔ adapter)
    if (
      consentProof.providerClass !== invocationRow.providerClass ||
      consentProof.providerClass !== providerAdapter.providerClass
    ) {
      return this.block(
        userId,
        invocationId,
        runId,
        providerAdapter,
        "proof.provider_class_mismatch",
      );
    }

    // Check 4 — consent-type binding (proof ↔ adapter)
    if (consentProof.consentType !== providerAdapter.consentType) {
      return this.block(
        userId,
        invocationId,
        runId,
        providerAdapter,
        "proof.consent_type_mismatch",
      );
    }

    // ── Check 5: live consent ─────────────────────────────────────────────────
    // The proof was valid at issuance time; consent may have been revoked since.
    // `hasActiveConsent` is fail-closed: throws on DB error.
    try {
      const hasConsent = await this.consentService.hasActiveConsent(
        userId,
        consentProof.consentType,
      );
      if (!hasConsent) {
        return this.block(userId, invocationId, runId, providerAdapter, "consent.inactive");
      }
    } catch {
      return this.infrastructureError(userId, invocationId, runId, providerAdapter);
    }

    // ── Check 6: field mapping ────────────────────────────────────────────────
    // Loads the snapshot field set from run creation. Empty → block. Any field
    // not in the proof's authorized set → block (the proof is the authoritative
    // list of what the consent service approved).
    let fieldMapping;
    try {
      fieldMapping = await this.invocations.loadFieldMapping(userId, invocationId);
    } catch {
      return this.infrastructureError(userId, invocationId, runId, providerAdapter);
    }

    if (fieldMapping.length === 0) {
      return this.block(userId, invocationId, runId, providerAdapter, "mapping.empty");
    }

    const authorizedIds = new Set(consentProof.authorizedFieldIds);
    for (const row of fieldMapping) {
      if (!authorizedIds.has(row.fieldId)) {
        return this.block(
          userId,
          invocationId,
          runId,
          providerAdapter,
          "mapping.unauthorized_field",
        );
      }
    }

    // ── Check 7: live field eligibility ──────────────────────────────────────
    // Live read for each mapped field. The snapshot `fieldType` in the mapping
    // row is NOT used here — only the live `include_in_discovery` and `field_key`
    // from `user_personal_fields` are authoritative.
    for (const row of fieldMapping) {
      let meta;
      try {
        meta = await this.invocations.loadPersonalFieldMetadata(userId, row.fieldId);
      } catch {
        return this.infrastructureError(userId, invocationId, runId, providerAdapter);
      }

      // 7a — field must exist (and belong to this user)
      if (meta === null) {
        return this.block(userId, invocationId, runId, providerAdapter, "field.not_found");
      }

      // 7b — discovery must be enabled for this field
      if (!meta.includeInDiscovery) {
        return this.block(userId, invocationId, runId, providerAdapter, "field.discovery_disabled");
      }

      // 7c — field type must be in the adapter's eligible set (declarative check)
      if (!providerAdapter.eligibleFieldTypes.has(meta.fieldKey)) {
        return this.block(userId, invocationId, runId, providerAdapter, "field.type_ineligible");
      }
    }

    // ── Check 8: first-disclosure acknowledgment ──────────────────────────────
    // The user must have acknowledged the disclosure terms for each field /
    // provider / contract-version tuple. ADR-008 §3 is authoritative over the
    // ticket description, which omits `disclosureContractVersion` from this check.
    for (const row of fieldMapping) {
      let acknowledged;
      try {
        acknowledged = await this.acknowledgments.hasAcknowledged(
          userId,
          row.fieldId,
          providerAdapter.providerClass,
          providerAdapter.disclosureContractVersion,
        );
      } catch {
        return this.infrastructureError(userId, invocationId, runId, providerAdapter);
      }

      if (!acknowledged) {
        return this.block(userId, invocationId, runId, providerAdapter, "acknowledgment.missing");
      }
    }

    // ── All checks passed — decrypt ───────────────────────────────────────────
    // The single approved decryption path is PersonalFieldService.getDiscoveryEligibleFields.
    // Plaintext must never reach logs, audit context, DB rows, or the ConsentProof.
    const eligibleResult = await this.personalFields.getDiscoveryEligibleFields(userId);
    if (!eligibleResult.ok) {
      // Decryption infrastructure failure — treat as infrastructure error.
      // No disclosure attempted; DB: error, audit: blocked.
      try {
        await this.invocations.writeTerminal(
          userId,
          invocationId,
          "error",
          "decryption_unavailable",
        );
      } catch (writeErr) {
        throw new Error(
          `dispatch: terminal write failed after decryption failure for invocation ${invocationId}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        );
      }
      await this.emitAuditEvent(userId, invocationId, runId, providerAdapter, "blocked");
      return { outcome: "error", errorCode: "decryption_unavailable" };
    }

    const mappedFieldIds = new Set(fieldMapping.map((r) => r.fieldId));
    const authorizedFields = eligibleResult.data.filter((f) => mappedFieldIds.has(f.id));

    if (authorizedFields.length !== fieldMapping.length) {
      // One or more mapped fields disappeared between check 7 and decryption —
      // a narrow race window (removeField blocks while invocation_status IS NULL,
      // which was set at claim time, but the window is not zero). No disclosure
      // was attempted; DB: error, audit: blocked.
      try {
        await this.invocations.writeTerminal(
          userId,
          invocationId,
          "error",
          "field_decryption_race",
        );
      } catch (writeErr) {
        throw new Error(
          `dispatch: terminal write failed after decryption race for invocation ${invocationId}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        );
      }
      await this.emitAuditEvent(userId, invocationId, runId, providerAdapter, "blocked");
      return { outcome: "error", errorCode: "field_decryption_race" };
    }

    // ── Provider call ─────────────────────────────────────────────────────────
    // Disclosure crosses the outbound boundary here. The adapter must not throw.
    const queryResult = await providerAdapter.query(authorizedFields);

    // Store-first, audit-second.
    switch (queryResult.status) {
      case "success": {
        await this.invocations.writeTerminal(userId, invocationId, "success");
        await this.emitAuditEvent(userId, invocationId, runId, providerAdapter, "dispatched");
        return { outcome: "success", providerData: queryResult.data };
      }

      case "rate_limited": {
        await this.invocations.writeTerminal(userId, invocationId, "rate_limited");
        await this.emitAuditEvent(userId, invocationId, runId, providerAdapter, "dispatched");
        return { outcome: "rate_limited" };
      }

      case "error": {
        await this.invocations.writeTerminal(userId, invocationId, "error", queryResult.errorCode);
        // Disclosure DID cross the boundary (the provider was called) — audit: dispatched.
        await this.emitAuditEvent(userId, invocationId, runId, providerAdapter, "dispatched");
        return { outcome: "error", errorCode: queryResult.errorCode };
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Authorization failure path.
   *
   * Writes DB `blocked` then emits `invocationStatus: "blocked"` (no disclosure
   * crossed the boundary). Returns the blocked result.
   */
  private async block(
    userId: string,
    invocationId: string,
    runId: string,
    adapter: DiscoveryProviderAdapter,
    blockCode: BlockCode,
  ): Promise<DispatchResult> {
    await this.invocations.writeTerminal(userId, invocationId, "blocked");
    await this.emitAuditEvent(userId, invocationId, runId, adapter, "blocked");
    return { outcome: "blocked", blockCode };
  }

  /**
   * Infrastructure error path (DB threw during an authorization check).
   *
   * No disclosure was attempted, so `invocationStatus` is `"blocked"`. DB
   * status is `"error"` to distinguish from a legitimate `"blocked"` verdict.
   *
   * If the terminal write itself fails after the infrastructure error, this
   * method re-throws — the invocation state cannot be committed, and the caller
   * must see a hard failure rather than a misleading result.
   */
  private async infrastructureError(
    userId: string,
    invocationId: string,
    runId: string,
    adapter: DiscoveryProviderAdapter,
  ): Promise<DispatchResult> {
    try {
      await this.invocations.writeTerminal(userId, invocationId, "error", "infrastructure_error");
    } catch (writeErr) {
      throw new Error(
        `dispatch: terminal write failed after infrastructure error for invocation ${invocationId}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      );
    }
    await this.emitAuditEvent(userId, invocationId, runId, adapter, "blocked");
    return { outcome: "error", errorCode: "infrastructure_error" };
  }

  /**
   * Emits `discovery.provider.invoked` as best-effort (`tryWrite`).
   *
   * An audit failure after a committed terminal state is observed (the logger
   * inside `tryWrite` records it) but does not undo the terminal state. The
   * caller never sees an audit exception from this method.
   *
   * `invocationStatus` is the two-value audit vocabulary (`dispatched` /
   * `blocked`), NOT the DB column vocabulary.
   */
  private async emitAuditEvent(
    userId: string,
    invocationId: string,
    runId: string,
    adapter: DiscoveryProviderAdapter,
    invocationStatus: "dispatched" | "blocked",
  ): Promise<void> {
    await this.audit.tryWrite({
      userId,
      eventType: "discovery.provider.invoked",
      actorType: "system",
      entityType: "discovery_invocation",
      entityId: invocationId,
      context: {
        discoveryRunId: runId,
        invocationId,
        disclosureClass: adapter.disclosureClass,
        invocationStatus,
      },
    });
  }
}
