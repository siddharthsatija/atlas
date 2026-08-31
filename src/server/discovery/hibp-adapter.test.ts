import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryEligibleField } from "@/server/personal-fields/personal-field-service";
import { HibpAdapter } from "./hibp-adapter";
import type { HibpBreachMatch } from "./hibp-adapter";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));
vi.mock("@/config/env", () => ({
  env: { HIBP_API_KEY: "test-api-key" },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_API_KEY = "ci-hibp-placeholder";

const EMAIL_FIELD: DiscoveryEligibleField = {
  id: "field-uuid-1",
  userId: "user-uuid-1",
  fieldKey: "email",
  value: "alice@example.com",
};

/** Computes the expected SHA-1 hash for a normalised email. */
function expectedHash(email: string): string {
  return createHash("sha1").update(email.trim().toLowerCase()).digest("hex").toUpperCase();
}

/** Returns a 6-char uppercase prefix and the remainder suffix for an email. */
function hashParts(email: string): { prefix: string; suffix: string } {
  const h = expectedHash(email);
  return { prefix: h.slice(0, 6), suffix: h.slice(6) };
}

const CATALOGUE_ENTRY: Record<string, unknown> = {
  Name: "Adobe",
  Title: "Adobe",
  BreachDate: "2013-10-04",
  DataClasses: ["Email addresses", "Passwords"],
  IsVerified: true,
  PwnCount: 152445165,
  IsSpamList: false,
};

const SPAM_CATALOGUE_ENTRY: Record<string, unknown> = {
  ...CATALOGUE_ENTRY,
  Name: "SpamHaus",
  Title: "SpamHaus",
  IsSpamList: true,
};

function makeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("HibpAdapter", () => {
  let adapter: HibpAdapter;

  beforeEach(() => {
    adapter = new HibpAdapter(TEST_API_KEY);
    vi.stubGlobal("fetch", vi.fn());
  });

  // ── Static properties ──────────────────────────────────────────────────────

  describe("static properties", () => {
    it("has providerClass discovery_hashed_query", () => {
      expect(adapter.providerClass).toBe("discovery_hashed_query");
    });

    it("has consentType discovery_hashed_query", () => {
      expect(adapter.consentType).toBe("discovery_hashed_query");
    });

    it("has disclosureClass hashed_query", () => {
      expect(adapter.disclosureClass).toBe("hashed_query");
    });

    it("has disclosureContractVersion v1", () => {
      expect(adapter.disclosureContractVersion).toBe("v1");
    });

    it("lists email as the only eligible field type", () => {
      expect(adapter.eligibleFieldTypes.has("email")).toBe(true);
      expect(adapter.eligibleFieldTypes.size).toBe(1);
    });
  });

  // ── No email field ─────────────────────────────────────────────────────────

  describe("query with no email field", () => {
    it("returns error when no email field is present", async () => {
      const result = await adapter.query([]);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorCode).toBe("hibp.no_email_field");
      }
    });
  });

  // ── k-anonymity normalisation ──────────────────────────────────────────────

  describe("k-anonymity normalisation", () => {
    it("trims whitespace from the email before hashing", async () => {
      const { prefix: trimmedPrefix } = hashParts("alice@example.com");
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, [])); // range returns no match
      await adapter.query([{ ...EMAIL_FIELD, value: "  alice@example.com  " }]);
      const url = vi.mocked(fetch).mock.calls[0]?.[0] as string;
      expect(url.toUpperCase()).toContain(trimmedPrefix);
    });

    it("lowercases the email before hashing", async () => {
      const { prefix: lowerPrefix } = hashParts("alice@example.com");
      vi.mocked(fetch).mockResolvedValue(makeResponse(200, []));
      await adapter.query([{ ...EMAIL_FIELD, value: "ALICE@EXAMPLE.COM" }]);
      const url = vi.mocked(fetch).mock.calls[0]?.[0] as string;
      expect(url.toUpperCase()).toContain(lowerPrefix);
    });

    it("produces the same prefix regardless of email case", async () => {
      vi.mocked(fetch).mockResolvedValue(makeResponse(200, []));
      await adapter.query([{ ...EMAIL_FIELD, value: "ALICE@EXAMPLE.COM" }]);
      const upperUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
      vi.mocked(fetch).mockClear();
      vi.mocked(fetch).mockResolvedValue(makeResponse(200, []));
      await adapter.query([{ ...EMAIL_FIELD, value: "alice@example.com" }]);
      const lowerUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
      expect(upperUrl).toBe(lowerUrl);
    });

    it("sends exactly a 6-character prefix in the URL", async () => {
      vi.mocked(fetch).mockResolvedValue(makeResponse(200, []));
      await adapter.query([EMAIL_FIELD]);
      const url = vi.mocked(fetch).mock.calls[0]?.[0] as string;
      const prefix = url.split("/").pop() ?? "";
      expect(prefix).toHaveLength(6);
      expect(/^[0-9a-f]{6}$/i.test(prefix)).toBe(true);
    });

    it("does not include the full hash or suffix in the outbound URL", async () => {
      vi.mocked(fetch).mockResolvedValue(makeResponse(200, []));
      await adapter.query([EMAIL_FIELD]);
      const url = vi.mocked(fetch).mock.calls[0]?.[0] as string;
      const { suffix } = hashParts("alice@example.com");
      // The URL path segment must be only the 6-char prefix, never the full hash.
      expect(url).not.toContain(suffix);
    });
  });

  // ── Range request headers ──────────────────────────────────────────────────

  describe("range request headers", () => {
    it("sends hibp-api-key header on the range request", async () => {
      vi.mocked(fetch).mockResolvedValue(makeResponse(200, []));
      await adapter.query([EMAIL_FIELD]);
      const [, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["hibp-api-key"]).toBe(TEST_API_KEY);
    });

    it("sends user-agent header on the range request", async () => {
      vi.mocked(fetch).mockResolvedValue(makeResponse(200, []));
      await adapter.query([EMAIL_FIELD]);
      const [, options] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["user-agent"]).toBe("Atlas-Discovery/1.0");
    });
  });

  // ── Suffix matching ────────────────────────────────────────────────────────

  describe("suffix matching", () => {
    it("discards non-matching entries and returns no breaches", async () => {
      const rangeEntries = [{ hashSuffix: "AABBCCDDEE", websites: ["SomeOtherBreach"] }];
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, rangeEntries));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as { breaches: unknown[] };
        expect(data.breaches).toHaveLength(0);
      }
      // Catalogue must not be called for non-matching entry.
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it("returns success with empty breaches when no suffix matches", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, []));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as { fieldId: string; breaches: unknown[] };
        expect(data.fieldId).toBe(EMAIL_FIELD.id);
        expect(data.breaches).toHaveLength(0);
      }
    });

    it("calls catalogue enrichment only for the matched entry's websites", async () => {
      const { suffix } = hashParts("alice@example.com");
      const rangeEntries = [
        { hashSuffix: "AABBCCDDEE", websites: ["SkippedBreach"] }, // no match
        { hashSuffix: suffix, websites: ["Adobe"] }, // match
      ];
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse(200, rangeEntries)) // range
        .mockResolvedValueOnce(makeResponse(200, CATALOGUE_ENTRY)); // catalogue for Adobe
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("success");
      // Only 2 fetch calls: range + catalogue for "Adobe" (not "SkippedBreach").
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      const catalogueUrl = vi.mocked(fetch).mock.calls[1]?.[0] as string;
      expect(catalogueUrl).toContain("/breach/Adobe");
      expect(catalogueUrl).not.toContain("SkippedBreach");
    });
  });

  // ── Catalogue request ──────────────────────────────────────────────────────

  describe("catalogue request", () => {
    async function queryWithMatch(): Promise<void> {
      const { suffix } = hashParts("alice@example.com");
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse(200, [{ hashSuffix: suffix, websites: ["Adobe"] }]))
        .mockResolvedValueOnce(makeResponse(200, CATALOGUE_ENTRY));
      await adapter.query([EMAIL_FIELD]);
    }

    it("does not send hibp-api-key on the catalogue request", async () => {
      await queryWithMatch();
      const [, options] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["hibp-api-key"]).toBeUndefined();
    });

    it("sends user-agent on the catalogue request", async () => {
      await queryWithMatch();
      const [, options] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers["user-agent"]).toBe("Atlas-Discovery/1.0");
    });

    it("does not include user email or hash in the catalogue request URL", async () => {
      await queryWithMatch();
      const url = vi.mocked(fetch).mock.calls[1]?.[0] as string;
      const fullHash = expectedHash("alice@example.com");
      expect(url).not.toContain("alice");
      expect(url).not.toContain("example.com");
      expect(url).not.toContain(fullHash);
    });

    it("returns IsSpamList=true in breach when catalogue returns IsSpamList=true", async () => {
      const { suffix } = hashParts("alice@example.com");
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse(200, [{ hashSuffix: suffix, websites: ["SpamHaus"] }]))
        .mockResolvedValueOnce(makeResponse(200, SPAM_CATALOGUE_ENTRY));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as { breaches: HibpBreachMatch[] };
        expect(data.breaches[0]?.isSpamList).toBe(true);
      }
    });

    it("defaults isSpamList to false when catalogue omits IsSpamList", async () => {
      const { suffix } = hashParts("alice@example.com");
      const entryWithoutSpamList = { ...CATALOGUE_ENTRY };
      delete (entryWithoutSpamList as Record<string, unknown>).IsSpamList;
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse(200, [{ hashSuffix: suffix, websites: ["Adobe"] }]))
        .mockResolvedValueOnce(makeResponse(200, entryWithoutSpamList));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as { breaches: HibpBreachMatch[] };
        expect(data.breaches[0]?.isSpamList).toBe(false);
      }
    });

    it("skips a breach and continues when catalogue response is malformed", async () => {
      const { suffix } = hashParts("alice@example.com");
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          makeResponse(200, [{ hashSuffix: suffix, websites: ["Malformed", "Adobe"] }]),
        )
        .mockResolvedValueOnce(makeResponse(200, { bad: "shape" })) // malformed
        .mockResolvedValueOnce(makeResponse(200, CATALOGUE_ENTRY)); // second succeeds
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as { breaches: HibpBreachMatch[] };
        // First breach skipped, second succeeds.
        expect(data.breaches).toHaveLength(1);
        expect(data.breaches[0]?.Name).toBe("Adobe");
      }
    });

    it("skips a breach and continues when catalogue request fails", async () => {
      const { suffix } = hashParts("alice@example.com");
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          makeResponse(200, [{ hashSuffix: suffix, websites: ["BadBreach", "Adobe"] }]),
        )
        .mockResolvedValueOnce(makeResponse(503)) // catalogue failure
        .mockResolvedValueOnce(makeResponse(200, CATALOGUE_ENTRY));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as { breaches: HibpBreachMatch[] };
        expect(data.breaches).toHaveLength(1);
        expect(data.breaches[0]?.Name).toBe("Adobe");
      }
    });
  });

  // ── Range error paths ──────────────────────────────────────────────────────

  describe("range error handling", () => {
    it("returns rate_limited on HTTP 429", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(429));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("rate_limited");
    });

    it("returns error on HTTP 401", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(401));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.errorCode).toBe("hibp.http_401");
    });

    it("returns error on HTTP 403", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(403));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.errorCode).toBe("hibp.http_403");
    });

    it("returns error on HTTP 503", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(503));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.errorCode).toBe("hibp.http_503");
    });

    it("returns error on network failure", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.errorCode).toBe("hibp.network_error");
    });

    it("returns error on request timeout", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new DOMException("timeout", "AbortError"));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.errorCode).toBe("hibp.network_error");
    });

    it("returns error when range response body is not valid JSON", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("bad json")),
      } as unknown as Response);
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.errorCode).toBe("hibp.parse_error");
    });

    it("returns error when range response body is not an array", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, { breaches: [] }));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.errorCode).toBe("hibp.unexpected_shape");
    });
  });

  // ── Full success path ──────────────────────────────────────────────────────

  describe("full success path", () => {
    it("returns fieldId in success data", async () => {
      const { suffix } = hashParts("alice@example.com");
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse(200, [{ hashSuffix: suffix, websites: ["Adobe"] }]))
        .mockResolvedValueOnce(makeResponse(200, CATALOGUE_ENTRY));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as { fieldId: string };
        expect(data.fieldId).toBe(EMAIL_FIELD.id);
      }
    });

    it("returns correct breach metadata from the catalogue", async () => {
      const { suffix } = hashParts("alice@example.com");
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeResponse(200, [{ hashSuffix: suffix, websites: ["Adobe"] }]))
        .mockResolvedValueOnce(makeResponse(200, CATALOGUE_ENTRY));
      const result = await adapter.query([EMAIL_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as { breaches: HibpBreachMatch[] };
        const breach = data.breaches[0];
        expect(breach?.Name).toBe("Adobe");
        expect(breach?.Title).toBe("Adobe");
        expect(breach?.BreachDate).toBe("2013-10-04");
        expect(breach?.IsVerified).toBe(true);
        expect(breach?.PwnCount).toBe(152445165);
        expect(breach?.isSpamList).toBe(false);
      }
    });
  });
});
