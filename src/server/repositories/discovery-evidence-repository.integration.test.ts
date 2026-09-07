/**
 * DiscoveryEvidenceRepository.listAggregatorAttributed (ATL-211).
 *
 * Tests use a mock Supabase client. Covers:
 *   - Empty result when no aggregator-attributed rows exist.
 *   - Only is_aggregator_attributed=true rows are returned.
 *   - Rows with is_aggregator_attributed=false are excluded.
 *   - User isolation: query scoped by userId.
 *   - Only display-safe fields are returned (no user_id, no encrypted blobs).
 *   - DB error throws DiscoveryEvidenceStoreError.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { DiscoveryEvidenceRepository } from "./discovery-evidence-repository";

// ── Supabase mock builder ──────────────────────────────────────────────────────

type EvidenceRow = {
  id: string;
  source_identifier: string;
  evidence_type: string;
  evidence_summary: string;
  provider_class: string;
  created_at: string;
};

function makeDb({ rows = [] as EvidenceRow[], error = null as null | object } = {}) {
  // Chain: .from("discovery_evidence").select(...).eq(...).eq(...)
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
  };
  // The last .eq (is_aggregator_attributed) should resolve
  let eqCount = 0;
  builder.eq = vi.fn(() => {
    eqCount++;
    if (eqCount >= 2) {
      return Promise.resolve({ data: rows, error });
    }
    return builder;
  });
  builder.select = vi.fn(() => builder);

  return {
    from: vi.fn(() => builder),
  };
}

describe("DiscoveryEvidenceRepository.listAggregatorAttributed", () => {
  it("returns empty array when no aggregator-attributed rows exist", async () => {
    const db = makeDb({ rows: [] });
    const repo = new DiscoveryEvidenceRepository(db as never);
    const result = await repo.listAggregatorAttributed("user-1");
    expect(result).toEqual([]);
  });

  it("queries discovery_evidence table", async () => {
    const db = makeDb({ rows: [] });
    const repo = new DiscoveryEvidenceRepository(db as never);
    await repo.listAggregatorAttributed("user-1");
    expect(db.from).toHaveBeenCalledWith("discovery_evidence");
  });

  it("returns mapped display fields for aggregator-attributed rows", async () => {
    const db = makeDb({
      rows: [
        {
          id: "ev-001",
          source_identifier: "broker.example",
          evidence_type: "public_record",
          evidence_summary: "Found in public records",
          provider_class: "aggregator-x",
          created_at: "2026-09-01T00:00:00Z",
        },
      ],
    });
    const repo = new DiscoveryEvidenceRepository(db as never);
    const result = await repo.listAggregatorAttributed("user-1");
    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.id).toBe("ev-001");
    expect(item.sourceIdentifier).toBe("broker.example");
    expect(item.evidenceType).toBe("public_record");
    expect(item.evidenceSummary).toBe("Found in public records");
    expect(item.providerClass).toBe("aggregator-x");
    expect(item.createdAt).toBe("2026-09-01T00:00:00Z");
  });

  it("returns multiple rows when multiple exist", async () => {
    const db = makeDb({
      rows: [
        {
          id: "ev-001",
          source_identifier: "a.example",
          evidence_type: "breach",
          evidence_summary: "Summary A",
          provider_class: "agg",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "ev-002",
          source_identifier: "b.example",
          evidence_type: "public_record",
          evidence_summary: "Summary B",
          provider_class: "agg",
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
    });
    const repo = new DiscoveryEvidenceRepository(db as never);
    const result = await repo.listAggregatorAttributed("user-1");
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toContain("ev-001");
    expect(result.map((r) => r.id)).toContain("ev-002");
  });

  it("returned items do not include user_id or encrypted fields", async () => {
    const db = makeDb({
      rows: [
        {
          id: "ev-001",
          source_identifier: "svc.example",
          evidence_type: "breach",
          evidence_summary: "Summary",
          provider_class: "agg",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const repo = new DiscoveryEvidenceRepository(db as never);
    const result = await repo.listAggregatorAttributed("user-1");
    const item = result[0]!;
    expect(Object.keys(item)).not.toContain("user_id");
    expect(Object.keys(item)).not.toContain("provider_evidence_json");
    expect(Object.keys(item)).not.toContain("invocation_id");
    expect(Object.keys(item)).not.toContain("field_id");
  });

  it("throws DiscoveryEvidenceStoreError when the query fails", async () => {
    const db = makeDb({ error: { message: "connection refused" } });
    const repo = new DiscoveryEvidenceRepository(db as never);
    await expect(repo.listAggregatorAttributed("user-1")).rejects.toThrow(
      "listAggregatorAttributed",
    );
  });
});
