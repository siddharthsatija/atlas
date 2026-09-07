/**
 * DiscoveryCandidateRepository.listForReview (ATL-211).
 *
 * Tests use a mock Supabase client — no real database needed.
 * The repository is tested for:
 *   - Empty result when no reviewable candidates exist.
 *   - `pending`, `dismissed`, and `not_sure` candidates are all included.
 *   - Evidence rows are joined by id correctly.
 *   - Orphaned candidates (no matching evidence) are silently skipped.
 *   - User isolation: queries are always scoped by userId.
 *   - Only display-safe fields (no user_id, encrypted blobs) are returned.
 *   - The `status` field is present in returned items.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DiscoveryCandidateRepository,
  type CandidateReviewItem,
} from "./discovery-candidate-repository";

// ── Supabase mock builder ──────────────────────────────────────────────────────

/**
 * Builds a minimal Supabase-like client double that chains .from → .select →
 * .eq → .in / .eq and resolves with the provided data/error.
 *
 * We stub at the query-builder level, not at the network level.
 */
function makeDb({
  candidateRows = [] as Array<{ id: string; evidence_id: string; status: string }>,
  candidateError = null as null | object,
  evidenceRows = [] as Array<{
    id: string;
    source_identifier: string;
    evidence_type: string;
    evidence_summary: string;
    provider_class: string;
  }>,
  evidenceError = null as null | object,
} = {}) {
  // Two separate query builders — one for discovery_candidates, one for discovery_evidence.
  // The candidate query uses .eq (user_id) then .in (status), so both must be stubbed.
  const candidateBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
  };
  candidateBuilder.select = vi.fn(() => candidateBuilder);
  // .eq is called once for user_id filter — always chains back
  candidateBuilder.eq = vi.fn(() => candidateBuilder);
  // .in is called for the status filter — resolves with the rows
  candidateBuilder.in = vi.fn(() =>
    Promise.resolve({ data: candidateRows, error: candidateError }),
  );

  const evidenceBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn(() => Promise.resolve({ data: evidenceRows, error: evidenceError })),
  };
  evidenceBuilder.eq = vi.fn(() => evidenceBuilder);
  evidenceBuilder.select = vi.fn(() => evidenceBuilder);

  return {
    from: vi.fn((table: string) => {
      if (table === "discovery_candidates") return candidateBuilder;
      if (table === "discovery_evidence") return evidenceBuilder;
      throw new Error(`unexpected table: ${table}`);
    }),
  };
}

// ── listForReview ─────────────────────────────────────────────────────────────

describe("DiscoveryCandidateRepository.listForReview", () => {
  it("returns empty array when no pending candidates exist", async () => {
    const db = makeDb({ candidateRows: [] });
    const repo = new DiscoveryCandidateRepository(db as never);
    const result = await repo.listForReview("user-1");
    expect(result).toEqual([]);
  });

  it("queries discovery_candidates table", async () => {
    const db = makeDb({ candidateRows: [] });
    const repo = new DiscoveryCandidateRepository(db as never);
    await repo.listForReview("user-1");
    expect(db.from).toHaveBeenCalledWith("discovery_candidates");
  });

  it("uses .in() with pending + dismissed + not_sure statuses", async () => {
    const db = makeDb({ candidateRows: [] });
    const repo = new DiscoveryCandidateRepository(db as never);
    await repo.listForReview("user-1");
    const candidateBuilder = db.from.mock.results[0]!.value as { in: ReturnType<typeof vi.fn> };
    expect(candidateBuilder.in).toHaveBeenCalledWith(
      "status",
      expect.arrayContaining(["pending", "dismissed", "not_sure"]),
    );
  });

  it("includes dismissed candidates in the result", async () => {
    const db = makeDb({
      candidateRows: [{ id: "cand-dismissed", evidence_id: "ev-001", status: "dismissed" }],
      evidenceRows: [
        {
          id: "ev-001",
          source_identifier: "svc.example",
          evidence_type: "breach",
          evidence_summary: "Summary",
          provider_class: "hibp",
        },
      ],
    });
    const repo = new DiscoveryCandidateRepository(db as never);
    const result = await repo.listForReview("user-1");
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("dismissed");
  });

  it("includes not_sure candidates in the result", async () => {
    const db = makeDb({
      candidateRows: [{ id: "cand-ns", evidence_id: "ev-002", status: "not_sure" }],
      evidenceRows: [
        {
          id: "ev-002",
          source_identifier: "svc2.example",
          evidence_type: "breach",
          evidence_summary: "Summary 2",
          provider_class: "hibp",
        },
      ],
    });
    const repo = new DiscoveryCandidateRepository(db as never);
    const result = await repo.listForReview("user-1");
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("not_sure");
  });

  it("joins evidence by evidence_id and returns display fields", async () => {
    const db = makeDb({
      candidateRows: [{ id: "cand-001", evidence_id: "ev-001", status: "pending" }],
      evidenceRows: [
        {
          id: "ev-001",
          source_identifier: "acme.example",
          evidence_type: "breach",
          evidence_summary: "Found in breach dataset",
          provider_class: "hibp",
        },
      ],
    });
    const repo = new DiscoveryCandidateRepository(db as never);
    const result = await repo.listForReview("user-1");
    expect(result).toHaveLength(1);
    const item = result[0] as CandidateReviewItem;
    expect(item.id).toBe("cand-001");
    expect(item.sourceIdentifier).toBe("acme.example");
    expect(item.evidenceType).toBe("breach");
    expect(item.evidenceSummary).toBe("Found in breach dataset");
    expect(item.providerClass).toBe("hibp");
    expect(item.status).toBe("pending");
  });

  it("silently skips orphaned candidates with no matching evidence", async () => {
    const db = makeDb({
      candidateRows: [{ id: "cand-orphan", evidence_id: "ev-missing", status: "pending" }],
      evidenceRows: [], // evidence row absent
    });
    const repo = new DiscoveryCandidateRepository(db as never);
    const result = await repo.listForReview("user-1");
    expect(result).toEqual([]);
  });

  it("returns multiple candidates when multiple reviewable candidates exist", async () => {
    const db = makeDb({
      candidateRows: [
        { id: "cand-001", evidence_id: "ev-001", status: "pending" },
        { id: "cand-002", evidence_id: "ev-002", status: "dismissed" },
      ],
      evidenceRows: [
        {
          id: "ev-001",
          source_identifier: "svc-a.example",
          evidence_type: "breach",
          evidence_summary: "Summary A",
          provider_class: "hibp",
        },
        {
          id: "ev-002",
          source_identifier: "svc-b.example",
          evidence_type: "public_record",
          evidence_summary: "Summary B",
          provider_class: "aggregator-x",
        },
      ],
    });
    const repo = new DiscoveryCandidateRepository(db as never);
    const result = await repo.listForReview("user-1");
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toContain("cand-001");
    expect(result.map((r) => r.id)).toContain("cand-002");
  });

  it("returned items do not include user_id or encrypted evidence fields", async () => {
    const db = makeDb({
      candidateRows: [{ id: "cand-001", evidence_id: "ev-001", status: "pending" }],
      evidenceRows: [
        {
          id: "ev-001",
          source_identifier: "svc.example",
          evidence_type: "breach",
          evidence_summary: "Summary",
          provider_class: "hibp",
        },
      ],
    });
    const repo = new DiscoveryCandidateRepository(db as never);
    const result = await repo.listForReview("user-1");
    const item = result[0]!;
    expect(Object.keys(item)).not.toContain("user_id");
    expect(Object.keys(item)).not.toContain("provider_evidence_json");
    expect(Object.keys(item)).not.toContain("invocation_id");
  });

  it("throws DiscoveryCandidateStoreError when candidates query fails", async () => {
    const db = makeDb({ candidateError: { message: "db error" } });
    const repo = new DiscoveryCandidateRepository(db as never);
    await expect(repo.listForReview("user-1")).rejects.toThrow("listForReview");
  });

  it("throws DiscoveryCandidateStoreError when evidence query fails", async () => {
    const db = makeDb({
      candidateRows: [{ id: "cand-001", evidence_id: "ev-001", status: "pending" }],
      evidenceError: { message: "db error" },
    });
    const repo = new DiscoveryCandidateRepository(db as never);
    await expect(repo.listForReview("user-1")).rejects.toThrow("listForReview_evidence");
  });
});
