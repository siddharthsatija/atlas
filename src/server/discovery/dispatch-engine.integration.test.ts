import { describe, expect, it, vi } from "vitest";

/**
 * ATL-206 — dispatch engine integration tests.
 *
 * Tests the eight-check authorization sequence, concurrency behaviour, provider
 * outcomes, and audit emission without a real database. Each dependency is
 * replaced by an in-memory fake that mirrors the invariant the DB enforces.
 *
 * ## What "integration" means here
 *
 * All five dependency classes are replaced by fakes injected through the
 * constructor. No vi.mock is needed for the repository layer — the engine
 * accepts dependency injection, so each test configures its own fake state.
 *
 * The DB-facing half (RLS, constraints, index uniqueness) belongs to the
 * `tests/integration/` suite against a real database.
 *
 * ## Testing each check
 *
 * Each check has its own describe block with at minimum:
 *   - a passing case that advances past it
 *   - a blocking case that stops at it
 *   - an infrastructure-error case (for DB-touching checks, 5–8)
 *
 * The test order within each block mirrors the sequence in `dispatch`.
 */

// ── env / service-role stubs ─────────────────────────────────────────────────
// The dispatch engine pulls createServiceRoleClient in its `create()` factory.
// The tests use the DI constructor instead, so these stubs just prevent the
// module graph from crashing when `server-only` is evaluated.

vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 7).toString("base64") },
}));
vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));

// ── Deferred imports (after mocks are hoisted) ───────────────────────────────

import type { PersonalFieldKey } from "@/lib/personal-fields";
import { DiscoveryConsentService } from "@/server/discovery/discovery-consent-service";
import type {
  DiscoveryInvocationRepository,
  FieldMappingRow,
  InvocationRow,
  LiveFieldMetadata,
} from "@/server/repositories/discovery-invocation-repository";
import type { DisclosureAcknowledgmentRepository } from "@/server/repositories/disclosure-acknowledgment-repository";
import type { PersonalFieldService } from "@/server/personal-fields/personal-field-service";
import type { DiscoveryEligibleField } from "@/server/personal-fields/personal-field-service";
import type { AuditWriter } from "@/server/audit/audit-writer";
import { DispatchEngine } from "./dispatch-engine";
import type { DispatchResult } from "./dispatch-engine";
import type { DiscoveryProviderAdapter } from "./provider-adapter";

// ── Constants ─────────────────────────────────────────────────────────────────

const USER_ID = "user-00000000-0000-0000-0000-000000000001";
const RUN_ID = "00000000-0000-0000-0000-000000000002";
const INVOCATION_ID = "00000000-0000-0000-0000-000000000003";
const FIELD_ID_A = "00000000-0000-0000-0000-000000000004";
const FIELD_ID_B = "00000000-0000-0000-0000-000000000005";
const PROVIDER_CLASS = "hibp";
const CONSENT_TYPE = "discovery_hashed_query" as const;
const DISCLOSURE_CLASS = "hashed_query" as const;
const CONTRACT_VERSION = "v1";

const EMAIL: PersonalFieldKey = "email";
const USERNAME: PersonalFieldKey = "username";
const PHONE: PersonalFieldKey = "phone";

// ── Fake: DiscoveryConsentService ────────────────────────────────────────────

class FakeConsentService {
  private activeConsent = true;
  private throwOnCheck = false;

  setActive(v: boolean): void {
    this.activeConsent = v;
  }
  setThrow(v: boolean): void {
    this.throwOnCheck = v;
  }

  // Used only to produce ConsentProof objects for tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  private realSvc = DiscoveryConsentService.create(null as any);

  issueConsentProof(
    userId: string,
    consentType: typeof CONSENT_TYPE,
    providerClass: string,
    authorizedFieldIds: readonly string[],
    discoveryRunId: string,
    invocationId: string,
  ) {
    return this.realSvc.issueConsentProof(
      userId,
      consentType,
      providerClass,
      authorizedFieldIds,
      discoveryRunId,
      invocationId,
    );
  }

  hasActiveConsent(_userId: string, _consentType: string): Promise<boolean> {
    if (this.throwOnCheck) return Promise.reject(new Error("consent store unavailable"));
    return Promise.resolve(this.activeConsent);
  }
}

// ── Fake: DiscoveryInvocationRepository ─────────────────────────────────────

interface FakeInvocationState {
  invocationRow: InvocationRow;
  fieldMapping: FieldMappingRow[];
  fieldMetadata: Map<string, LiveFieldMetadata | null>;
  alreadyClaimed?: boolean;
  throwOnClaim?: boolean;
  throwOnLoadMapping?: boolean;
  throwOnLoadMetadata?: boolean;
  throwOnWriteTerminal?: boolean;
}

class FakeInvocationRepository {
  private state: FakeInvocationState;
  writtenTerminalStatus: string | undefined;
  writtenErrorCode: string | undefined;

  constructor(state: FakeInvocationState) {
    this.state = state;
  }

  claimForDispatch(_userId: string, _invocationId: string): Promise<InvocationRow | null> {
    if (this.state.throwOnClaim) return Promise.reject(new Error("DB error during claim"));
    if (this.state.alreadyClaimed) return Promise.resolve(null);
    return Promise.resolve(this.state.invocationRow);
  }

  loadFieldMapping(_userId: string, _invocationId: string): Promise<FieldMappingRow[]> {
    if (this.state.throwOnLoadMapping)
      return Promise.reject(new Error("DB error during load mapping"));
    return Promise.resolve(this.state.fieldMapping);
  }

  loadPersonalFieldMetadata(_userId: string, fieldId: string): Promise<LiveFieldMetadata | null> {
    if (this.state.throwOnLoadMetadata)
      return Promise.reject(new Error("DB error during load metadata"));
    return Promise.resolve(this.state.fieldMetadata.get(fieldId) ?? null);
  }

  writeTerminal(
    _userId: string,
    _invocationId: string,
    status: string,
    errorCode?: string,
  ): Promise<void> {
    if (this.state.throwOnWriteTerminal)
      return Promise.reject(new Error("DB error during terminal write"));
    this.writtenTerminalStatus = status;
    this.writtenErrorCode = errorCode;
    return Promise.resolve();
  }
}

// ── Fake: DisclosureAcknowledgmentRepository ─────────────────────────────────

class FakeAcknowledgmentRepository {
  private acknowledged: boolean;
  private shouldThrow: boolean;

  constructor(acknowledged = true, shouldThrow = false) {
    this.acknowledged = acknowledged;
    this.shouldThrow = shouldThrow;
  }

  hasAcknowledged(): Promise<boolean> {
    if (this.shouldThrow) return Promise.reject(new Error("ack store unavailable"));
    return Promise.resolve(this.acknowledged);
  }
}

// ── Fake: PersonalFieldService ───────────────────────────────────────────────

class FakePersonalFieldService {
  private fields: DiscoveryEligibleField[];
  private shouldFail: boolean;

  constructor(fields: DiscoveryEligibleField[], shouldFail = false) {
    this.fields = fields;
    this.shouldFail = shouldFail;
  }

  getDiscoveryEligibleFields(
    _userId: string,
  ): Promise<{ ok: true; data: DiscoveryEligibleField[] } | { ok: false; code: "UNAVAILABLE" }> {
    if (this.shouldFail)
      return Promise.resolve({ ok: false as const, code: "UNAVAILABLE" as const });
    return Promise.resolve({ ok: true as const, data: this.fields });
  }
}

// ── Fake: AuditWriter ────────────────────────────────────────────────────────

class FakeAuditWriter {
  emitted: Array<{ eventType: string; context: Record<string, unknown> }> = [];

  tryWrite(input: { eventType: string; context?: Record<string, unknown> }): Promise<null> {
    this.emitted.push({ eventType: input.eventType, context: input.context ?? {} });
    return Promise.resolve(null);
  }
}

// ── Fake: DiscoveryProviderAdapter ───────────────────────────────────────────

type QueryResult = Awaited<ReturnType<DiscoveryProviderAdapter["query"]>>;

class FakeAdapter implements DiscoveryProviderAdapter {
  readonly providerClass: string;
  readonly consentType: typeof CONSENT_TYPE;
  readonly disclosureClass: typeof DISCLOSURE_CLASS;
  readonly disclosureContractVersion: string;
  readonly eligibleFieldTypes: ReadonlySet<PersonalFieldKey>;
  private readonly result: QueryResult;

  constructor(
    opts: {
      providerClass?: string;
      consentType?: typeof CONSENT_TYPE;
      result?: QueryResult;
      eligibleFieldTypes?: ReadonlySet<PersonalFieldKey>;
    } = {},
  ) {
    this.providerClass = opts.providerClass ?? PROVIDER_CLASS;
    this.consentType = opts.consentType ?? CONSENT_TYPE;
    this.disclosureClass = DISCLOSURE_CLASS;
    this.disclosureContractVersion = CONTRACT_VERSION;
    this.eligibleFieldTypes = opts.eligibleFieldTypes ?? new Set<PersonalFieldKey>([EMAIL]);
    this.result = opts.result ?? { status: "success", data: { breached: false } };
  }

  query(): Promise<QueryResult> {
    return Promise.resolve(this.result);
  }
}

// ── Builder helpers ───────────────────────────────────────────────────────────

function makeInvocationRow(overrides: Partial<InvocationRow> = {}): InvocationRow {
  return {
    id: INVOCATION_ID,
    userId: USER_ID,
    runId: RUN_ID,
    providerClass: PROVIDER_CLASS,
    consentProofIssuedAt: new Date().toISOString(),
    invocationStatus: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makeFieldMapping(fieldIds = [FIELD_ID_A]): FieldMappingRow[] {
  return fieldIds.map((id) => ({ fieldId: id, fieldType: "email" }));
}

function makeFieldMetadata(overrides: Partial<LiveFieldMetadata> = {}): LiveFieldMetadata {
  return {
    includeInDiscovery: true,
    fieldKey: EMAIL,
    ...overrides,
  };
}

function makeEligibleField(fieldId = FIELD_ID_A): DiscoveryEligibleField {
  return {
    id: fieldId,
    userId: USER_ID,
    fieldKey: EMAIL,
    value: "alice@example.com",
  };
}

/**
 * Builds a fully-configured engine with sensible defaults that produce a
 * "success" path when left unchanged. Individual tests override as needed.
 */
function buildEngine(opts: {
  invocationState?: Partial<FakeInvocationState>;
  consentActive?: boolean;
  consentThrow?: boolean;
  acknowledged?: boolean;
  ackThrow?: boolean;
  eligibleFields?: DiscoveryEligibleField[];
  personalFieldsFail?: boolean;
  auditWriter?: FakeAuditWriter;
  consentSvc?: FakeConsentService;
  fakeInvocations?: FakeInvocationRepository;
}): {
  engine: DispatchEngine;
  fakeInvocations: FakeInvocationRepository;
  fakeAudit: FakeAuditWriter;
  fakeConsent: FakeConsentService;
} {
  const defaultState: FakeInvocationState = {
    invocationRow: makeInvocationRow(),
    fieldMapping: makeFieldMapping(),
    fieldMetadata: new Map([[FIELD_ID_A, makeFieldMetadata()]]),
    ...opts.invocationState,
  };

  const fakeInvocations = opts.fakeInvocations ?? new FakeInvocationRepository(defaultState);
  const fakeConsent = opts.consentSvc ?? new FakeConsentService();
  if (opts.consentActive !== undefined) fakeConsent.setActive(opts.consentActive);
  if (opts.consentThrow) fakeConsent.setThrow(true);

  const fakeAudit = opts.auditWriter ?? new FakeAuditWriter();

  const engine = new DispatchEngine({
    invocations: fakeInvocations as unknown as DiscoveryInvocationRepository,
    consentService: fakeConsent as unknown as DiscoveryConsentService,
    personalFields: new FakePersonalFieldService(
      opts.eligibleFields ?? [makeEligibleField()],
      opts.personalFieldsFail ?? false,
    ) as unknown as PersonalFieldService,
    acknowledgments: new FakeAcknowledgmentRepository(
      opts.acknowledged ?? true,
      opts.ackThrow ?? false,
    ) as unknown as DisclosureAcknowledgmentRepository,
    audit: fakeAudit as unknown as AuditWriter,
  });

  return { engine, fakeInvocations, fakeAudit, fakeConsent };
}

/** Creates a valid ConsentProof via the real issueConsentProof method. */
function makeProof(opts: {
  userId?: string;
  consentType?: typeof CONSENT_TYPE;
  providerClass?: string;
  authorizedFieldIds?: readonly string[];
  discoveryRunId?: string;
  invocationId?: string;
}) {
  const svc = new FakeConsentService();
  return svc.issueConsentProof(
    opts.userId ?? USER_ID,
    opts.consentType ?? CONSENT_TYPE,
    opts.providerClass ?? PROVIDER_CLASS,
    opts.authorizedFieldIds ?? [FIELD_ID_A],
    opts.discoveryRunId ?? RUN_ID,
    opts.invocationId ?? INVOCATION_ID,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DispatchEngine", () => {
  // ── already_dispatched ───────────────────────────────────────────────────

  describe("concurrent claim", () => {
    it("returns already_dispatched when invocation is already claimed", async () => {
      const { engine } = buildEngine({
        invocationState: { invocationRow: makeInvocationRow(), alreadyClaimed: true },
      });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());
      expect(result).toEqual({ outcome: "already_dispatched" });
    });

    it("throws when the claim itself fails (row not found / DB error)", async () => {
      const { engine } = buildEngine({
        invocationState: { invocationRow: makeInvocationRow(), throwOnClaim: true },
      });
      const proof = makeProof({});
      await expect(engine.dispatch(proof, INVOCATION_ID, new FakeAdapter())).rejects.toThrow(
        /failed to claim invocation/,
      );
    });
  });

  // ── Check 1: run binding ─────────────────────────────────────────────────

  describe("check 1 — run binding", () => {
    it("blocks with proof.run_id_mismatch when run IDs differ", async () => {
      const { engine, fakeInvocations } = buildEngine({});
      const proof = makeProof({ discoveryRunId: "00000000-0000-0000-0000-000000000099" });
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "proof.run_id_mismatch",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });
  });

  // ── Check 2: invocation binding ──────────────────────────────────────────

  describe("check 2 — invocation binding", () => {
    it("blocks with proof.invocation_id_mismatch when invocation IDs differ", async () => {
      const DIFFERENT_INVOCATION = "00000000-0000-0000-0000-000000000098";
      const { engine, fakeInvocations } = buildEngine({});
      // Proof is bound to DIFFERENT_INVOCATION but we dispatch with INVOCATION_ID.
      const proof = makeProof({ invocationId: DIFFERENT_INVOCATION });
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "proof.invocation_id_mismatch",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });
  });

  // ── Check 3: provider-class binding ─────────────────────────────────────

  describe("check 3 — provider-class binding", () => {
    it("blocks when proof.providerClass does not match the invocation row", async () => {
      const { engine, fakeInvocations } = buildEngine({
        invocationState: {
          invocationRow: makeInvocationRow({ providerClass: "acme" }),
          fieldMapping: makeFieldMapping(),
          fieldMetadata: new Map([[FIELD_ID_A, makeFieldMetadata()]]),
        },
      });
      // Proof has PROVIDER_CLASS = "hibp", row has "acme".
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "proof.provider_class_mismatch",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });

    it("blocks when proof.providerClass does not match adapter.providerClass", async () => {
      const { engine, fakeInvocations } = buildEngine({});
      const proof = makeProof({});
      const adapter = new FakeAdapter({ providerClass: "different_provider" });
      const result = await engine.dispatch(proof, INVOCATION_ID, adapter);

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "proof.provider_class_mismatch",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });
  });

  // ── Check 4: consent-type binding ───────────────────────────────────────

  describe("check 4 — consent-type binding", () => {
    it("blocks when proof.consentType does not match adapter.consentType", async () => {
      const { engine, fakeInvocations } = buildEngine({});
      const proof = makeProof({ consentType: "discovery_hashed_query" });
      // Adapter requires a different consent type.
      const adapter = new FakeAdapter({
        consentType: "discovery_identifying" as typeof CONSENT_TYPE,
      });
      const result = await engine.dispatch(proof, INVOCATION_ID, adapter);

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "proof.consent_type_mismatch",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });
  });

  // ── Check 5: live consent ────────────────────────────────────────────────

  describe("check 5 — live consent", () => {
    it("blocks with consent.inactive when consent has been revoked", async () => {
      const { engine, fakeInvocations } = buildEngine({ consentActive: false });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "consent.inactive",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });

    it("returns infrastructure error when consent DB call throws", async () => {
      const { engine, fakeInvocations } = buildEngine({ consentThrow: true });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "error",
        errorCode: "infrastructure_error",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("error");
      expect(fakeInvocations.writtenErrorCode).toBe("infrastructure_error");
    });

    it("infrastructure error re-throws if the terminal write also fails", async () => {
      const fakeInvocations = new FakeInvocationRepository({
        invocationRow: makeInvocationRow(),
        fieldMapping: makeFieldMapping(),
        fieldMetadata: new Map([[FIELD_ID_A, makeFieldMetadata()]]),
        throwOnWriteTerminal: true,
      });
      const { engine } = buildEngine({ fakeInvocations, consentThrow: true });
      const proof = makeProof({});

      await expect(engine.dispatch(proof, INVOCATION_ID, new FakeAdapter())).rejects.toThrow(
        /terminal write failed after infrastructure error/,
      );
    });
  });

  // ── Check 6: field mapping ───────────────────────────────────────────────

  describe("check 6 — field mapping", () => {
    it("blocks with mapping.empty when no fields are mapped", async () => {
      const { engine, fakeInvocations } = buildEngine({
        invocationState: {
          invocationRow: makeInvocationRow(),
          fieldMapping: [],
          fieldMetadata: new Map(),
        },
      });
      const proof = makeProof({ authorizedFieldIds: [] });
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "mapping.empty",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });

    it("blocks with mapping.unauthorized_field when a mapped field is not in the proof", async () => {
      const UNAUTHORIZED_ID = "00000000-0000-0000-0000-000000000099";
      const { engine, fakeInvocations } = buildEngine({
        invocationState: {
          invocationRow: makeInvocationRow(),
          fieldMapping: makeFieldMapping([UNAUTHORIZED_ID]),
          fieldMetadata: new Map([[UNAUTHORIZED_ID, makeFieldMetadata()]]),
        },
      });
      // Proof authorizes FIELD_ID_A only; mapping contains UNAUTHORIZED_ID.
      const proof = makeProof({ authorizedFieldIds: [FIELD_ID_A] });
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "mapping.unauthorized_field",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });

    it("returns infrastructure error when the mapping DB call throws", async () => {
      const { engine, fakeInvocations } = buildEngine({
        invocationState: {
          invocationRow: makeInvocationRow(),
          fieldMapping: makeFieldMapping(),
          fieldMetadata: new Map([[FIELD_ID_A, makeFieldMetadata()]]),
          throwOnLoadMapping: true,
        },
      });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "error",
        errorCode: "infrastructure_error",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("error");
    });
  });

  // ── Check 7: live field eligibility ─────────────────────────────────────

  describe("check 7 — live field eligibility", () => {
    it("blocks with field.not_found when the field row is absent", async () => {
      const { engine, fakeInvocations } = buildEngine({
        invocationState: {
          invocationRow: makeInvocationRow(),
          fieldMapping: makeFieldMapping(),
          fieldMetadata: new Map([[FIELD_ID_A, null]]),
        },
      });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "field.not_found",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });

    it("blocks with field.discovery_disabled when include_in_discovery is false", async () => {
      const { engine, fakeInvocations } = buildEngine({
        invocationState: {
          invocationRow: makeInvocationRow(),
          fieldMapping: makeFieldMapping(),
          fieldMetadata: new Map([[FIELD_ID_A, makeFieldMetadata({ includeInDiscovery: false })]]),
        },
      });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "field.discovery_disabled",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });

    it("blocks with field.type_ineligible when field_key is not in eligibleFieldTypes", async () => {
      const { engine, fakeInvocations } = buildEngine({
        invocationState: {
          invocationRow: makeInvocationRow(),
          fieldMapping: makeFieldMapping(),
          // field_key is "phone" but adapter only accepts "email"
          fieldMetadata: new Map([[FIELD_ID_A, makeFieldMetadata({ fieldKey: PHONE })]]),
        },
      });
      const proof = makeProof({});
      const adapter = new FakeAdapter({
        eligibleFieldTypes: new Set<PersonalFieldKey>([EMAIL]),
      });
      const result = await engine.dispatch(proof, INVOCATION_ID, adapter);

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "field.type_ineligible",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });

    it("returns infrastructure error when the metadata DB call throws", async () => {
      const { engine, fakeInvocations } = buildEngine({
        invocationState: {
          invocationRow: makeInvocationRow(),
          fieldMapping: makeFieldMapping(),
          fieldMetadata: new Map([[FIELD_ID_A, makeFieldMetadata()]]),
          throwOnLoadMetadata: true,
        },
      });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "error",
        errorCode: "infrastructure_error",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("error");
    });
  });

  // ── Check 8: first-disclosure acknowledgment ─────────────────────────────

  describe("check 8 — first-disclosure acknowledgment", () => {
    it("blocks with acknowledgment.missing when not yet acknowledged", async () => {
      const { engine, fakeInvocations } = buildEngine({ acknowledged: false });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "blocked",
        blockCode: "acknowledgment.missing",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("blocked");
    });

    it("returns infrastructure error when the acknowledgment DB call throws", async () => {
      const { engine, fakeInvocations } = buildEngine({ ackThrow: true });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "error",
        errorCode: "infrastructure_error",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("error");
    });
  });

  // ── Provider outcomes (all checks pass) ──────────────────────────────────

  describe("provider outcomes", () => {
    it("returns success with provider data and writes DB success", async () => {
      const { engine, fakeInvocations } = buildEngine({});
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "success",
        providerData: { breached: false },
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("success");
    });

    it("returns rate_limited and writes DB rate_limited", async () => {
      const { engine, fakeInvocations } = buildEngine({});
      const proof = makeProof({});
      const adapter = new FakeAdapter({ result: { status: "rate_limited" } });
      const result = await engine.dispatch(proof, INVOCATION_ID, adapter);

      expect(result).toEqual<DispatchResult>({ outcome: "rate_limited" });
      expect(fakeInvocations.writtenTerminalStatus).toBe("rate_limited");
    });

    it("returns error with provider errorCode and writes DB error", async () => {
      const { engine, fakeInvocations } = buildEngine({});
      const proof = makeProof({});
      const adapter = new FakeAdapter({
        result: { status: "error", errorCode: "provider_timeout" },
      });
      const result = await engine.dispatch(proof, INVOCATION_ID, adapter);

      expect(result).toEqual<DispatchResult>({
        outcome: "error",
        errorCode: "provider_timeout",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("error");
      expect(fakeInvocations.writtenErrorCode).toBe("provider_timeout");
    });
  });

  // ── Decryption failures ──────────────────────────────────────────────────

  describe("decryption boundary", () => {
    it("returns error when personalFieldService is unavailable", async () => {
      const { engine, fakeInvocations } = buildEngine({ personalFieldsFail: true });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "error",
        errorCode: "decryption_unavailable",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("error");
      expect(fakeInvocations.writtenErrorCode).toBe("decryption_unavailable");
    });

    it("returns error when a mapped field is missing from eligible fields after decryption (race)", async () => {
      // Eligible fields returns an empty list even though checks 1-8 all passed.
      const { engine, fakeInvocations } = buildEngine({ eligibleFields: [] });
      const proof = makeProof({});
      const result = await engine.dispatch(proof, INVOCATION_ID, new FakeAdapter());

      expect(result).toEqual<DispatchResult>({
        outcome: "error",
        errorCode: "field_decryption_race",
      });
      expect(fakeInvocations.writtenTerminalStatus).toBe("error");
      expect(fakeInvocations.writtenErrorCode).toBe("field_decryption_race");
    });
  });

  // ── Audit emission ───────────────────────────────────────────────────────

  describe("audit emission", () => {
    it("emits invocationStatus: dispatched on provider success", async () => {
      const { engine, fakeAudit } = buildEngine({});
      await engine.dispatch(makeProof({}), INVOCATION_ID, new FakeAdapter());

      expect(fakeAudit.emitted).toHaveLength(1);
      expect(fakeAudit.emitted[0]).toMatchObject({
        eventType: "discovery.provider.invoked",
        context: {
          discoveryRunId: RUN_ID,
          invocationId: INVOCATION_ID,
          disclosureClass: DISCLOSURE_CLASS,
          invocationStatus: "dispatched",
        },
      });
    });

    it("emits invocationStatus: blocked on authorization failure", async () => {
      const { engine, fakeAudit } = buildEngine({ consentActive: false });
      await engine.dispatch(makeProof({}), INVOCATION_ID, new FakeAdapter());

      expect(fakeAudit.emitted).toHaveLength(1);
      expect(fakeAudit.emitted[0]?.context?.invocationStatus).toBe("blocked");
    });

    it("emits invocationStatus: blocked on infrastructure error (no disclosure crossed boundary)", async () => {
      const { engine, fakeAudit } = buildEngine({ consentThrow: true });
      await engine.dispatch(makeProof({}), INVOCATION_ID, new FakeAdapter());

      expect(fakeAudit.emitted).toHaveLength(1);
      expect(fakeAudit.emitted[0]?.context?.invocationStatus).toBe("blocked");
    });

    it("emits invocationStatus: dispatched when provider returns error (disclosure DID cross boundary)", async () => {
      const { engine, fakeAudit } = buildEngine({});
      const adapter = new FakeAdapter({ result: { status: "error", errorCode: "timeout" } });
      await engine.dispatch(makeProof({}), INVOCATION_ID, adapter);

      expect(fakeAudit.emitted).toHaveLength(1);
      expect(fakeAudit.emitted[0]?.context?.invocationStatus).toBe("dispatched");
    });

    it("does NOT emit audit event on already_dispatched", async () => {
      const { engine, fakeAudit } = buildEngine({
        invocationState: { invocationRow: makeInvocationRow(), alreadyClaimed: true },
      });
      await engine.dispatch(makeProof({}), INVOCATION_ID, new FakeAdapter());
      expect(fakeAudit.emitted).toHaveLength(0);
    });
  });

  // ── Multi-field mapping ──────────────────────────────────────────────────

  describe("multi-field mapping", () => {
    it("passes all checks and calls provider with every authorized field", async () => {
      let receivedFields: readonly DiscoveryEligibleField[] | undefined;

      const captureAdapter: DiscoveryProviderAdapter = {
        providerClass: PROVIDER_CLASS,
        consentType: CONSENT_TYPE,
        disclosureClass: DISCLOSURE_CLASS,
        disclosureContractVersion: CONTRACT_VERSION,
        eligibleFieldTypes: new Set<PersonalFieldKey>([EMAIL, USERNAME]),
        query(fields): Promise<QueryResult> {
          receivedFields = fields;
          return Promise.resolve({ status: "success", data: {} });
        },
      };

      const { engine } = buildEngine({
        invocationState: {
          invocationRow: makeInvocationRow(),
          fieldMapping: makeFieldMapping([FIELD_ID_A, FIELD_ID_B]),
          fieldMetadata: new Map([
            [FIELD_ID_A, makeFieldMetadata({ fieldKey: EMAIL })],
            [FIELD_ID_B, makeFieldMetadata({ fieldKey: USERNAME })],
          ]),
        },
        eligibleFields: [
          makeEligibleField(FIELD_ID_A),
          { id: FIELD_ID_B, userId: USER_ID, fieldKey: USERNAME, value: "alice123" },
        ],
      });

      const proof = makeProof({ authorizedFieldIds: [FIELD_ID_A, FIELD_ID_B] });
      const result = await engine.dispatch(proof, INVOCATION_ID, captureAdapter);

      expect(result.outcome).toBe("success");
      expect(receivedFields).toHaveLength(2);
      expect(receivedFields?.map((f) => f.id).sort()).toEqual([FIELD_ID_A, FIELD_ID_B].sort());
    });
  });
});
