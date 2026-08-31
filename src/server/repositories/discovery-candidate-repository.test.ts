import { describe, expect, it, vi } from "vitest";
import {
  DiscoveryCandidateRepository,
  DiscoveryCandidateStoreError,
} from "./discovery-candidate-repository";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));

// ── Fake Supabase builder ─────────────────────────────────────────────────────

function fakeDb(error: object | null = null) {
  const upsertFn = vi.fn().mockResolvedValue({ error });
  return {
    from: vi.fn().mockReturnValue({ upsert: upsertFn }),
    _upsert: upsertFn,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DiscoveryCandidateRepository", () => {
  describe("insert", () => {
    it("upserts with status pending and ignoreDuplicates: true", async () => {
      const db = fakeDb();
      const repo = new DiscoveryCandidateRepository(db as never);
      await repo.insert("user-1", "evidence-1");
      expect(db._upsert).toHaveBeenCalledWith(
        { user_id: "user-1", evidence_id: "evidence-1", status: "pending" },
        { ignoreDuplicates: true },
      );
    });

    it("resolves without error on success", async () => {
      const db = fakeDb(null);
      const repo = new DiscoveryCandidateRepository(db as never);
      await expect(repo.insert("user-1", "evidence-1")).resolves.toBeUndefined();
    });

    it("throws DiscoveryCandidateStoreError on database error", async () => {
      const db = fakeDb({ message: "unique violation" });
      const repo = new DiscoveryCandidateRepository(db as never);
      await expect(repo.insert("user-1", "evidence-1")).rejects.toBeInstanceOf(
        DiscoveryCandidateStoreError,
      );
    });

    it("thrown error carries operation name", async () => {
      const db = fakeDb({ message: "db error" });
      const repo = new DiscoveryCandidateRepository(db as never);
      const err = await repo.insert("user-1", "evidence-1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiscoveryCandidateStoreError);
      if (err instanceof DiscoveryCandidateStoreError) {
        expect(err.operation).toBe("insert");
      }
    });
  });
});
