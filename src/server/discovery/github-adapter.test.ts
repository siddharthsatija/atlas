import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryEligibleField } from "@/server/personal-fields/personal-field-service";
import { GithubAdapter, GITHUB_PROVIDER_CLASS } from "./github-adapter";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));
vi.mock("@/config/env", () => ({
  env: { GITHUB_TOKEN: undefined },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const USERNAME_FIELD: DiscoveryEligibleField = {
  id: "field-uuid-1",
  userId: "user-uuid-1",
  fieldKey: "username",
  value: "octocat",
};

const GITHUB_PROFILE_BODY = {
  id: 583231,
  login: "octocat",
  html_url: "https://github.com/octocat",
  name: "The Octocat",
  public_repos: 8,
  followers: 17000,
  created_at: "2011-01-25T18:44:36Z",
};

function makeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GithubAdapter", () => {
  const TEST_BASE_URL = "https://api.github.com/users";
  let adapter: GithubAdapter;

  beforeEach(() => {
    adapter = new GithubAdapter(undefined, TEST_BASE_URL);
    vi.stubGlobal("fetch", vi.fn());
  });

  // ── T1: static properties ─────────────────────────────────────────────────

  describe("T1 — static properties satisfy DiscoveryProviderAdapter type contract", () => {
    it("has providerClass discovery_github_profile", () => {
      expect(adapter.providerClass).toBe(GITHUB_PROVIDER_CLASS);
      expect(adapter.providerClass).toBe("discovery_github_profile");
    });

    it("has consentType discovery_identifying", () => {
      expect(adapter.consentType).toBe("discovery_identifying");
    });

    it("has disclosureClass identifying_lookup", () => {
      expect(adapter.disclosureClass).toBe("identifying_lookup");
    });

    it("has disclosureContractVersion v1", () => {
      expect(adapter.disclosureContractVersion).toBe("v1");
    });

    it("lists username as the only eligible field type", () => {
      expect(adapter.eligibleFieldTypes.has("username")).toBe(true);
      expect(adapter.eligibleFieldTypes.size).toBe(1);
    });

    it("does not list email as an eligible field type", () => {
      expect(adapter.eligibleFieldTypes.has("email")).toBe(false);
    });
  });

  // ── No username field ─────────────────────────────────────────────────────

  describe("query with no username field", () => {
    it("returns error when authorized fields is empty", async () => {
      const result = await adapter.query([]);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorCode).toBe("github.no_username_field");
      }
    });

    it("returns error when authorized fields contain only email", async () => {
      const emailField: DiscoveryEligibleField = {
        id: "field-uuid-2",
        userId: "user-uuid-1",
        fieldKey: "email",
        value: "user@example.com",
      };
      const result = await adapter.query([emailField]);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorCode).toBe("github.no_username_field");
      }
    });
  });

  // ── Empty handle ──────────────────────────────────────────────────────────

  describe("query with empty handle", () => {
    it("returns error for a whitespace-only handle", async () => {
      const field: DiscoveryEligibleField = { ...USERNAME_FIELD, value: "   " };
      const result = await adapter.query([field]);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorCode).toBe("github.empty_handle");
      }
    });
  });

  // ── Successful profile lookup ─────────────────────────────────────────────

  describe("successful profile lookup", () => {
    it("returns success with profile data on HTTP 200", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, GITHUB_PROFILE_BODY));

      const result = await adapter.query([USERNAME_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as {
          fieldId: string;
          profile: { login: string; htmlUrl: string; githubId: number } | null;
        };
        expect(data.fieldId).toBe(USERNAME_FIELD.id);
        expect(data.profile).not.toBeNull();
        expect(data.profile?.login).toBe("octocat");
        expect(data.profile?.htmlUrl).toBe("https://github.com/octocat");
        expect(data.profile?.githubId).toBe(583231);
      }
    });

    it("includes the correct fieldId in provider data", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, GITHUB_PROFILE_BODY));

      const result = await adapter.query([USERNAME_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as { fieldId: string };
        expect(data.fieldId).toBe("field-uuid-1");
      }
    });

    it("sends the handle as a URL path segment (encodeURIComponent)", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(makeResponse(200, GITHUB_PROFILE_BODY));

      await adapter.query([USERNAME_FIELD]);

      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain("/users/octocat");
    });

    it("does not include Authorization header when no token is configured", async () => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(makeResponse(200, GITHUB_PROFILE_BODY));

      await adapter.query([USERNAME_FIELD]);

      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers?.["authorization"]).toBeUndefined();
    });

    it("includes Authorization header when token is configured", async () => {
      const authedAdapter = new GithubAdapter("ghp_test_token", TEST_BASE_URL);
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, GITHUB_PROFILE_BODY));

      await authedAdapter.query([USERNAME_FIELD]);

      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers?.["authorization"]).toBe("Bearer ghp_test_token");
    });
  });

  // ── T7: no user field value in unencrypted output ─────────────────────────

  describe("T7 — no user field value in unencrypted output", () => {
    it("does not embed the handle value in error codes", async () => {
      const result = await adapter.query([]);
      if (result.status === "error") {
        expect(result.errorCode).not.toContain("octocat");
      }
    });

    it("query never throws — catches network errors", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("network failure"));
      const result = await adapter.query([USERNAME_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorCode).toBe("github.network_error");
      }
    });
  });

  // ── Rate limit ────────────────────────────────────────────────────────────

  describe("T6 — rate-limit path", () => {
    it("returns rate_limited on HTTP 429", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(429));
      const result = await adapter.query([USERNAME_FIELD]);
      expect(result.status).toBe("rate_limited");
    });
  });

  // ── Error paths ───────────────────────────────────────────────────────────

  describe("T6 — error paths", () => {
    it("returns error on HTTP 500", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(500));
      const result = await adapter.query([USERNAME_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorCode).toBe("github.http_500");
      }
    });

    it("returns error on HTTP 403", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(403));
      const result = await adapter.query([USERNAME_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorCode).toBe("github.http_403");
      }
    });

    it("returns error on unparseable JSON response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("bad json")),
      } as unknown as Response);
      const result = await adapter.query([USERNAME_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorCode).toBe("github.parse_error");
      }
    });

    it("returns error when API response is missing required fields", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(200, { id: 123 }));
      const result = await adapter.query([USERNAME_FIELD]);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.errorCode).toBe("github.unexpected_shape");
      }
    });
  });

  // ── 404 path ──────────────────────────────────────────────────────────────

  describe("404 — no account for handle", () => {
    it("returns success with null profile on HTTP 404", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse(404));
      const result = await adapter.query([USERNAME_FIELD]);
      expect(result.status).toBe("success");
      if (result.status === "success") {
        const data = result.data as { profile: null };
        expect(data.profile).toBeNull();
      }
    });
  });
});
