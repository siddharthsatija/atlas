import { describe, expect, it, vi } from "vitest";
import {
  DiscoveryRejectionRepository,
  DiscoveryRejectionStoreError,
} from "./discovery-rejection-repository";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));

// ── Fake Supabase builder ─────────────────────────────────────────────────────

function fakeDb(data: unknown[] | null, error: object | null = null) {
  const limitFn = vi.fn().mockResolvedValue({ data, error });
  const eqChain = { eq: vi.fn().mockReturnThis(), limit: limitFn };
  return {
    from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(eqChain) }),
    _limit: limitFn,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DiscoveryRejectionRepository", () => {
  describe("exists", () => {
    it("returns true when a matching rejection row is found", async () => {
      const db = fakeDb([{ id: "rejection-1" }]);
      const repo = new DiscoveryRejectionRepository(db as never);
      const result = await repo.exists("user-1", "discovery_hashed_query", "fp-abc");
      expect(result).toBe(true);
    });

    it("returns false when no matching rejection row is found", async () => {
      const db = fakeDb([]);
      const repo = new DiscoveryRejectionRepository(db as never);
      const result = await repo.exists("user-1", "discovery_hashed_query", "fp-abc");
      expect(result).toBe(false);
    });

    it("returns false when data is null", async () => {
      const db = fakeDb(null);
      const repo = new DiscoveryRejectionRepository(db as never);
      const result = await repo.exists("user-1", "discovery_hashed_query", "fp-abc");
      expect(result).toBe(false);
    });

    it("throws DiscoveryRejectionStoreError on database error (fail-closed)", async () => {
      const db = fakeDb(null, { message: "connection error" });
      const repo = new DiscoveryRejectionRepository(db as never);
      await expect(
        repo.exists("user-1", "discovery_hashed_query", "fp-abc"),
      ).rejects.toBeInstanceOf(DiscoveryRejectionStoreError);
    });

    it("thrown error carries operation name", async () => {
      const db = fakeDb(null, { message: "db error" });
      const repo = new DiscoveryRejectionRepository(db as never);
      const err = await repo
        .exists("user-1", "discovery_hashed_query", "fp-abc")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DiscoveryRejectionStoreError);
      if (err instanceof DiscoveryRejectionStoreError) {
        expect(err.operation).toBe("exists");
      }
    });
  });
});
