import { describe, it, expect, vi } from "vitest";

/**
 * DiscoveryCandidateRepository.countPending (ATL-212).
 *
 * Tested invariants:
 *   1. Returns 0 when count is null (no rows).
 *   2. Returns the exact count from the database.
 *   3. Filters by status="pending" only — dismissed/not_sure/confirmed/rejected excluded.
 *   4. Scopes the query to the given user_id.
 *   5. Throws DiscoveryCandidateStoreError on DB error.
 */

vi.mock("server-only", () => ({}));

import {
  DiscoveryCandidateRepository,
  DiscoveryCandidateStoreError,
} from "./discovery-candidate-repository";

// ── Mock builder ───────────────────────────────────────────────────────────────
//
// countPending uses:
//   .from("discovery_candidates")
//   .select("id", { count: "exact", head: true })
//   .eq("user_id", userId)
//   .eq("status", "pending")          ← awaited here (last in chain)
//
// We track eq calls for assertion and return the Promise on the second eq call.

function makeCountDb({ count = null as number | null, error = null as object | null } = {}) {
  const terminal = Promise.resolve({ count, data: null, error });
  const eqCalls: [string, unknown][] = [];
  let eqCallNumber = 0;

  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn((field: string, value: unknown) => {
      eqCalls.push([field, value]);
      eqCallNumber++;
      return eqCallNumber >= 2 ? terminal : builder;
    }),
  };

  return {
    from: vi.fn(() => builder),
    _eqCalls: eqCalls,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("DiscoveryCandidateRepository.countPending", () => {
  it("returns 0 when count is null (no rows)", async () => {
    const db = makeCountDb({ count: null });
    const repo = new DiscoveryCandidateRepository(db as never);
    expect(await repo.countPending("user-1")).toBe(0);
  });

  it("returns the exact count from the database", async () => {
    const db = makeCountDb({ count: 7 });
    const repo = new DiscoveryCandidateRepository(db as never);
    expect(await repo.countPending("user-1")).toBe(7);
  });

  it("filters by status='pending' — only pending candidates are counted", async () => {
    const db = makeCountDb({ count: 3 });
    const repo = new DiscoveryCandidateRepository(db as never);
    await repo.countPending("user-1");
    const statusCall = db._eqCalls.find(
      ([field, value]) => field === "status" && value === "pending",
    );
    expect(statusCall).toBeDefined();
  });

  it("does NOT filter for 'dismissed' status", async () => {
    const db = makeCountDb({ count: 0 });
    const repo = new DiscoveryCandidateRepository(db as never);
    await repo.countPending("user-1");
    expect(db._eqCalls.find(([, v]) => v === "dismissed")).toBeUndefined();
  });

  it("does NOT filter for 'not_sure' status", async () => {
    const db = makeCountDb({ count: 0 });
    const repo = new DiscoveryCandidateRepository(db as never);
    await repo.countPending("user-1");
    expect(db._eqCalls.find(([, v]) => v === "not_sure")).toBeUndefined();
  });

  it("does NOT filter for 'confirmed' status", async () => {
    const db = makeCountDb({ count: 0 });
    const repo = new DiscoveryCandidateRepository(db as never);
    await repo.countPending("user-1");
    expect(db._eqCalls.find(([, v]) => v === "confirmed")).toBeUndefined();
  });

  it("does NOT filter for 'rejected' status", async () => {
    const db = makeCountDb({ count: 0 });
    const repo = new DiscoveryCandidateRepository(db as never);
    await repo.countPending("user-1");
    expect(db._eqCalls.find(([, v]) => v === "rejected")).toBeUndefined();
  });

  it("scopes to the given user_id", async () => {
    const db = makeCountDb({ count: 2 });
    const repo = new DiscoveryCandidateRepository(db as never);
    await repo.countPending("specific-user");
    const userIdCall = db._eqCalls.find(
      ([field, value]) => field === "user_id" && value === "specific-user",
    );
    expect(userIdCall).toBeDefined();
  });

  it("throws DiscoveryCandidateStoreError on DB error", async () => {
    const db = makeCountDb({ error: { message: "db down" } });
    const repo = new DiscoveryCandidateRepository(db as never);
    await expect(repo.countPending("user-1")).rejects.toBeInstanceOf(DiscoveryCandidateStoreError);
  });
});
