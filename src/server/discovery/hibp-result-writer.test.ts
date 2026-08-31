import { beforeEach, describe, expect, it, vi } from "vitest";
import { CryptoError } from "@/server/crypto/envelope";
import type { HibpBreachMatch, HibpProviderData } from "./hibp-adapter";
import { HibpResultWriter, HibpResultWriterError } from "./hibp-result-writer";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 7).toString("base64") },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REJECTION_KEY = Buffer.alloc(32, 0xab);

const BREACH: HibpBreachMatch = {
  Name: "Adobe",
  Title: "Adobe",
  BreachDate: "2013-10-04",
  DataClasses: ["Email addresses", "Passwords"],
  IsVerified: true,
  PwnCount: 152445165,
  isSpamList: false,
};

/** Spam-list breach: non-service-corpus gate (ADR-007 §12). */
const SPAM_LIST_BREACH: HibpBreachMatch = {
  ...BREACH,
  Name: "SpamHaus",
  Title: "SpamHaus",
  isSpamList: true,
};

const VALID_DATA: HibpProviderData = {
  fieldId: "field-uuid-1",
  breaches: [BREACH],
};

// ── Dependency factories ───────────────────────────────────────────────────────

function makeDeps(
  overrides: {
    evidenceInsert?: () => Promise<void>;
    candidateInsert?: () => Promise<void>;
    rejectionExists?: () => Promise<boolean>;
    encryptResult?: string | (() => Promise<string>);
    getRejectionKey?: () => Promise<Buffer>;
  } = {},
) {
  return {
    evidence: {
      insert: vi.fn().mockImplementation(overrides.evidenceInsert ?? (() => Promise.resolve())),
    },
    candidates: {
      insert: vi.fn().mockImplementation(overrides.candidateInsert ?? (() => Promise.resolve())),
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
            : () => Promise.resolve(overrides.encryptResult ?? "encrypted-json"),
        ),
    },
    rejectionKeys: {
      getRejectionKey: vi
        .fn()
        .mockImplementation(overrides.getRejectionKey ?? (() => Promise.resolve(REJECTION_KEY))),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("HibpResultWriter.write", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  describe("invalid providerData", () => {
    it("throws HibpResultWriterError when providerData is null", async () => {
      const writer = new HibpResultWriter(deps as never);
      await expect(writer.write("user-1", "inv-1", null)).rejects.toBeInstanceOf(
        HibpResultWriterError,
      );
    });

    it("throws HibpResultWriterError when providerData has no fieldId", async () => {
      const writer = new HibpResultWriter(deps as never);
      const bad = { breaches: [BREACH] };
      await expect(writer.write("user-1", "inv-1", bad)).rejects.toBeInstanceOf(
        HibpResultWriterError,
      );
    });

    it("throws HibpResultWriterError when breaches is not an array", async () => {
      const writer = new HibpResultWriter(deps as never);
      const bad = { fieldId: "f", breaches: "not-array" };
      await expect(writer.write("user-1", "inv-1", bad)).rejects.toBeInstanceOf(
        HibpResultWriterError,
      );
    });

    it("throws HibpResultWriterError when providerData is a non-object primitive", async () => {
      const writer = new HibpResultWriter(deps as never);
      await expect(writer.write("user-1", "inv-1", "not-an-object")).rejects.toBeInstanceOf(
        HibpResultWriterError,
      );
    });

    it("throws HibpResultWriterError when a breach item is null", async () => {
      const writer = new HibpResultWriter(deps as never);
      const bad = { fieldId: "f", breaches: [null] };
      await expect(writer.write("user-1", "inv-1", bad)).rejects.toBeInstanceOf(
        HibpResultWriterError,
      );
    });

    it("throws HibpResultWriterError when a breach item has a non-string Name", async () => {
      const writer = new HibpResultWriter(deps as never);
      const bad = { fieldId: "f", breaches: [{ ...BREACH, Name: 123 }] };
      await expect(writer.write("user-1", "inv-1", bad)).rejects.toBeInstanceOf(
        HibpResultWriterError,
      );
    });

    it("throws HibpResultWriterError when a breach item has a non-array DataClasses", async () => {
      const writer = new HibpResultWriter(deps as never);
      const bad = { fieldId: "f", breaches: [{ ...BREACH, DataClasses: "email" }] };
      await expect(writer.write("user-1", "inv-1", bad)).rejects.toBeInstanceOf(
        HibpResultWriterError,
      );
    });

    it("throws HibpResultWriterError when a breach item has a non-number PwnCount", async () => {
      const writer = new HibpResultWriter(deps as never);
      const bad = { fieldId: "f", breaches: [{ ...BREACH, PwnCount: "lots" }] };
      await expect(writer.write("user-1", "inv-1", bad)).rejects.toBeInstanceOf(
        HibpResultWriterError,
      );
    });

    it("throws HibpResultWriterError when a breach item has a non-boolean isSpamList", async () => {
      const writer = new HibpResultWriter(deps as never);
      const bad = { fieldId: "f", breaches: [{ ...BREACH, isSpamList: 1 }] };
      await expect(writer.write("user-1", "inv-1", bad)).rejects.toBeInstanceOf(
        HibpResultWriterError,
      );
    });
  });

  describe("non-spam-list breach, no existing rejection", () => {
    it("inserts evidence with correct fields", async () => {
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", VALID_DATA);
      expect(deps.evidence.insert).toHaveBeenCalledOnce();
      const [, row] = deps.evidence.insert.mock.calls[0] as [string, Record<string, unknown>];
      expect(row.providerClass).toBe("discovery_hashed_query");
      expect(row.fieldId).toBe("field-uuid-1");
      expect(row.sourceIdentifier).toBe("adobe");
      expect(row.evidenceType).toBe("hibp_breach");
      expect(row.evidenceSummary).toBe("Adobe");
    });

    it("always sets isAggregatorAttributed to false (ADR-007 §12)", async () => {
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", VALID_DATA);
      const [, row] = deps.evidence.insert.mock.calls[0] as [string, Record<string, unknown>];
      expect(row.isAggregatorAttributed).toBe(false);
    });

    it("inserts a candidate for a non-spam-list non-rejected breach", async () => {
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", VALID_DATA);
      expect(deps.candidates.insert).toHaveBeenCalledOnce();
      expect(deps.candidates.insert).toHaveBeenCalledWith("user-1", expect.any(String));
    });

    it("encrypts the evidence JSON before inserting", async () => {
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", VALID_DATA);
      expect(deps.encryption.encrypt).toHaveBeenCalledOnce();
      const [userId, plaintext] = deps.encryption.encrypt.mock.calls[0] as [string, string];
      expect(userId).toBe("user-1");
      const parsed = JSON.parse(plaintext) as Record<string, unknown>;
      expect(parsed.breach_date).toBe("2013-10-04");
      expect(parsed.pwn_count).toBe(152445165);
      expect(parsed.is_verified).toBe(true);
    });

    it("does not include breach name in the encrypted evidence JSON", async () => {
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", VALID_DATA);
      const plaintext = deps.encryption.encrypt.mock.calls[0]?.[1] as string;
      expect(plaintext).not.toContain("Adobe");
    });

    it("does not include isSpamList in the encrypted evidence JSON", async () => {
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", VALID_DATA);
      const plaintext = deps.encryption.encrypt.mock.calls[0]?.[1] as string;
      expect(plaintext).not.toContain("isSpamList");
      expect(plaintext).not.toContain("IsSpamList");
    });
  });

  describe("spam-list breach — non-service-corpus gate (ADR-007 §12)", () => {
    it("inserts evidence for a spam-list breach", async () => {
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", { fieldId: "f", breaches: [SPAM_LIST_BREACH] });
      expect(deps.evidence.insert).toHaveBeenCalledOnce();
    });

    it("does not insert a candidate for a spam-list breach", async () => {
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", { fieldId: "f", breaches: [SPAM_LIST_BREACH] });
      expect(deps.candidates.insert).not.toHaveBeenCalled();
    });

    it("does not check the rejection fingerprint for a spam-list breach", async () => {
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", { fieldId: "f", breaches: [SPAM_LIST_BREACH] });
      expect(deps.rejections.exists).not.toHaveBeenCalled();
    });

    it("sets isAggregatorAttributed to false even for a spam-list breach", async () => {
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", { fieldId: "f", breaches: [SPAM_LIST_BREACH] });
      const [, row] = deps.evidence.insert.mock.calls[0] as [string, Record<string, unknown>];
      // isSpamList MUST NOT be mapped to isAggregatorAttributed (ADR-007 §12).
      expect(row.isAggregatorAttributed).toBe(false);
    });
  });

  describe("rejection key: key_unavailable (no rejections exist)", () => {
    it("still inserts candidate when key_unavailable", async () => {
      deps = makeDeps({
        getRejectionKey: () => Promise.reject(new CryptoError("key_unavailable")),
      });
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", VALID_DATA);
      expect(deps.candidates.insert).toHaveBeenCalledOnce();
    });
  });

  describe("rejection key: key_destroyed (fail closed)", () => {
    it("skips candidate for all breaches when key_destroyed", async () => {
      deps = makeDeps({
        getRejectionKey: () => Promise.reject(new CryptoError("key_destroyed")),
      });
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", {
        fieldId: "f",
        breaches: [BREACH, { ...BREACH, Name: "B2", isSpamList: false }],
      });
      expect(deps.evidence.insert).toHaveBeenCalledTimes(2);
      expect(deps.candidates.insert).not.toHaveBeenCalled();
    });
  });

  describe("rejected fingerprint", () => {
    it("does not insert candidate when rejection fingerprint exists", async () => {
      deps = makeDeps({ rejectionExists: () => Promise.resolve(true) });
      const writer = new HibpResultWriter(deps as never);
      await writer.write("user-1", "inv-1", VALID_DATA);
      expect(deps.evidence.insert).toHaveBeenCalledOnce();
      expect(deps.candidates.insert).not.toHaveBeenCalled();
    });
  });

  describe("catalogue failure isolation (per-breach error handling)", () => {
    it("skips breach when evidence encryption fails, continues to next", async () => {
      let callCount = 0;
      deps = makeDeps({
        encryptResult: () => {
          callCount++;
          if (callCount === 1) return Promise.reject(new Error("encrypt failed"));
          return Promise.resolve("encrypted");
        },
      });
      const writer = new HibpResultWriter(deps as never);
      const second = { ...BREACH, Name: "B2", Title: "B2" };
      await writer.write("user-1", "inv-1", { fieldId: "f", breaches: [BREACH, second] });
      // First breach skipped, second succeeds.
      expect(deps.evidence.insert).toHaveBeenCalledOnce();
    });

    it("skips breach when evidence insert fails, continues to next", async () => {
      let callCount = 0;
      deps = makeDeps({
        evidenceInsert: () => {
          callCount++;
          if (callCount === 1) return Promise.reject(new Error("db error"));
          return Promise.resolve();
        },
      });
      const writer = new HibpResultWriter(deps as never);
      const second = { ...BREACH, Name: "B2", Title: "B2" };
      await writer.write("user-1", "inv-1", { fieldId: "f", breaches: [BREACH, second] });
      expect(deps.evidence.insert).toHaveBeenCalledTimes(2);
      // Only the second breach's evidence succeeded, so only one candidate.
      expect(deps.candidates.insert).toHaveBeenCalledOnce();
    });

    it("skips a breach when the rejection check throws, continues to the next", async () => {
      let callCount = 0;
      deps = makeDeps({
        rejectionExists: () => {
          callCount++;
          if (callCount === 1) return Promise.reject(new Error("rejection db error"));
          return Promise.resolve(false);
        },
      });
      const writer = new HibpResultWriter(deps as never);
      const second = { ...BREACH, Name: "B2", Title: "B2" };
      await writer.write("user-1", "inv-1", { fieldId: "f", breaches: [BREACH, second] });
      // First breach fails at rejection check and is skipped; second succeeds.
      expect(deps.candidates.insert).toHaveBeenCalledOnce();
    });

    it("resolves for an empty breaches array", async () => {
      const writer = new HibpResultWriter(deps as never);
      await expect(
        writer.write("user-1", "inv-1", { fieldId: "f", breaches: [] }),
      ).resolves.toBeUndefined();
      expect(deps.evidence.insert).not.toHaveBeenCalled();
      expect(deps.candidates.insert).not.toHaveBeenCalled();
    });
  });
});
