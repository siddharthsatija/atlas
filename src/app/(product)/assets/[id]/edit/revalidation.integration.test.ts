import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ATL-033 — which routes an edit invalidates.
 *
 * This exists because of a defect a browser found and no unit test could: a
 * Playwright trace showed "Mark as reviewed" posting to `/assets/{id}/edit`,
 * returning `200` with `x-action-revalidated: 1`, and the router refetching only
 * `/assets/{id}` — the single path the action invalidated. The write had
 * succeeded and the page the user was looking at kept saying "Never reviewed."
 *
 * The three actions submitted from the edit page must invalidate **both** routes
 * that read the mutated data. Asserting it here rather than only in the browser
 * means the next action added to this module fails fast if it forgets one.
 *
 * The service is mocked deliberately: what is under test is the cache contract
 * of the action layer, not the mutation, which
 * `asset-edit.integration.test.ts` covers against the real service.
 */

const revalidatePath = vi.fn<(path: string) => void>();
const updateAsset = vi.fn().mockResolvedValue({ ok: true, data: {} });
const markReviewed = vi.fn().mockResolvedValue({ ok: true, data: {} });
const setAssetStatus = vi.fn().mockResolvedValue({ ok: true, data: {} });
const addDataCategory = vi.fn().mockResolvedValue({ ok: true, data: {} });
const addPermission = vi.fn().mockResolvedValue({ ok: true, data: {} });
const setPermissionStatus = vi.fn().mockResolvedValue({ ok: true, data: {} });
const removeDataCategory = vi.fn().mockResolvedValue({ ok: true, data: {} });
const removePermission = vi.fn().mockResolvedValue({ ok: true, data: {} });

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new Error(`REDIRECT:${target}`);
  },
}));

vi.mock("@/server/auth/require-user", () => ({
  requireVerifiedUser: () => Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
}));

vi.mock("@/server/assets/asset-service", () => ({
  AssetService: {
    create: () => ({
      updateAsset,
      markReviewed,
      setAssetStatus,
      addDataCategory,
      removeDataCategory,
      addPermission,
      setPermissionStatus,
      removePermission,
    }),
  },
}));

const { markReviewedAction, setAssetStatusAction, editAssetChildrenAction } =
  await import("./actions");

const ASSET_ID = "22222222-2222-4222-8222-222222222222";

const form = (entries: Record<string, string>): FormData => {
  const data = new FormData();
  data.set("assetId", ASSET_ID);
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};

const paths = () => revalidatePath.mock.calls.map(([path]) => path);

/** The three button-only actions take a previous state since ATL-112. */
const IDLE = { failure: null, attempt: 0 } as const;

beforeEach(() => {
  /**
   * Every double, not just `revalidatePath`.
   *
   * ATL-112 added assertions on whether a service method was called at all, and
   * those are only meaningful if a previous test's calls are gone. Clearing one
   * mock and leaving eight was fine while nothing asserted on them; it silently
   * would not be now.
   */
  vi.clearAllMocks();
});

describe("every action submitted from the edit page", () => {
  it.each([
    ["marking reviewed", () => markReviewedAction(IDLE, form({}))],
    ["a status change", () => setAssetStatusAction(IDLE, form({ status: "inactive" }))],
    [
      "adding a category",
      () => editAssetChildrenAction(IDLE, form({ intent: "add-category", category: "contact" })),
    ],
    [
      "removing a category",
      () => editAssetChildrenAction(IDLE, form({ intent: "remove-category", categoryId: "abc" })),
    ],
    [
      "adding a permission",
      () =>
        editAssetChildrenAction(
          IDLE,
          form({ intent: "add-permission", permissionType: "account_access", scope: "broad" }),
        ),
    ],
    [
      "revoking a permission",
      () =>
        editAssetChildrenAction(IDLE, form({ intent: "revoke-permission", permissionId: "abc" })),
    ],
    [
      "removing a permission",
      () =>
        editAssetChildrenAction(IDLE, form({ intent: "remove-permission", permissionId: "abc" })),
    ],
  ])("invalidates the page it was submitted from: %s", async (_label, run) => {
    await run();

    expect(paths()).toContain(`/assets/${ASSET_ID}/edit`);
  });

  it.each([
    ["marking reviewed", () => markReviewedAction(IDLE, form({}))],
    ["a status change", () => setAssetStatusAction(IDLE, form({ status: "removed" }))],
    [
      "adding a category",
      () => editAssetChildrenAction(IDLE, form({ intent: "add-category", category: "financial" })),
    ],
  ])("also invalidates the detail page, which reads the same data: %s", async (_label, run) => {
    await run();

    expect(paths()).toContain(`/assets/${ASSET_ID}`);
  });
});

describe("an action that changes nothing (ATL-112)", () => {
  /**
   * The cache contract narrowed here, deliberately.
   *
   * It used to invalidate on every path, including the ones that mutated
   * nothing, on the reasoning that invalidating too much is harmless. It is
   * harmless to the cache — but it is the step that made a failed write look
   * like a completed one: the page refetched, redrew with the old data, and
   * said nothing. Revalidation is now what a *successful* write triggers, which
   * is what makes its absence meaningful.
   */

  it("does not invalidate when the intent is unknown", async () => {
    const state = await editAssetChildrenAction(IDLE, form({ intent: "nonsense" }));

    expect(paths()).toEqual([]);
    expect(state.failure).toBe("rejected");
  });

  it("does not invalidate when the category is not one Atlas knows", async () => {
    const state = await editAssetChildrenAction(
      IDLE,
      form({ intent: "add-category", category: "not-a-category" }),
    );

    expect(addDataCategory).not.toHaveBeenCalled();
    expect(paths()).toEqual([]);
    expect(state.failure).toBe("rejected");
  });

  it("does not invalidate when the status is not one this form may set", async () => {
    // `archived` is ATL-036's, with its undo affordance and its own copy.
    const state = await setAssetStatusAction(IDLE, form({ status: "archived" }));

    expect(setAssetStatus).not.toHaveBeenCalled();
    expect(paths()).toEqual([]);
    expect(state.failure).toBe("rejected");
  });
});

describe("a write that failed (ATL-112)", () => {
  /**
   * The defect this ticket exists for. Every one of these actions awaited an
   * `AssetResult` and dropped it, then revalidated regardless — so a user who
   * clicked "Mark as reviewed" during a database fault saw the page redraw
   * unchanged with no way to know the review was never recorded.
   *
   * `last_verified_at` is not cosmetic: it feeds R-001 and ADR-004's freshness
   * factor, so silent failure left the engine and the score reasoning about a
   * date the user believed they had updated.
   */

  it("reports the failure instead of returning quietly", async () => {
    markReviewed.mockResolvedValueOnce({ ok: false, code: "UNAVAILABLE" });

    expect((await markReviewedAction(IDLE, form({}))).failure).toBe("unavailable");
  });

  it("does not invalidate the cache for a write that did not happen", async () => {
    markReviewed.mockResolvedValueOnce({ ok: false, code: "UNAVAILABLE" });

    await markReviewedAction(IDLE, form({}));

    expect(paths()).toEqual([]);
  });

  it("distinguishes an asset that is gone from a backend fault", async () => {
    // Different copy, because they are different situations: one is worth
    // retrying and the other never will be.
    markReviewed.mockResolvedValueOnce({ ok: false, code: "NOT_FOUND" });

    expect((await markReviewedAction(IDLE, form({}))).failure).toBe("not_found");
  });

  it("counts the attempt, so a repeated identical failure is announced again", async () => {
    markReviewed.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const first = await markReviewedAction(IDLE, form({}));
    const second = await markReviewedAction(first, form({}));

    expect([first.attempt, second.attempt]).toEqual([1, 2]);
    markReviewed.mockResolvedValue({ ok: true, data: {} });
  });

  it.each([
    [
      "a status change",
      () => setAssetStatusAction(IDLE, form({ status: "inactive" })),
      setAssetStatus,
    ],
    [
      "adding a category",
      () => editAssetChildrenAction(IDLE, form({ intent: "add-category", category: "contact" })),
      addDataCategory,
    ],
    [
      "removing a category",
      () => editAssetChildrenAction(IDLE, form({ intent: "remove-category", categoryId: "abc" })),
      removeDataCategory,
    ],
    [
      "adding a permission",
      () =>
        editAssetChildrenAction(
          IDLE,
          form({ intent: "add-permission", permissionType: "account_access", scope: "broad" }),
        ),
      addPermission,
    ],
    [
      "revoking a permission",
      () => editAssetChildrenAction(IDLE, form({ intent: "revoke-permission", permissionId: "a" })),
      setPermissionStatus,
    ],
    [
      "removing a permission",
      () => editAssetChildrenAction(IDLE, form({ intent: "remove-permission", permissionId: "a" })),
      removePermission,
    ],
  ])("is reported for %s too", async (_label, run, mocked) => {
    // The same defect existed in all of them. Fixing one and leaving five is
    // how it gets rediscovered by the next browser run.
    mocked.mockResolvedValueOnce({ ok: false, code: "UNAVAILABLE" });

    const state = await run();

    expect(state.failure).toBe("unavailable");
    expect(paths()).toEqual([]);
  });
});

describe("a write that succeeded (ATL-112)", () => {
  it("reports no failure and invalidates every view that reads the asset", async () => {
    const state = await markReviewedAction(IDLE, form({}));

    expect(state.failure).toBeNull();
    /**
     * `/assets` joined this set in ATL-036 M5, and the assertion is still an
     * exact match rather than a `toContain` — the point of pinning the whole
     * list is that an action cannot quietly start invalidating more or less
     * than it should.
     *
     * It is not archive-specific. The card renders `status` and
     * `lastVerifiedAt`, so marking a service reviewed already changed what the
     * list shows; the list simply was not being invalidated, and reached the
     * user only by luck of navigation. Archiving is what made it visible,
     * because ATL-036 M2 gave the default list a membership rule.
     */
    expect(paths()).toEqual([`/assets/${ASSET_ID}`, `/assets/${ASSET_ID}/edit`, "/assets"]);
  });
});

describe("the metadata save is deliberately different", () => {
  it("redirects to the detail page rather than staying to be re-rendered", async () => {
    /**
     * `saveAssetAction` ends in `redirect`, so the edit page is left rather than
     * updated in place — there is nothing on it to invalidate. It revalidates
     * the detail page and the list instead, which is where the user lands.
     */
    const { saveAssetAction } = await import("./actions");
    const state = { errors: {}, failure: null, values: {}, attempt: 0 };

    await expect(
      saveAssetAction(state, form({ serviceName: "Spotify", category: "entertainment" })),
    ).rejects.toThrow(`REDIRECT:/assets/${ASSET_ID}`);

    expect(paths()).toContain("/assets");
    expect(paths()).not.toContain(`/assets/${ASSET_ID}/edit`);
  });
});
