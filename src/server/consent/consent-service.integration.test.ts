import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Type-only, so it is erased before `vi.mock` hoisting runs and cannot pull the
 * real repository into the module graph ahead of its mock.
 */
import type * as ConsentRepositoryModule from "@/server/repositories/consent-repository";

/**
 * ATL-078 — consent recording, history integrity, and the consent gate.
 *
 * Runs against a fake store that mirrors the migration's append-only semantics:
 * inserts only, no update path. Mirroring that matters because the whole design
 * rests on it — a fake that allowed edits would let a gate bug pass here and
 * fail against a database that refuses the update.
 *
 * The RLS half — own-row SELECT, no client INSERT, immutability — needs a real
 * database and lives in `tests/integration/consents-rls.test.ts`.
 */

const CURRENT_POLICY = "2026-08-01";

vi.mock("@/config/app", () => ({ CONSENT_POLICY_VERSION: CURRENT_POLICY }));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

/**
 * The consent service imports the ATL-103 audit writer, which reaches
 * `AUDIT_HMAC_KEY` through the validated env module. Stubbed so this suite
 * exercises consent logic rather than environment configuration.
 */
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 9).toString("base64") },
}));

interface FakeRow {
  id: string;
  user_id: string;
  consent_type: string;
  policy_version: string;
  granted: boolean;
  recorded_at: string;
}

class FakeStore {
  rows: FakeRow[] = [];
  private nextId = 1;
  /** Advances so ordering is deterministic without real waiting. */
  private clock = Date.parse("2026-08-04T10:00:00.000Z");

  insert(row: Omit<FakeRow, "id" | "recorded_at">): FakeRow {
    this.clock += 1000;
    const stored: FakeRow = {
      ...row,
      id: `consent-${this.nextId++}`,
      recorded_at: new Date(this.clock).toISOString(),
    };
    this.rows.push(stored);
    return stored;
  }

  /** Newest first, matching the repository's ordering. */
  forUser(userId: string): FakeRow[] {
    return [...this.rows]
      .filter((r) => r.user_id === userId)
      .sort((a, b) =>
        a.recorded_at === b.recorded_at
          ? a.id < b.id
            ? 1
            : -1
          : a.recorded_at < b.recorded_at
            ? 1
            : -1,
      );
  }
}

let store: FakeStore;

vi.mock("@/server/repositories/consent-repository", async () => {
  const actual = await vi.importActual<typeof ConsentRepositoryModule>(
    "@/server/repositories/consent-repository",
  );

  const toRecord = (row: FakeRow) => ({
    id: row.id,
    userId: row.user_id,
    consentType: row.consent_type,
    policyVersion: row.policy_version,
    granted: row.granted,
    recordedAt: row.recorded_at,
  });

  return {
    ...actual,
    ConsentRepository: class {
      append(userId: string, consentType: string, policyVersion: string, granted: boolean) {
        return Promise.resolve(
          toRecord(
            store.insert({
              user_id: userId,
              consent_type: consentType,
              policy_version: policyVersion,
              granted,
            }),
          ),
        );
      }
      latestFor(userId: string, consentType: string) {
        const row = store.forUser(userId).find((r) => r.consent_type === consentType);
        return Promise.resolve(row ? toRecord(row) : null);
      }
      history(userId: string) {
        return Promise.resolve(store.forUser(userId).map(toRecord));
      }
    },
  };
});

/** Captures audit events without a database. */
const auditEvents: { eventType: string; entityId?: string; context?: Record<string, unknown> }[] =
  [];

const fakeAudit = {
  write: (input: { eventType: string; entityId?: string; context?: Record<string, unknown> }) => {
    auditEvents.push(input);
    return Promise.resolve({ event: { id: "evt" }, droppedKeys: [], redactedKeys: [] });
  },
};

const { ConsentService } = await import("./consent-service");

const ALICE = "aaaaaaaa-0000-4000-8000-00000000000a";
const BOB = "bbbbbbbb-0000-4000-8000-00000000000b";

const service = () => new ConsentService({} as never, fakeAudit as never);

beforeEach(() => {
  store = new FakeStore();
  auditEvents.length = 0;
});

describe("recording decisions", () => {
  it("records a grant against the current policy version", async () => {
    const { record } = await service().grant(ALICE, "ai_processing");

    expect(record).toMatchObject({
      consentType: "ai_processing",
      granted: true,
      policyVersion: CURRENT_POLICY,
    });
  });

  it("records a revocation as a new row rather than an edit", async () => {
    const svc = service();
    const granted = await svc.grant(ALICE, "ai_processing");
    const revoked = await svc.revoke(ALICE, "ai_processing");

    expect(store.rows).toHaveLength(2);
    expect(revoked.record.id).not.toBe(granted.record.id);
    // The original grant is untouched — it is evidence of what was agreed.
    expect(store.rows[0]).toMatchObject({ granted: true });
  });

  it("stamps the policy version server-side, not from the caller", async () => {
    // A client-supplied version would let consent be recorded against terms the
    // user never saw. There is deliberately no parameter for it.
    const { record } = await service().grant(ALICE, "product_updates");
    expect(record.policyVersion).toBe(CURRENT_POLICY);
  });
});

describe("history integrity", () => {
  it("reconstructs grant -> revoke -> re-grant in order", async () => {
    const svc = service();
    await svc.grant(ALICE, "ai_conversation_history");
    await svc.revoke(ALICE, "ai_conversation_history");
    await svc.grant(ALICE, "ai_conversation_history");

    const history = await svc.history(ALICE);

    expect(history).toHaveLength(3);
    // Newest first.
    expect(history.map((h) => h.granted)).toEqual([true, false, true]);
    expect(await svc.hasConsent(ALICE, "ai_conversation_history")).toBe(true);
  });

  it("keeps every superseded decision", async () => {
    // A view that collapsed to current state would answer a different question
    // than the one Settings asks.
    const svc = service();
    await svc.grant(ALICE, "ai_processing");
    await svc.revoke(ALICE, "ai_processing");

    expect(await svc.history(ALICE)).toHaveLength(2);
  });

  it("separates history by user", async () => {
    const svc = service();
    await svc.grant(ALICE, "ai_processing");
    await svc.grant(BOB, "ai_processing");

    expect(await svc.history(ALICE)).toHaveLength(1);
    expect((await svc.history(ALICE))[0]?.userId).toBe(ALICE);
  });

  it("separates decisions by consent type", async () => {
    const svc = service();
    await svc.grant(ALICE, "ai_processing");
    await svc.revoke(ALICE, "product_updates");

    expect(await svc.hasConsent(ALICE, "ai_processing")).toBe(true);
    expect(await svc.hasConsent(ALICE, "product_updates")).toBe(false);
  });

  it("reports the newest decision per type as current state", async () => {
    const svc = service();
    await svc.grant(ALICE, "ai_processing");
    await svc.revoke(ALICE, "ai_processing");
    await svc.grant(ALICE, "personal_fields_storage");

    const current = await svc.currentState(ALICE);

    expect(current.ai_processing?.granted).toBe(false);
    expect(current.personal_fields_storage?.granted).toBe(true);
  });
});

describe("the consent gate", () => {
  it("denies when no decision was ever recorded", async () => {
    // Silence is not consent.
    expect(await service().hasConsent(ALICE, "ai_processing")).toBe(false);
  });

  it("denies after revocation", async () => {
    const svc = service();
    await svc.grant(ALICE, "ai_processing");
    await svc.revoke(ALICE, "ai_processing");

    expect(await svc.hasConsent(ALICE, "ai_processing")).toBe(false);
  });

  it("denies a grant recorded against a superseded policy version", async () => {
    /**
     * The failure mode with legal consequences.
     *
     * The user agreed to terms that have since changed, so the agreement no
     * longer covers what would happen now. Treating the old grant as current
     * would be silently proceeding on permission that was never given for these
     * terms, so the gate denies and the surface re-asks.
     */
    store.insert({
      user_id: ALICE,
      consent_type: "ai_processing",
      policy_version: "2025-01-01",
      granted: true,
    });

    expect(await service().hasConsent(ALICE, "ai_processing")).toBe(false);
  });

  it("distinguishes stale consent from no consent", async () => {
    const svc = service();
    store.insert({
      user_id: ALICE,
      consent_type: "ai_processing",
      policy_version: "2025-01-01",
      granted: true,
    });

    // Different surfaces: one re-asks, the other explains what changed.
    expect(await svc.needsReconsent(ALICE, "ai_processing")).toBe(true);
    expect(await svc.needsReconsent(BOB, "ai_processing")).toBe(false);
  });

  it("does not treat a stale revocation as needing re-consent", async () => {
    store.insert({
      user_id: ALICE,
      consent_type: "ai_processing",
      policy_version: "2025-01-01",
      granted: false,
    });

    expect(await service().needsReconsent(ALICE, "ai_processing")).toBe(false);
  });

  it("gates each documented surface independently", async () => {
    // ATL-078: the gate covers AI, personal fields, and conversation history.
    const svc = service();
    await svc.grant(ALICE, "ai_processing");

    expect(await svc.hasConsent(ALICE, "ai_processing")).toBe(true);
    expect(await svc.hasConsent(ALICE, "personal_fields_storage")).toBe(false);
    expect(await svc.hasConsent(ALICE, "ai_conversation_history")).toBe(false);
  });
});

describe("audit emission", () => {
  it("emits consent.granted", async () => {
    await service().grant(ALICE, "ai_processing");

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      eventType: "consent.granted",
      context: { consentType: "ai_processing", policyVersion: CURRENT_POLICY },
    });
  });

  it("emits consent.revoked", async () => {
    const svc = service();
    await svc.grant(ALICE, "ai_processing");
    await svc.revoke(ALICE, "ai_processing");

    expect(auditEvents.map((e) => e.eventType)).toEqual(["consent.granted", "consent.revoked"]);
  });

  it("links the audit event to the consent row", async () => {
    const { record } = await service().grant(ALICE, "personal_fields_storage");
    expect(auditEvents[0]?.entityId).toBe(record.id);
  });

  it("carries no personal data in the audit context", async () => {
    // ADR-006 allowlist: consent type and policy version only.
    await service().grant(ALICE, "ai_processing");

    const context = auditEvents[0]?.context ?? {};
    expect(Object.keys(context).sort()).toEqual(["consentType", "policyVersion"]);
    expect(JSON.stringify(context)).not.toContain(ALICE);
  });

  it("does not audit a write that failed to persist", async () => {
    /**
     * Ordering matters in one direction more than the other. An unaudited write
     * is a gap; an audit entry for a write that never happened is a false
     * record, so the row is written first.
     */
    const svc = new ConsentService({} as never, fakeAudit as never);
    const broken = { append: () => Promise.reject(new Error("store down")) };
    Object.assign(svc, { consents: broken });

    await expect(svc.grant(ALICE, "ai_processing")).rejects.toThrow("store down");
    expect(auditEvents).toHaveLength(0);
  });
});
