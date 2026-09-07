import { describe, it, expect, vi } from "vitest";

/**
 * DiscoveryRunsRepository (ATL-212).
 *
 * Tests use a mock Supabase client — no real database needed.
 * Tested invariants:
 *   1. Returns null when no run exists for the user.
 *   2. DB "pending" maps to UI "running".
 *   3. DB "running" maps to UI "running".
 *   4. DB "partial" / "blocked" / "failed" pass through unchanged.
 *   5. DB "completed" + candidates → "completed_candidates".
 *   6. DB "completed" + no candidates → "completed_zero".
 *   7. DB "completed" + no invocations → "completed_zero" (short-circuit hop 1).
 *   8. DB "completed" + invocations but no evidence → "completed_zero" (short-circuit hop 2).
 *   9. DB error on invocations hop → DiscoveryRunsStoreError (not silent zero).
 *  10. DB error on evidence hop → DiscoveryRunsStoreError.
 *  11. DB error on candidates hop → DiscoveryRunsStoreError.
 *  12. Candidate derivation query is scoped by run_id and user_id.
 *  13. Unknown run_status values are normalised to "failed".
 *  14. Result does not include user_id (display-safe only).
 *  15. Query is scoped by user_id (not cross-user).
 *  16. Throws DiscoveryRunsStoreError on main query DB error.
 *  17. DiscoveryRunsStoreError does not expose DB error detail.
 */

vi.mock("server-only", () => ({}));

import { DiscoveryRunsRepository, DiscoveryRunsStoreError } from "./discovery-runs-repository";

// ── Mock builder ──────────────────────────────────────────────────────────────

type RunRow = {
  id: string;
  run_status: string;
  created_at: string;
};

/**
 * Returns a Supabase query-builder mock that is both chainable (`.select().eq()…`)
 * and directly awaitable (`await builder` resolves with `result`).
 *
 * The `then` shim makes bare-await work for list/count queries that don't call
 * `.maybeSingle()`.
 */
function makeChainBuilder<T>(result: T) {
  const p = Promise.resolve(result);
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(() => p),
    // Makes `await builder` resolve with `result` without `.maybeSingle()`.
    then: p.then.bind(p),
  };
}

function makeDb({
  row = null as RunRow | null,
  error = null as object | null,
  invocations = [] as { id: string }[],
  invocationError = null as object | null,
  evidences = [] as { id: string }[],
  evidenceError = null as object | null,
  candidateCount = 0,
  candidateError = null as object | null,
} = {}) {
  const runsBuilder = makeChainBuilder({ data: row, error });
  const invocationsBuilder = makeChainBuilder({
    data: invocations,
    error: invocationError,
  });
  const evidenceBuilder = makeChainBuilder({
    data: evidences,
    error: evidenceError,
  });
  const candidatesBuilder = makeChainBuilder({
    count: candidateCount,
    error: candidateError,
  });

  return {
    from: vi.fn((table: string) => {
      if (table === "discovery_runs") return runsBuilder;
      if (table === "discovery_provider_invocations") return invocationsBuilder;
      if (table === "discovery_evidence") return evidenceBuilder;
      if (table === "discovery_candidates") return candidatesBuilder;
      throw new Error(`Unexpected table in mock: ${table}`);
    }),
    // Expose mocks for scope-assertion tests.
    _eq: runsBuilder.eq,
    _invEq: invocationsBuilder.eq,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(run_status: string, id = "run-id"): RunRow {
  return { id, run_status, created_at: "2026-01-15T10:00:00Z" };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("DiscoveryRunsRepository.getLatestRunForUser", () => {
  // ── Null / missing run ─────────────────────────────────────────────────────

  it("returns null when no run exists", async () => {
    const db = makeDb({ row: null });
    const repo = new DiscoveryRunsRepository(db as never);
    expect(await repo.getLatestRunForUser("user-1")).toBeNull();
  });

  // ── DB "pending" / "running" → UI "running" ───────────────────────────────

  it("maps DB 'pending' to UI 'running'", async () => {
    const db = makeDb({ row: makeRow("pending") });
    const repo = new DiscoveryRunsRepository(db as never);
    const result = await repo.getLatestRunForUser("user-1");
    expect(result!.status).toBe("running");
  });

  it("maps DB 'running' to UI 'running'", async () => {
    const db = makeDb({ row: makeRow("running") });
    const repo = new DiscoveryRunsRepository(db as never);
    const result = await repo.getLatestRunForUser("user-1");
    expect(result!.status).toBe("running");
  });

  // ── Pass-through statuses ──────────────────────────────────────────────────

  it.each(["partial", "blocked", "failed"] as const)(
    "passes DB '%s' through to UI unchanged",
    async (status) => {
      const db = makeDb({ row: makeRow(status) });
      const repo = new DiscoveryRunsRepository(db as never);
      const result = await repo.getLatestRunForUser("user-1");
      expect(result!.status).toBe(status);
    },
  );

  // ── DB "completed" → derivation ───────────────────────────────────────────

  it("maps DB 'completed' to 'completed_candidates' when candidates exist", async () => {
    const db = makeDb({
      row: makeRow("completed", "run-abc"),
      invocations: [{ id: "inv-1" }],
      evidences: [{ id: "ev-1" }],
      candidateCount: 3,
    });
    const repo = new DiscoveryRunsRepository(db as never);
    const result = await repo.getLatestRunForUser("user-1");
    expect(result!.status).toBe("completed_candidates");
  });

  it("maps DB 'completed' to 'completed_zero' when zero candidates exist", async () => {
    const db = makeDb({
      row: makeRow("completed", "run-abc"),
      invocations: [{ id: "inv-1" }],
      evidences: [{ id: "ev-1" }],
      candidateCount: 0,
    });
    const repo = new DiscoveryRunsRepository(db as never);
    const result = await repo.getLatestRunForUser("user-1");
    expect(result!.status).toBe("completed_zero");
  });

  it("maps DB 'completed' to 'completed_zero' when no invocations exist (hop-1 short-circuit)", async () => {
    const db = makeDb({
      row: makeRow("completed"),
      invocations: [],
    });
    const repo = new DiscoveryRunsRepository(db as never);
    const result = await repo.getLatestRunForUser("user-1");
    expect(result!.status).toBe("completed_zero");
  });

  it("maps DB 'completed' to 'completed_zero' when invocations exist but no evidence (hop-2 short-circuit)", async () => {
    const db = makeDb({
      row: makeRow("completed"),
      invocations: [{ id: "inv-1" }],
      evidences: [],
    });
    const repo = new DiscoveryRunsRepository(db as never);
    const result = await repo.getLatestRunForUser("user-1");
    expect(result!.status).toBe("completed_zero");
  });

  // ── Derivation errors must throw, not silently return zero ────────────────

  it("throws DiscoveryRunsStoreError when invocations hop fails (not silent zero)", async () => {
    const db = makeDb({
      row: makeRow("completed"),
      invocationError: { message: "db error" },
    });
    const repo = new DiscoveryRunsRepository(db as never);
    await expect(repo.getLatestRunForUser("user-1")).rejects.toBeInstanceOf(
      DiscoveryRunsStoreError,
    );
  });

  it("throws DiscoveryRunsStoreError when evidence hop fails", async () => {
    const db = makeDb({
      row: makeRow("completed"),
      invocations: [{ id: "inv-1" }],
      evidenceError: { message: "db error" },
    });
    const repo = new DiscoveryRunsRepository(db as never);
    await expect(repo.getLatestRunForUser("user-1")).rejects.toBeInstanceOf(
      DiscoveryRunsStoreError,
    );
  });

  it("throws DiscoveryRunsStoreError when candidates hop fails", async () => {
    const db = makeDb({
      row: makeRow("completed"),
      invocations: [{ id: "inv-1" }],
      evidences: [{ id: "ev-1" }],
      candidateError: { message: "db error" },
    });
    const repo = new DiscoveryRunsRepository(db as never);
    await expect(repo.getLatestRunForUser("user-1")).rejects.toBeInstanceOf(
      DiscoveryRunsStoreError,
    );
  });

  // ── Scope assertions ───────────────────────────────────────────────────────

  it("scopes the main query to the given user_id", async () => {
    const db = makeDb({ row: null });
    const repo = new DiscoveryRunsRepository(db as never);
    await repo.getLatestRunForUser("scoped-user");
    expect(db._eq).toHaveBeenCalledWith("user_id", "scoped-user");
  });

  it("scopes the invocations derivation query to run_id", async () => {
    const db = makeDb({
      row: makeRow("completed", "run-xyz"),
      invocations: [{ id: "inv-1" }],
      evidences: [{ id: "ev-1" }],
      candidateCount: 0,
    });
    const repo = new DiscoveryRunsRepository(db as never);
    await repo.getLatestRunForUser("user-1");
    expect(db._invEq).toHaveBeenCalledWith("run_id", "run-xyz");
  });

  // ── Unknown / guard fallback ───────────────────────────────────────────────

  it("normalises an unrecognised run_status to 'failed'", async () => {
    const db = makeDb({ row: makeRow("unknown_future_status") });
    const repo = new DiscoveryRunsRepository(db as never);
    const result = await repo.getLatestRunForUser("user-1");
    expect(result!.status).toBe("failed");
  });

  // ── Shape / privacy ────────────────────────────────────────────────────────

  it("result does not include user_id (display-safe only)", async () => {
    const db = makeDb({ row: makeRow("running") });
    const repo = new DiscoveryRunsRepository(db as never);
    const result = await repo.getLatestRunForUser("user-1");
    expect(Object.keys(result!)).not.toContain("userId");
    expect(Object.keys(result!)).not.toContain("user_id");
  });

  it("result includes id and createdAt", async () => {
    const db = makeDb({
      row: { id: "run-abc", run_status: "running", created_at: "2026-01-15T10:00:00Z" },
    });
    const repo = new DiscoveryRunsRepository(db as never);
    const result = await repo.getLatestRunForUser("user-1");
    expect(result!.id).toBe("run-abc");
    expect(result!.createdAt).toBe("2026-01-15T10:00:00Z");
  });

  // ── Main query error handling ──────────────────────────────────────────────

  it("throws DiscoveryRunsStoreError on main query DB error", async () => {
    const db = makeDb({ error: { message: "connection refused" } });
    const repo = new DiscoveryRunsRepository(db as never);
    await expect(repo.getLatestRunForUser("user-1")).rejects.toBeInstanceOf(
      DiscoveryRunsStoreError,
    );
  });

  it("DiscoveryRunsStoreError does not expose DB error detail", async () => {
    const db = makeDb({ error: { message: "secret internal detail" } });
    const repo = new DiscoveryRunsRepository(db as never);
    let caught: unknown;
    try {
      await repo.getLatestRunForUser("user-1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DiscoveryRunsStoreError);
    expect((caught as DiscoveryRunsStoreError).message).not.toContain("secret");
  });
});
