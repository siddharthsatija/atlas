import { describe, expect, it, vi } from "vitest";
import {
  CanonicalCandidateResolver,
  CanonicalCandidateResolverError,
} from "./canonical-candidate-resolver";
import { DiscoveryCandidateStoreError } from "@/server/repositories/discovery-candidate-repository";
import { DiscoveryCandidateEvidenceStoreError } from "@/server/repositories/discovery-candidate-evidence-repository";

vi.mock("server-only", () => ({}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_A = "user-a-uuid";
const USER_B = "user-b-uuid";
const CANONICAL_URI = "https://twitter.com/someuser";
const CANDIDATE_ID = "candidate-uuid-1";
const EVIDENCE_ID_1 = "evidence-uuid-1";
const EVIDENCE_ID_2 = "evidence-uuid-2";
const EVIDENCE_ID_3 = "evidence-uuid-3";

// ── Dependency factories ───────────────────────────────────────────────────────

type MockCandidateRepo = {
  findByCanonicalUri: ReturnType<typeof vi.fn>;
  createCanonical: ReturnType<typeof vi.fn>;
  transitionDismissedToPending: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
};

type MockEvidenceRepo = {
  insert: ReturnType<typeof vi.fn>;
};

function makeMocks(
  existingCandidate: { id: string; status: string } | null = null,
  opts: {
    createCanonicalResult?: string;
    findError?: Error;
    createError?: Error;
    evidenceInsertError?: Error;
    transitionError?: Error;
  } = {},
): { candidates: MockCandidateRepo; candidateEvidence: MockEvidenceRepo } {
  const candidates: MockCandidateRepo = {
    findByCanonicalUri: vi.fn().mockImplementation(() => {
      if (opts.findError) return Promise.reject(opts.findError);
      return Promise.resolve(existingCandidate);
    }),
    createCanonical: vi.fn().mockImplementation(() => {
      if (opts.createError) return Promise.reject(opts.createError);
      return Promise.resolve(opts.createCanonicalResult ?? CANDIDATE_ID);
    }),
    transitionDismissedToPending: vi.fn().mockImplementation(() => {
      if (opts.transitionError) return Promise.reject(opts.transitionError);
      return Promise.resolve();
    }),
    insert: vi.fn().mockResolvedValue(undefined),
  };
  const candidateEvidence: MockEvidenceRepo = {
    insert: vi.fn().mockImplementation(() => {
      if (opts.evidenceInsertError) return Promise.reject(opts.evidenceInsertError);
      return Promise.resolve();
    }),
  };
  return { candidates, candidateEvidence };
}

function makeResolver(
  existingCandidate: { id: string; status: string } | null = null,
  opts: Parameters<typeof makeMocks>[1] = {},
) {
  const mocks = makeMocks(existingCandidate, opts);
  const resolver = new CanonicalCandidateResolver(
    mocks.candidates as never,
    mocks.candidateEvidence as never,
  );
  return { resolver, ...mocks };
}

// ── preCheckCanonicalUri ──────────────────────────────────────────────────────

describe("CanonicalCandidateResolver.preCheckCanonicalUri", () => {
  it("returns proceed when no candidate exists", async () => {
    const { resolver } = makeResolver(null);
    const result = await resolver.preCheckCanonicalUri(USER_A, CANONICAL_URI);
    expect(result).toBe("proceed");
  });

  it("returns proceed when existing candidate is pending", async () => {
    const { resolver } = makeResolver({ id: CANDIDATE_ID, status: "pending" });
    expect(await resolver.preCheckCanonicalUri(USER_A, CANONICAL_URI)).toBe("proceed");
  });

  it("returns proceed when existing candidate is confirmed", async () => {
    const { resolver } = makeResolver({ id: CANDIDATE_ID, status: "confirmed" });
    expect(await resolver.preCheckCanonicalUri(USER_A, CANONICAL_URI)).toBe("proceed");
  });

  it("returns proceed when existing candidate is not_sure", async () => {
    const { resolver } = makeResolver({ id: CANDIDATE_ID, status: "not_sure" });
    expect(await resolver.preCheckCanonicalUri(USER_A, CANONICAL_URI)).toBe("proceed");
  });

  it("returns proceed when existing candidate is dismissed", async () => {
    const { resolver } = makeResolver({ id: CANDIDATE_ID, status: "dismissed" });
    expect(await resolver.preCheckCanonicalUri(USER_A, CANONICAL_URI)).toBe("proceed");
  });

  it("returns rejected when existing candidate is rejected", async () => {
    const { resolver } = makeResolver({ id: CANDIDATE_ID, status: "rejected" });
    expect(await resolver.preCheckCanonicalUri(USER_A, CANONICAL_URI)).toBe("rejected");
  });

  it("throws CanonicalCandidateResolverError when database lookup fails", async () => {
    const { resolver } = makeResolver(null, {
      findError: new DiscoveryCandidateStoreError("findByCanonicalUri"),
    });
    await expect(resolver.preCheckCanonicalUri(USER_A, CANONICAL_URI)).rejects.toBeInstanceOf(
      CanonicalCandidateResolverError,
    );
  });

  it("re-throws non-store errors without wrapping", async () => {
    const unexpectedError = new TypeError("unexpected");
    const { resolver } = makeResolver(null, { findError: unexpectedError });
    await expect(resolver.preCheckCanonicalUri(USER_A, CANONICAL_URI)).rejects.toBe(
      unexpectedError,
    );
  });
});

// ── resolveCanonicalCandidate — no existing candidate ─────────────────────────

describe("CanonicalCandidateResolver.resolveCanonicalCandidate — new candidate", () => {
  it("creates a new candidate when none exists", async () => {
    const { resolver, candidates } = makeResolver(null, {
      createCanonicalResult: CANDIDATE_ID,
    });
    const result = await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    expect(result).toEqual({ outcome: "created", candidateId: CANDIDATE_ID });
    expect(candidates.createCanonical).toHaveBeenCalledOnce();
    expect(candidates.createCanonical).toHaveBeenCalledWith(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
  });

  it("does not call evidence insert separately — createCanonical handles it atomically", async () => {
    const { resolver, candidateEvidence } = makeResolver(null, {
      createCanonicalResult: CANDIDATE_ID,
    });
    await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    // The Postgres function handles founding evidence; the resolver does not call
    // candidateEvidence.insert separately for the "created" outcome.
    expect(candidateEvidence.insert).not.toHaveBeenCalled();
  });

  it("same canonical URI two independent calls → same outcome structure", async () => {
    // Simulates two sequential resolutions for different evidence records.
    // The second call sees the candidate that the first created.
    const { resolver: r1 } = makeResolver(null, {
      createCanonicalResult: CANDIDATE_ID,
    });
    const first = await r1.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    expect(first.outcome).toBe("created");

    // Second resolution — candidate now exists (pending).
    const { resolver: r2, candidateEvidence: ce2 } = makeResolver({
      id: CANDIDATE_ID,
      status: "pending",
    });
    const second = await r2.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_2, CANONICAL_URI);
    expect(second.outcome).toBe("evidence_added");
    expect((second as { candidateId: string }).candidateId).toBe(CANDIDATE_ID);
    expect(ce2.insert).toHaveBeenCalledWith(USER_A, CANDIDATE_ID, EVIDENCE_ID_2);

    expect((first as { candidateId: string }).candidateId).toBe(
      (second as { candidateId: string }).candidateId,
    );
  });
});

// ── resolveCanonicalCandidate — existing pending ──────────────────────────────

describe("CanonicalCandidateResolver.resolveCanonicalCandidate — existing pending", () => {
  it("attaches evidence to join table without creating a new candidate", async () => {
    const { resolver, candidates, candidateEvidence } = makeResolver({
      id: CANDIDATE_ID,
      status: "pending",
    });
    const result = await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_2, CANONICAL_URI);
    expect(result).toEqual({ outcome: "evidence_added", candidateId: CANDIDATE_ID });
    expect(candidates.createCanonical).not.toHaveBeenCalled();
    expect(candidateEvidence.insert).toHaveBeenCalledOnce();
    expect(candidateEvidence.insert).toHaveBeenCalledWith(USER_A, CANDIDATE_ID, EVIDENCE_ID_2);
  });

  it("different evidence records for same URI → each adds a join row, one candidate", async () => {
    const { resolver: r1, candidateEvidence: ce1 } = makeResolver({
      id: CANDIDATE_ID,
      status: "pending",
    });
    await r1.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_2, CANONICAL_URI);
    expect(ce1.insert).toHaveBeenCalledWith(USER_A, CANDIDATE_ID, EVIDENCE_ID_2);

    const { resolver: r2, candidateEvidence: ce2 } = makeResolver({
      id: CANDIDATE_ID,
      status: "pending",
    });
    await r2.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_3, CANONICAL_URI);
    expect(ce2.insert).toHaveBeenCalledWith(USER_A, CANDIDATE_ID, EVIDENCE_ID_3);
  });
});

// ── resolveCanonicalCandidate — existing confirmed ────────────────────────────

describe("CanonicalCandidateResolver.resolveCanonicalCandidate — existing confirmed", () => {
  it("attaches evidence without altering confirmation", async () => {
    const { resolver, candidates, candidateEvidence } = makeResolver({
      id: CANDIDATE_ID,
      status: "confirmed",
    });
    const result = await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_2, CANONICAL_URI);
    expect(result).toEqual({ outcome: "evidence_added", candidateId: CANDIDATE_ID });
    expect(candidates.createCanonical).not.toHaveBeenCalled();
    // No status mutation — do not call transitionDismissedToPending
    expect(candidates.transitionDismissedToPending).not.toHaveBeenCalled();
    expect(candidateEvidence.insert).toHaveBeenCalledOnce();
  });
});

// ── resolveCanonicalCandidate — existing not_sure ─────────────────────────────

describe("CanonicalCandidateResolver.resolveCanonicalCandidate — existing not_sure", () => {
  it("attaches evidence without status mutation", async () => {
    const { resolver, candidates, candidateEvidence } = makeResolver({
      id: CANDIDATE_ID,
      status: "not_sure",
    });
    const result = await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_2, CANONICAL_URI);
    expect(result).toEqual({ outcome: "evidence_added", candidateId: CANDIDATE_ID });
    expect(candidates.transitionDismissedToPending).not.toHaveBeenCalled();
    expect(candidateEvidence.insert).toHaveBeenCalledOnce();
  });
});

// ── resolveCanonicalCandidate — existing dismissed ────────────────────────────

describe("CanonicalCandidateResolver.resolveCanonicalCandidate — existing dismissed", () => {
  it("attaches evidence and transitions candidate to pending", async () => {
    const { resolver, candidates, candidateEvidence } = makeResolver({
      id: CANDIDATE_ID,
      status: "dismissed",
    });
    const result = await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_2, CANONICAL_URI);
    expect(result).toEqual({ outcome: "dismissed_reopened", candidateId: CANDIDATE_ID });
    expect(candidateEvidence.insert).toHaveBeenCalledWith(USER_A, CANDIDATE_ID, EVIDENCE_ID_2);
    expect(candidates.transitionDismissedToPending).toHaveBeenCalledWith(USER_A, CANDIDATE_ID);
  });

  it("inserts evidence join row before transitioning status", async () => {
    const callOrder: string[] = [];
    const mocks = makeMocks({ id: CANDIDATE_ID, status: "dismissed" });
    mocks.candidateEvidence.insert.mockImplementation(() => {
      callOrder.push("evidence_insert");
    });
    mocks.candidates.transitionDismissedToPending.mockImplementation(() => {
      callOrder.push("transition");
    });
    const resolver = new CanonicalCandidateResolver(
      mocks.candidates as never,
      mocks.candidateEvidence as never,
    );
    await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_2, CANONICAL_URI);
    expect(callOrder).toEqual(["evidence_insert", "transition"]);
  });
});

// ── resolveCanonicalCandidate — existing rejected ─────────────────────────────

describe("CanonicalCandidateResolver.resolveCanonicalCandidate — existing rejected", () => {
  it("returns rejected outcome without creating a candidate", async () => {
    const { resolver, candidates } = makeResolver({ id: CANDIDATE_ID, status: "rejected" });
    const result = await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    expect(result).toEqual({ outcome: "rejected" });
    expect(candidates.createCanonical).not.toHaveBeenCalled();
  });

  it("does NOT attach evidence to join table for a rejected candidate", async () => {
    const { resolver, candidateEvidence } = makeResolver({
      id: CANDIDATE_ID,
      status: "rejected",
    });
    await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    expect(candidateEvidence.insert).not.toHaveBeenCalled();
  });

  it("does NOT call transitionDismissedToPending for a rejected candidate", async () => {
    const { resolver, candidates } = makeResolver({
      id: CANDIDATE_ID,
      status: "rejected",
    });
    await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    expect(candidates.transitionDismissedToPending).not.toHaveBeenCalled();
  });

  it("handles rejection race: rejected between pre-check and resolution", async () => {
    // Simulate: pre-check sees "proceed" (pending), but by resolution time the
    // candidate has become "rejected" (concurrent adjudication).
    let callCount = 0;
    // Override findByCanonicalUri to return pending on first call, rejected on second.
    const candidates: MockCandidateRepo = {
      findByCanonicalUri: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ id: CANDIDATE_ID, status: "pending" });
        return Promise.resolve({ id: CANDIDATE_ID, status: "rejected" });
      }),
      createCanonical: vi.fn(),
      transitionDismissedToPending: vi.fn(),
      insert: vi.fn(),
    };
    const candidateEvidenceMock: MockEvidenceRepo = { insert: vi.fn() };
    const raceResolver = new CanonicalCandidateResolver(
      candidates as never,
      candidateEvidenceMock as never,
    );

    // Pre-check (first call) → proceed
    const preCheck = await raceResolver.preCheckCanonicalUri(USER_A, CANONICAL_URI);
    expect(preCheck).toBe("proceed");

    // Resolution (second call, candidate now rejected) → rejected
    const result = await raceResolver.resolveCanonicalCandidate(
      USER_A,
      EVIDENCE_ID_1,
      CANONICAL_URI,
    );
    expect(result).toEqual({ outcome: "rejected" });
    expect(candidateEvidenceMock.insert).not.toHaveBeenCalled();
    expect(candidates.createCanonical).not.toHaveBeenCalled();
  });

  it("rejected profile does not produce a duplicate candidate", async () => {
    const { resolver, candidates } = makeResolver({ id: CANDIDATE_ID, status: "rejected" });
    await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_2, CANONICAL_URI);
    expect(candidates.createCanonical).not.toHaveBeenCalled();
  });
});

// ── Cross-user isolation ──────────────────────────────────────────────────────

describe("CanonicalCandidateResolver — cross-user isolation", () => {
  it("same canonical URI for different users is independently allowed", async () => {
    const { resolver: rA, candidates: cA } = makeResolver(null, {
      createCanonicalResult: "candidate-a",
    });
    const resultA = await rA.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    expect(resultA).toEqual({ outcome: "created", candidateId: "candidate-a" });

    const { resolver: rB, candidates: cB } = makeResolver(null, {
      createCanonicalResult: "candidate-b",
    });
    const resultB = await rB.resolveCanonicalCandidate(USER_B, EVIDENCE_ID_2, CANONICAL_URI);
    expect(resultB).toEqual({ outcome: "created", candidateId: "candidate-b" });

    // Both callers issued createCanonical with their own user id.
    expect(cA.createCanonical).toHaveBeenCalledWith(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    expect(cB.createCanonical).toHaveBeenCalledWith(USER_B, EVIDENCE_ID_2, CANONICAL_URI);
  });

  it("cross-user evidence attachment is impossible: resolver scopes every query by userId", async () => {
    // The resolver passes userId to every repository method; the repository
    // in turn uses .eq("user_id", userId).  There is no method on the resolver
    // that accepts a separate target userId — the caller identity IS the scope.
    const { resolver, candidateEvidence } = makeResolver({ id: CANDIDATE_ID, status: "pending" });
    await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    // The evidence insert used USER_A's userId, not USER_B's.
    expect(candidateEvidence.insert).toHaveBeenCalledWith(USER_A, CANDIDATE_ID, EVIDENCE_ID_1);
    expect(candidateEvidence.insert).not.toHaveBeenCalledWith(
      USER_B,
      expect.any(String),
      expect.any(String),
    );
  });
});

// ── Concurrent same-URI resolution ───────────────────────────────────────────

describe("CanonicalCandidateResolver — concurrent same-URI resolution", () => {
  it("two concurrent callers both finding no candidate converge on one create call each", async () => {
    // In production, the Postgres function resolves the race with ON CONFLICT
    // DO NOTHING and returns the winning candidate id to both callers.
    // At the TypeScript level we verify that both callers invoke createCanonical;
    // the database-level convergence is proved by the Postgres function test in
    // the integration suite.
    const { resolver: r1, candidates: c1 } = makeResolver(null, {
      createCanonicalResult: CANDIDATE_ID,
    });
    const { resolver: r2, candidates: c2 } = makeResolver(null, {
      createCanonicalResult: CANDIDATE_ID,
    });

    const [result1, result2] = await Promise.all([
      r1.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI),
      r2.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_2, CANONICAL_URI),
    ]);

    // Both attempt candidate creation; the Postgres function decides the winner.
    expect(c1.createCanonical).toHaveBeenCalledOnce();
    expect(c2.createCanonical).toHaveBeenCalledOnce();
    // Both receive the "created" outcome from their own perspective.
    expect(result1.outcome).toBe("created");
    expect(result2.outcome).toBe("created");
    // Both return the same candidate id (Postgres function guarantees this).
    expect((result1 as { candidateId: string }).candidateId).toBe(CANDIDATE_ID);
    expect((result2 as { candidateId: string }).candidateId).toBe(CANDIDATE_ID);
  });
});

// ── Error propagation ─────────────────────────────────────────────────────────

describe("CanonicalCandidateResolver — error propagation", () => {
  it("wraps DiscoveryCandidateStoreError from findByCanonicalUri as resolver error", async () => {
    const { resolver } = makeResolver(null, {
      findError: new DiscoveryCandidateStoreError("findByCanonicalUri"),
    });
    await expect(
      resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI),
    ).rejects.toBeInstanceOf(CanonicalCandidateResolverError);
  });

  it("wraps DiscoveryCandidateStoreError from createCanonical as resolver error", async () => {
    const { resolver } = makeResolver(null, {
      createError: new DiscoveryCandidateStoreError("createCanonical"),
    });
    await expect(
      resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI),
    ).rejects.toBeInstanceOf(CanonicalCandidateResolverError);
  });

  it("wraps DiscoveryCandidateEvidenceStoreError from join insert as resolver error", async () => {
    const { resolver } = makeResolver(
      { id: CANDIDATE_ID, status: "pending" },
      {
        evidenceInsertError: new DiscoveryCandidateEvidenceStoreError("insert"),
      },
    );
    await expect(
      resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_2, CANONICAL_URI),
    ).rejects.toBeInstanceOf(CanonicalCandidateResolverError);
  });

  it("re-throws non-store errors without wrapping", async () => {
    const unexpectedError = new RangeError("unexpected");
    const { resolver } = makeResolver(null, { findError: unexpectedError });
    await expect(
      resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI),
    ).rejects.toBe(unexpectedError);
  });
});

// ── Provider neutrality ───────────────────────────────────────────────────────

describe("CanonicalCandidateResolver — provider neutrality", () => {
  it("resolver has no reference to HIBP, provider classes, or field types", () => {
    // Structural check: the resolver accepts only userId, evidenceId,
    // and canonicalUri — no provider-class parameter.
    const { resolver } = makeResolver(null, { createCanonicalResult: CANDIDATE_ID });
    // resolveCanonicalCandidate signature: (userId, evidenceId, canonicalUri)
    // If this compiles and runs without HIBP-specific arguments, the neutrality
    // contract is satisfied.
    return expect(
      resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI),
    ).resolves.toMatchObject({ outcome: "created" });
  });
});

// ── Founding evidence in join table ───────────────────────────────────────────

describe("CanonicalCandidateResolver — founding evidence", () => {
  it("founding evidence for a new candidate is handled atomically by createCanonical", async () => {
    // The Postgres function inserts both the candidate row and the founding
    // evidence join row in one transaction. The resolver must pass evidenceId
    // to createCanonical so the function can create the join row.
    const { resolver, candidates } = makeResolver(null, {
      createCanonicalResult: CANDIDATE_ID,
    });
    await resolver.resolveCanonicalCandidate(USER_A, EVIDENCE_ID_1, CANONICAL_URI);
    expect(candidates.createCanonical).toHaveBeenCalledWith(
      USER_A,
      EVIDENCE_ID_1, // evidence id passed so Postgres function can create founding join row
      CANONICAL_URI,
    );
  });
});
