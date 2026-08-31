import { describe, expect, it, vi } from "vitest";
import {
  DiscoveryEvidenceRepository,
  DiscoveryEvidenceStoreError,
  generateEvidenceId,
  type EvidenceInsertRow,
} from "./discovery-evidence-repository";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));

// ── Fake Supabase builder ─────────────────────────────────────────────────────

function fakeDb(overrides: { error?: object | null } = {}) {
  const upsertFn = vi.fn().mockResolvedValue({ error: overrides.error ?? null });
  return {
    from: vi.fn().mockReturnValue({ upsert: upsertFn }),
    _upsert: upsertFn,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ROW: EvidenceInsertRow = {
  userId: "user-1",
  invocationId: "inv-1",
  providerClass: "discovery_hashed_query",
  fieldId: "field-1",
  sourceIdentifier: "adobe",
  isAggregatorAttributed: false,
  evidenceType: "hibp_breach",
  evidenceSummary: "Adobe",
  providerEvidenceJson: "encrypted-json",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DiscoveryEvidenceRepository", () => {
  describe("insert", () => {
    it("calls upsert with ignoreDuplicates: true", async () => {
      const db = fakeDb();
      const repo = new DiscoveryEvidenceRepository(db as never);
      await repo.insert("evidence-uuid", ROW);
      expect(db._upsert).toHaveBeenCalledWith(
        expect.objectContaining({ id: "evidence-uuid", user_id: "user-1" }),
        { ignoreDuplicates: true },
      );
    });

    it("includes all required columns in the payload", async () => {
      const db = fakeDb();
      const repo = new DiscoveryEvidenceRepository(db as never);
      await repo.insert("evidence-uuid", ROW);
      const payload = db._upsert.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(payload.field_id).toBe("field-1");
      expect(payload.source_identifier).toBe("adobe");
      expect(payload.evidence_type).toBe("hibp_breach");
      expect(payload.provider_evidence_json).toBe("encrypted-json");
    });

    it("does not throw when upsert returns no error (idempotent success)", async () => {
      const db = fakeDb({ error: null });
      const repo = new DiscoveryEvidenceRepository(db as never);
      await expect(repo.insert("evidence-uuid", ROW)).resolves.toBeUndefined();
    });

    it("throws DiscoveryEvidenceStoreError on database error", async () => {
      const db = fakeDb({ error: { message: "constraint violation" } });
      const repo = new DiscoveryEvidenceRepository(db as never);
      await expect(repo.insert("evidence-uuid", ROW)).rejects.toBeInstanceOf(
        DiscoveryEvidenceStoreError,
      );
    });

    it("thrown error carries operation name", async () => {
      const db = fakeDb({ error: { message: "db error" } });
      const repo = new DiscoveryEvidenceRepository(db as never);
      const err = await repo.insert("evidence-uuid", ROW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiscoveryEvidenceStoreError);
      if (err instanceof DiscoveryEvidenceStoreError) {
        expect(err.operation).toBe("insert");
      }
    });
  });
});

describe("generateEvidenceId", () => {
  it("returns a string in UUID format", () => {
    const id = generateEvidenceId();
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returns a unique id on each call", () => {
    expect(generateEvidenceId()).not.toBe(generateEvidenceId());
  });
});
