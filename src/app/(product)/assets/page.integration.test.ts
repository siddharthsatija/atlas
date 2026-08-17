import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ATL-036 M2 — the assets list's opt-in to the archived exclusion.
 *
 * ## Why this file exists
 *
 * A sabotage run flipped this page's `excludeArchived: true` to `false` and
 * **nothing failed**. The query contract was covered, the repository was
 * covered, the empty state was covered — and the one line that actually turns
 * the feature on for users was not. This closes that gap.
 *
 * What is asserted is the query the page hands `listAssets`, captured at the
 * service boundary. The list rendering is covered by `asset-list.test.tsx`;
 * re-asserting it here would duplicate coverage and fail twice for one cause.
 */

const USER = "11111111-1111-4111-8111-111111111111";

const listAssets = vi.fn();

vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 5).toString("base64") },
}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

vi.mock("@/server/auth/require-user", () => ({
  requireVerifiedUser: () => Promise.resolve({ id: USER }),
}));

vi.mock("@/server/assets/asset-service", () => ({
  AssetService: { create: () => ({ listAssets }) },
}));

/** Rendering is not the subject; the query is. */
vi.mock("@/features/assets", () => ({
  AssetFilters: () => null,
  AssetList: () => null,
}));

const { default: AssetsPage } = await import("./page");

type Params = Record<string, string | string[] | undefined>;

async function queryFor(params: Params) {
  await AssetsPage({ searchParams: Promise.resolve(params) });

  const call = listAssets.mock.calls[0];
  expect(call, "the page should have asked the service for a list").toBeDefined();

  return (call as unknown[])[1] as { excludeArchived: boolean; status?: string[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  listAssets.mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
});

describe("the assets list opts in to hiding archived services", () => {
  it("asks for the exclusion when no status is in the URL", async () => {
    const query = await queryFor({});

    expect(query.excludeArchived).toBe(true);
  });

  it("keeps status undefined, so the empty states still mean what they meant", async () => {
    const query = await queryFor({});

    /**
     * The reason ATL-036 used a flag rather than a defaulted status. `page.tsx`
     * derives `isFirstRun` from `isFiltered(query)`, which reads `query.status`
     * — a defaulted status would make every empty list look like a failed
     * filter, including a genuine first run.
     */
    expect(query.status).toBeUndefined();
  });

  it("drops the exclusion when the user selects Archived", async () => {
    const query = await queryFor({ status: "archived" });

    /** The durable path to a restore until ATL-071 builds the Archive page. */
    expect(query.excludeArchived).toBe(false);
    expect(query.status).toEqual(["archived"]);
  });

  it("drops the exclusion for any explicit status", async () => {
    const query = await queryFor({ status: ["active", "inactive"] });

    expect(query.excludeArchived).toBe(false);
    expect(query.status).toEqual(["active", "inactive"]);
  });

  it("keeps the exclusion alongside filters that are not status", async () => {
    const query = await queryFor({ category: "finance", search: "bank" });

    expect(query.excludeArchived).toBe(true);
  });
});
