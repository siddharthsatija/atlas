import { beforeEach, describe, expect, it, vi } from "vitest";
import { CryptoError } from "@/server/crypto/envelope";
import type { GithubProviderData } from "./github-adapter";
import { GITHUB_PROVIDER_CLASS } from "./github-adapter";
import { GithubResultWriter, GithubResultWriterError } from "./github-result-writer";
import type { CanonicalResolutionOutcome } from "./canonical-candidate-resolver";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/config/env", () => ({ env: { GITHUB_TOKEN: undefined } }));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = "user-uuid-1";
const INVOCATION_ID = "invocation-uuid-1";
const REJECTION_KEY = Buffer.alloc(32, 0xab);

const PROFILE_DATA: GithubProviderData = {
  fieldId: "field-uuid-1",
  profile: {
    fieldId: "field-uuid-1",
    login: "octocat",
    htmlUrl: "https://github.com/octocat",
    githubId: 583231,
    name: "The Octocat",
    publicRepos: 8,
    followers: 17000,
    createdAt: "2011-01-25T18:44:36Z",
  },
};

const NULL_PROFILE_DATA: GithubProviderData = {
  fieldId: "field-uuid-1",
  profile: null,
};

// ── Dependency factory (mirrors HibpResultWriter test pattern) ─────────────────

function makeDeps(
  overrides: {
    evidenceInsert?: () => Promise<void>;
    preCheck?: () => Promise<"proceed" | "rejected">;
    resolve?: () => Promise<CanonicalResolutionOutcome>;
    rejectionExists?: () => Promise<boolean>;
    encryptResult?: string | (() => Promise<string>);
    getRejectionKey?: () => Promise<Buffer>;
  } = {},
) {
  return {
    evidence: {
      insert: vi.fn().mockImplementation(overrides.evidenceInsert ?? (() => Promise.resolve())),
    },
    resolver: {
      preCheckCanonicalUri: vi
        .fn()
        .mockImplementation(overrides.preCheck ?? (() => Promise.resolve("proceed" as const))),
      resolveCanonicalCandidate: vi.fn().mockImplementation(
        overrides.resolve ??
          (() =>
            Promise.resolve({
              outcome: "created" as const,
              candidateId: "candidate-uuid-1",
            } satisfies CanonicalResolutionOutcome)),
      ),
    },
    rejections: {
      exists: vi
        .fn()
        .mockImplementation(overrides.rejectionExists ?? (() => Promise.resolve(false))),
    },
    encryption: {
      encrypt: vi
        .fn()
        .mockImplementation(
          typeof overrides.encryptResult === "function"
            ? overrides.encryptResult
            : () => Promise.resolve(overrides.encryptResult ?? "encrypted-payload"),
        ),
    },
    rejectionKeys: {
      getRejectionKey: vi
        .fn()
        .mockImplementation(overrides.getRejectionKey ?? (() => Promise.resolve(REJECTION_KEY))),
    },
  };
}

// ── Helper ────────────────────────────────────────────────────────────────────

function makeWriter(deps: ReturnType<typeof makeDeps>): GithubResultWriter {
  return new GithubResultWriter(deps as never);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GithubResultWriter.write", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  // ── Invalid provider data ─────────────────────────────────────────────────

  describe("invalid providerData", () => {
    it("throws GithubResultWriterError when providerData is null", async () => {
      const writer = makeWriter(deps);
      await expect(writer.write(USER_ID, INVOCATION_ID, null)).rejects.toBeInstanceOf(
        GithubResultWriterError,
      );
    });

    it("throws GithubResultWriterError when providerData is missing fieldId", async () => {
      const writer = makeWriter(deps);
      await expect(writer.write(USER_ID, INVOCATION_ID, { profile: null })).rejects.toBeInstanceOf(
        GithubResultWriterError,
      );
    });

    it("throws GithubResultWriterError when providerData is a plain string", async () => {
      const writer = makeWriter(deps);
      await expect(writer.write(USER_ID, INVOCATION_ID, "bad")).rejects.toBeInstanceOf(
        GithubResultWriterError,
      );
    });
  });

  // ── 404 path — null profile ───────────────────────────────────────────────

  describe("null profile (404 — handle has no account)", () => {
    it("writes no evidence when profile is null", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, NULL_PROFILE_DATA);
      expect(deps.evidence.insert).not.toHaveBeenCalled();
    });

    it("creates no candidate when profile is null", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, NULL_PROFILE_DATA);
      expect(deps.resolver.resolveCanonicalCandidate).not.toHaveBeenCalled();
    });

    it("does not call preCheckCanonicalUri when profile is null", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, NULL_PROFILE_DATA);
      expect(deps.resolver.preCheckCanonicalUri).not.toHaveBeenCalled();
    });
  });

  // ── T2: canonical candidate resolved from htmlUrl ─────────────────────────

  describe("T2 — canonical candidate via resolveCanonicalCandidate", () => {
    it("calls resolveCanonicalCandidate with the normalised github.com URI", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      expect(deps.resolver.resolveCanonicalCandidate).toHaveBeenCalledOnce();
      const [calledUserId, calledEvidenceId, calledUri] = deps.resolver.resolveCanonicalCandidate
        .mock.calls[0] as [string, string, string];
      expect(calledUserId).toBe(USER_ID);
      // Must be a non-empty string UUID — exact value comes from generateEvidenceId.
      expect(typeof calledEvidenceId).toBe("string");
      expect(calledEvidenceId.length).toBeGreaterThan(0);
      // normalizeExternalProfileUri lowercases the path for github.com
      expect(calledUri).toBe("https://github.com/octocat");
    });

    it("passes the same evidenceId to evidence insert and resolveCanonicalCandidate", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      const [insertedEvidenceId] = deps.evidence.insert.mock.calls[0] as [string, unknown];
      const [, resolvedEvidenceId] = deps.resolver.resolveCanonicalCandidate.mock.calls[0] as [
        string,
        string,
        string,
      ];
      // The evidenceId must be consistent across insert and resolve (ATL-215).
      expect(insertedEvidenceId).toBe(resolvedEvidenceId);
    });

    it("resolves evidence_added outcome without error (second evidence for same candidate)", async () => {
      const deps2 = makeDeps({
        resolve: () =>
          Promise.resolve({ outcome: "evidence_added", candidateId: "candidate-uuid-1" }),
      });
      const writer = makeWriter(deps2);
      await expect(writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA)).resolves.toBeUndefined();
      expect(deps2.resolver.resolveCanonicalCandidate).toHaveBeenCalledOnce();
    });
  });

  // ── T3: evidence insert parameters ───────────────────────────────────────

  describe("T3 — evidence insert is idempotent on the five-part key", () => {
    it("inserts evidence with correct providerClass and fieldId", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      expect(deps.evidence.insert).toHaveBeenCalledOnce();
      const [, row] = deps.evidence.insert.mock.calls[0] as [string, Record<string, unknown>];
      expect(row["providerClass"]).toBe(GITHUB_PROVIDER_CLASS);
      expect(row["fieldId"]).toBe("field-uuid-1");
      expect(row["userId"]).toBe(USER_ID);
      expect(row["invocationId"]).toBe(INVOCATION_ID);
    });

    it("uses lowercased login as sourceIdentifier", async () => {
      const data: GithubProviderData = {
        ...PROFILE_DATA,
        profile: { ...PROFILE_DATA.profile!, login: "Octocat" },
      };
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, data);

      const [, row] = deps.evidence.insert.mock.calls[0] as [string, Record<string, unknown>];
      expect(row["sourceIdentifier"]).toBe("octocat");
    });

    it("sets isAggregatorAttributed to false", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);
      const [, row] = deps.evidence.insert.mock.calls[0] as [string, Record<string, unknown>];
      expect(row["isAggregatorAttributed"]).toBe(false);
    });

    it("uses pre-generated evidenceId for AAD binding", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      const [evidenceId] = deps.evidence.insert.mock.calls[0] as [string, unknown];
      expect(typeof evidenceId).toBe("string");
      expect(evidenceId.length).toBeGreaterThan(0);

      // The same UUID must be used in the encryption AAD so the key is bound
      // to the row before the insert round-trip (ADR-008 §7).
      const [, , aad] = deps.encryption.encrypt.mock.calls[0] as [
        string,
        string,
        { table: string; column: string; recordId: string },
      ];
      expect(aad.recordId).toBe(evidenceId);
    });
  });

  // ── T4: dismissed candidate transitions to pending ────────────────────────

  describe("T4 — dismissed candidate reopens on new evidence", () => {
    it("calls resolveCanonicalCandidate with dismissed_reopened outcome path", async () => {
      const deps4 = makeDeps({
        resolve: () =>
          Promise.resolve({ outcome: "dismissed_reopened", candidateId: "c-reopened" }),
      });
      const writer = makeWriter(deps4);
      await expect(writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA)).resolves.toBeUndefined();
      expect(deps4.resolver.resolveCanonicalCandidate).toHaveBeenCalledOnce();
    });
  });

  // ── T5: rejected candidate — evidence only, no candidate mutation ─────────

  describe("T5 — rejected candidate suppression", () => {
    it("skips evidence and candidate when preCheckCanonicalUri returns rejected", async () => {
      const deps5 = makeDeps({ preCheck: () => Promise.resolve("rejected") });
      const writer = makeWriter(deps5);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      expect(deps5.evidence.insert).not.toHaveBeenCalled();
      expect(deps5.resolver.resolveCanonicalCandidate).not.toHaveBeenCalled();
    });

    it("writes evidence for provenance but suppresses candidate when fingerprint matches", async () => {
      const deps5 = makeDeps({ rejectionExists: () => Promise.resolve(true) });
      const writer = makeWriter(deps5);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      expect(deps5.evidence.insert).toHaveBeenCalledOnce();
      expect(deps5.resolver.resolveCanonicalCandidate).not.toHaveBeenCalled();
    });

    it("suppresses candidate when key_destroyed error occurs (fail-closed)", async () => {
      const deps5 = makeDeps({
        getRejectionKey: () => Promise.reject(new CryptoError("key_destroyed")),
      });
      const writer = makeWriter(deps5);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      expect(deps5.evidence.insert).toHaveBeenCalledOnce();
      expect(deps5.resolver.resolveCanonicalCandidate).not.toHaveBeenCalled();
    });

    it("proceeds without rejection check when key_unavailable (no rejections exist)", async () => {
      const deps5 = makeDeps({
        getRejectionKey: () => Promise.reject(new CryptoError("key_unavailable")),
      });
      const writer = makeWriter(deps5);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      expect(deps5.resolver.resolveCanonicalCandidate).toHaveBeenCalledOnce();
    });
  });

  // ── T6: rate-limit and error paths are handled by the dispatch engine ──────
  // (The writer is only called on outcome: "success" — no writer-level test needed.)

  // ── T7: no user field value in any unencrypted output ────────────────────

  describe("T7 — no user field value in unencrypted output", () => {
    it("does not include the user's handle in evidenceSummary", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      const [, row] = deps.evidence.insert.mock.calls[0] as [string, Record<string, unknown>];
      // evidenceSummary must not be the handle the user typed into Atlas
      expect(row["evidenceSummary"]).not.toContain("octocat");
    });

    it("encrypted evidence JSON contains profile metadata fields", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      const [, plaintext] = deps.encryption.encrypt.mock.calls[0] as [string, string, unknown];
      const parsed: unknown = JSON.parse(plaintext);
      expect(parsed).toHaveProperty("github_id");
      expect(parsed).toHaveProperty("login");
      expect(parsed).toHaveProperty("public_repos");
    });

    it("encryption AAD references discovery_evidence table and column", async () => {
      const writer = makeWriter(deps);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      const [, , aad] = deps.encryption.encrypt.mock.calls[0] as [
        string,
        string,
        { table: string; column: string; recordId: string },
      ];
      expect(aad.table).toBe("discovery_evidence");
      expect(aad.column).toBe("provider_evidence_json");
    });

    it("preCheckCanonicalUri is called before evidence insert", async () => {
      let preCheckCalled = false;
      let evidenceCalledBeforePreCheck = false;

      const orderedDeps = makeDeps({
        preCheck: () => {
          preCheckCalled = true;
          return Promise.resolve("proceed" as const);
        },
        evidenceInsert: () => {
          if (!preCheckCalled) evidenceCalledBeforePreCheck = true;
          return Promise.resolve();
        },
      });
      const writer = makeWriter(orderedDeps);
      await writer.write(USER_ID, INVOCATION_ID, PROFILE_DATA);

      expect(preCheckCalled).toBe(true);
      expect(evidenceCalledBeforePreCheck).toBe(false);
    });
  });
});
