import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsentProof } from "./discovery-consent-service";

/**
 * ATL-205 — discovery consent lifecycle and proof issuance.
 *
 * Runs against fake stores that mirror the append-only semantics of the
 * underlying `consents` table and the idempotent acknowledgment table.
 *
 * The RLS half — own-row SELECT, service-role-only INSERT — lives in the
 * database integration suite, not here.
 */

const CURRENT_POLICY = "2026-08-01";

vi.mock("@/config/app", () => ({ CONSENT_POLICY_VERSION: CURRENT_POLICY }));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

/**
 * `audit-writer.ts` → `audit-event.ts` references `env.AUDIT_HMAC_KEY` inside
 * `subjectRefFor`. Even though the fake writer never calls it, the module graph
 * causes `env` to be loaded. Stubbed so this suite exercises consent logic
 * rather than environment configuration.
 */
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 9).toString("base64") },
}));

// ---------------------------------------------------------------------------
// Fake consent store — append-only, matching the migration semantics
// ---------------------------------------------------------------------------

interface FakeConsentRow {
  id: string;
  user_id: string;
  consent_type: string;
  policy_version: string;
  granted: boolean;
  recorded_at: string;
}

class FakeConsentStore {
  rows: FakeConsentRow[] = [];
  private nextId = 1;
  private clock = Date.parse("2026-08-04T10:00:00.000Z");

  insert(row: Omit<FakeConsentRow, "id" | "recorded_at">): FakeConsentRow {
    this.clock += 1000;
    const stored: FakeConsentRow = {
      ...row,
      id: `consent-${this.nextId++}`,
      recorded_at: new Date(this.clock).toISOString(),
    };
    this.rows.push(stored);
    return stored;
  }

  /** Newest first for one user, matching `ConsentRepository.latestFor` ordering. */
  latestForUser(userId: string, consentType: string): FakeConsentRow | undefined {
    return [...this.rows]
      .filter((r) => r.user_id === userId && r.consent_type === consentType)
      .sort((a, b) =>
        a.recorded_at === b.recorded_at
          ? a.id < b.id
            ? 1
            : -1
          : a.recorded_at < b.recorded_at
            ? 1
            : -1,
      )[0];
  }
}

function toConsentRecord(row: FakeConsentRow) {
  return {
    id: row.id,
    userId: row.user_id,
    consentType: row.consent_type,
    policyVersion: row.policy_version,
    granted: row.granted,
    recordedAt: row.recorded_at,
  };
}

/** Minimal fake that satisfies the ConsentRepository interface the service uses. */
class FakeConsentRepository {
  constructor(private readonly store: FakeConsentStore) {}

  append(userId: string, consentType: string, policyVersion: string, granted: boolean) {
    return Promise.resolve(
      toConsentRecord(
        this.store.insert({
          user_id: userId,
          consent_type: consentType,
          policy_version: policyVersion,
          granted,
        }),
      ),
    );
  }

  latestFor(userId: string, consentType: string) {
    const row = this.store.latestForUser(userId, consentType);
    return Promise.resolve(row ? toConsentRecord(row) : null);
  }
}

// ---------------------------------------------------------------------------
// Fake acknowledgment store
// ---------------------------------------------------------------------------

interface AckKey {
  userId: string;
  fieldId: string;
  providerClass: string;
  contractVersion: string;
}

class FakeAcknowledgmentRepository {
  recorded: AckKey[] = [];
  latestForCalls = 0;

  record(userId: string, fieldId: string, providerClass: string, contractVersion: string) {
    this.recorded.push({ userId, fieldId, providerClass, contractVersion });
    return Promise.resolve();
  }

  hasAcknowledged(userId: string, fieldId: string, providerClass: string, contractVersion: string) {
    return Promise.resolve(
      this.recorded.some(
        (r) =>
          r.userId === userId &&
          r.fieldId === fieldId &&
          r.providerClass === providerClass &&
          r.contractVersion === contractVersion,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Fake audit writer
// ---------------------------------------------------------------------------

interface CapturedAuditEvent {
  eventType: string;
  entityType?: string;
  entityId?: string;
  context?: Record<string, unknown>;
}

let auditEvents: CapturedAuditEvent[];

const fakeAudit = {
  write: (input: CapturedAuditEvent) => {
    auditEvents.push(input);
    return Promise.resolve({ event: { id: "evt" }, droppedKeys: [], redactedKeys: [] });
  },
};

// ---------------------------------------------------------------------------
// Service factory helpers
// ---------------------------------------------------------------------------

const { DiscoveryConsentService } = await import("./discovery-consent-service");

let consentStore: FakeConsentStore;
let ackRepo: FakeAcknowledgmentRepository;

const service = () =>
  new DiscoveryConsentService({
    consents: new FakeConsentRepository(consentStore) as never,
    acknowledgments: ackRepo as never,
    audit: fakeAudit as never,
  });

const ALICE = "aaaaaaaa-0000-4000-8000-00000000000a";
const FIELD_ID = "f1000000-0000-4000-8000-000000000001";
const RUN_ID = "run-0001";
const INVOC_ID = "invoc-0001";

beforeEach(() => {
  consentStore = new FakeConsentStore();
  ackRepo = new FakeAcknowledgmentRepository();
  auditEvents = [];
});

// ---------------------------------------------------------------------------
// grantConsent
// ---------------------------------------------------------------------------

describe("grantConsent", () => {
  it("records a grant against the current policy version", async () => {
    const result = await service().grantConsent(ALICE, "discovery_hashed_query");

    expect(result.consentId).toBeDefined();
    expect(consentStore.rows).toHaveLength(1);
    expect(consentStore.rows[0]).toMatchObject({
      user_id: ALICE,
      consent_type: "discovery_hashed_query",
      policy_version: CURRENT_POLICY,
      granted: true,
    });
  });

  it("uses the identity mapping: provider class equals the consent type string", async () => {
    /**
     * ADR-007 §5: for all three discovery consent types the provider-class
     * string and the consent-type string are identical. The service must not
     * introduce a lookup table or a separate parameter — it computes
     * providerClass as `consentType` cast to string.
     */
    await service().grantConsent(ALICE, "discovery_identifying");

    const ctx = auditEvents[0]?.context ?? {};
    expect(ctx["consentType"]).toBe("discovery_identifying");
    expect(ctx["providerClass"]).toBe("discovery_identifying");
  });

  it("emits discovery.consent.granted with correct context", async () => {
    await service().grantConsent(ALICE, "discovery_hashed_query");

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      eventType: "discovery.consent.granted",
      context: {
        consentType: "discovery_hashed_query",
        providerClass: "discovery_hashed_query",
        policyVersion: CURRENT_POLICY,
      },
    });
  });

  it("links the audit event to the consent row", async () => {
    const result = await service().grantConsent(ALICE, "discovery_hashed_query");
    expect(auditEvents[0]?.entityId).toBe(result.consentId);
  });

  it("does not emit an audit event if the store write fails", async () => {
    const broken = {
      append: () => Promise.reject(new Error("store down")),
      latestFor: () => Promise.resolve(null),
    };
    const svc = new DiscoveryConsentService({
      consents: broken as never,
      acknowledgments: ackRepo as never,
      audit: fakeAudit as never,
    });

    await expect(svc.grantConsent(ALICE, "discovery_hashed_query")).rejects.toThrow("store down");
    expect(auditEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// revokeConsent
// ---------------------------------------------------------------------------

describe("revokeConsent", () => {
  it("records a revocation as a new row rather than editing the grant", async () => {
    const svc = service();
    const { consentId: grantId } = await svc.grantConsent(ALICE, "discovery_hashed_query");
    const { consentId: revokeId } = await svc.revokeConsent(ALICE, "discovery_hashed_query");

    expect(consentStore.rows).toHaveLength(2);
    expect(revokeId).not.toBe(grantId);
    // The original grant row is untouched — it is evidence of what was agreed.
    expect(consentStore.rows[0]).toMatchObject({ granted: true });
    expect(consentStore.rows[1]).toMatchObject({ granted: false });
  });

  it("emits discovery.consent.revoked", async () => {
    const svc = service();
    await svc.grantConsent(ALICE, "discovery_hashed_query");
    await svc.revokeConsent(ALICE, "discovery_hashed_query");

    expect(auditEvents.map((e) => e.eventType)).toEqual([
      "discovery.consent.granted",
      "discovery.consent.revoked",
    ]);
  });
});

// ---------------------------------------------------------------------------
// hasActiveConsent
// ---------------------------------------------------------------------------

describe("hasActiveConsent", () => {
  it("returns false when no decision was ever recorded", async () => {
    expect(await service().hasActiveConsent(ALICE, "discovery_hashed_query")).toBe(false);
  });

  it("returns false after revocation", async () => {
    const svc = service();
    await svc.grantConsent(ALICE, "discovery_hashed_query");
    await svc.revokeConsent(ALICE, "discovery_hashed_query");

    expect(await svc.hasActiveConsent(ALICE, "discovery_hashed_query")).toBe(false);
  });

  it("returns false for a grant recorded against a superseded policy version", async () => {
    /**
     * Same fail-closed rule as `ConsentService.hasConsent`: a grant against
     * old terms does not cover new terms.
     */
    consentStore.insert({
      user_id: ALICE,
      consent_type: "discovery_hashed_query",
      policy_version: "2025-01-01",
      granted: true,
    });

    expect(await service().hasActiveConsent(ALICE, "discovery_hashed_query")).toBe(false);
  });

  it("returns true when the most recent decision is a grant at current policy", async () => {
    await service().grantConsent(ALICE, "discovery_hashed_query");
    expect(await service().hasActiveConsent(ALICE, "discovery_hashed_query")).toBe(true);
  });

  it("gates each discovery type independently", async () => {
    const svc = service();
    await svc.grantConsent(ALICE, "discovery_hashed_query");

    expect(await svc.hasActiveConsent(ALICE, "discovery_hashed_query")).toBe(true);
    expect(await svc.hasActiveConsent(ALICE, "discovery_identifying")).toBe(false);
    expect(await svc.hasActiveConsent(ALICE, "discovery_connected_sources")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordFirstDisclosureAcknowledgment
// ---------------------------------------------------------------------------

describe("recordFirstDisclosureAcknowledgment", () => {
  it("records the acknowledgment and emits discovery.disclosure.acknowledged", async () => {
    await service().recordFirstDisclosureAcknowledgment(
      ALICE,
      FIELD_ID,
      "discovery_hashed_query",
      "v1.0",
    );

    expect(ackRepo.recorded).toHaveLength(1);
    expect(ackRepo.recorded[0]).toMatchObject({
      userId: ALICE,
      fieldId: FIELD_ID,
      providerClass: "discovery_hashed_query",
      contractVersion: "v1.0",
    });

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      eventType: "discovery.disclosure.acknowledged",
      entityType: "personal_field",
      entityId: FIELD_ID,
      context: {
        providerClass: "discovery_hashed_query",
        fieldId: FIELD_ID,
        disclosureContractVersion: "v1.0",
      },
    });
  });

  it("completes without error on a duplicate tuple (idempotent)", async () => {
    const svc = service();
    await svc.recordFirstDisclosureAcknowledgment(
      ALICE,
      FIELD_ID,
      "discovery_hashed_query",
      "v1.0",
    );
    // Second call must not throw; the repository uses ON CONFLICT DO NOTHING.
    await expect(
      svc.recordFirstDisclosureAcknowledgment(ALICE, FIELD_ID, "discovery_hashed_query", "v1.0"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// issueConsentProof
// ---------------------------------------------------------------------------

describe("issueConsentProof", () => {
  it("packages all seven proof fields without querying the consent store", () => {
    const svc = service();
    const proof = svc.issueConsentProof(
      ALICE,
      "discovery_hashed_query",
      "discovery_hashed_query",
      [FIELD_ID],
      RUN_ID,
      INVOC_ID,
    );

    expect(proof.userId).toBe(ALICE);
    expect(proof.consentType).toBe("discovery_hashed_query");
    expect(proof.providerClass).toBe("discovery_hashed_query");
    expect(proof.authorizedFieldIds).toEqual([FIELD_ID]);
    expect(proof.discoveryRunId).toBe(RUN_ID);
    expect(proof.invocationId).toBe(INVOC_ID);
    // issuedAt is a current ISO timestamp — verify shape only.
    expect(proof.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("does not query the consent store (no TOCTOU check)", () => {
    /**
     * The dispatch layer already checked consent before calling this method
     * (ATL-206, dispatch check 5). Re-checking here would open a TOCTOU gap
     * without any protection gain. Verified by spying on the actual repository
     * instance the service holds.
     */
    const consents = new FakeConsentRepository(consentStore);
    const latestForSpy = vi.spyOn(consents, "latestFor");

    const svc = new DiscoveryConsentService({
      consents: consents as never,
      acknowledgments: ackRepo as never,
      audit: fakeAudit as never,
    });

    svc.issueConsentProof(
      ALICE,
      "discovery_hashed_query",
      "discovery_hashed_query",
      [],
      RUN_ID,
      INVOC_ID,
    );

    expect(latestForSpy).not.toHaveBeenCalled();
    // No rows written either — proof issuance is a pure packaging step.
    expect(consentStore.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Compile-time structural forgery guard
// ---------------------------------------------------------------------------

describe("ConsentProof nominal brand", () => {
  /**
   * Proves that a plain seven-field object literal cannot be assigned to
   * `ConsentProof` because the type carries an unexported unique-symbol brand.
   *
   * This is a compile-time test. If the brand is removed or exported, TypeScript
   * would accept the assignment and `@ts-expect-error` would become an unused
   * directive — an error — causing the typecheck step to fail even if all
   * runtime tests pass.
   */
  it("type: plain object literal cannot be assigned to ConsentProof (brand enforced)", () => {
    const literal = {
      userId: "u",
      consentType: "discovery_hashed_query" as const,
      providerClass: "p",
      authorizedFieldIds: [] as readonly string[],
      issuedAt: "2026-01-01T00:00:00.000Z",
      discoveryRunId: "r",
      invocationId: "i",
    };

    // @ts-expect-error — structural literal cannot satisfy branded ConsentProof;
    // an "unused directive" error here means the brand was removed
    const _: ConsentProof = literal;
    void _;
  });
});
