import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetActionState } from "./edit/form-state";

/**
 * ATL-036 M3 — the archive and restore Server Actions.
 *
 * ## What this layer owns, and what it deliberately does not
 *
 * `AssetService.archiveAsset` and `restoreAsset` already have integration
 * coverage: the transition guard, the activity event, the recompute and the
 * score enqueue are all asserted in `asset-service.integration.test.ts` against
 * a real repository. Re-asserting them here would duplicate that and fail twice
 * for one cause.
 *
 * What only exists at this layer is the **action contract**: that the session
 * supplies the user id, that the caller supplies nothing but an asset id, that
 * each action reaches the service method it claims to, and that a service result
 * becomes the right `AssetActionState`.
 *
 * ## Why the side effects are asserted by absence
 *
 * `afterMutation` writes the activity event, enqueues the recompute and enqueues
 * the score recalculation. The action must not do any of that itself — two
 * sources for one event is how a timeline ends up disagreeing with the database.
 * So the service double records what it was asked for and the tests assert the
 * action added nothing.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const ASSET = "44444444-4444-4444-8444-444444444444";

const archiveAsset = vi.fn();
const restoreAsset = vi.fn();
/** Typed, so `mock.calls` yields `string` rather than `any` when read below. */
const revalidatePath = vi.fn<(path: string) => void>();

vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 5).toString("base64") },
}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/server/auth/require-user", () => ({
  requireVerifiedUser: () => Promise.resolve({ id: USER }),
}));

vi.mock("@/server/assets/asset-service", () => ({
  AssetService: { create: () => ({ archiveAsset, restoreAsset }) },
}));

const { archiveAssetAction, restoreAssetAction } = await import("./actions");

const REST: AssetActionState = { failure: null, attempt: 0 };

const form = (fields: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
};

beforeEach(() => {
  vi.clearAllMocks();
  archiveAsset.mockResolvedValue({ ok: true, data: { id: ASSET, status: "archived" } });
  restoreAsset.mockResolvedValue({ ok: true, data: { id: ASSET, status: "active" } });
});

describe("archiving", () => {
  it("archives the asset the form named, as the signed-in user", async () => {
    const state = await archiveAssetAction(REST, form({ assetId: ASSET }));

    expect(archiveAsset).toHaveBeenCalledWith(USER, ASSET);
    expect(state).toEqual({ failure: null, attempt: 1 });
  });

  it("reaches archive rather than any other transition", async () => {
    await archiveAssetAction(REST, form({ assetId: ASSET }));

    /**
     * The delegation itself. Archive and restore differ only in which method
     * they call, so asserting the *other* was not called is what distinguishes
     * a correct action from one wired to its opposite.
     */
    expect(restoreAsset).not.toHaveBeenCalled();
  });

  it("refuses a second archive with the state the service reports", async () => {
    /**
     * `archiveAsset` passes an expected status of `active`, so archiving an
     * already-archived asset matches no row and returns `NOT_FOUND`. The action
     * reports that rather than retrying or inventing a success — and it does not
     * mutate again, which is what the untouched call count shows.
     */
    archiveAsset.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    const state = await archiveAssetAction(REST, form({ assetId: ASSET }));

    expect(state).toEqual({ failure: "not_found", attempt: 1 });
    expect(archiveAsset).toHaveBeenCalledTimes(1);
  });

  it("reports a foreign or missing asset the same way", async () => {
    /** The service makes "not yours" and "no such asset" indistinguishable. */
    archiveAsset.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    expect(await archiveAssetAction(REST, form({ assetId: ASSET }))).toEqual({
      failure: "not_found",
      attempt: 1,
    });
  });

  it("maps a store failure to unavailable, not to not_found", async () => {
    /** "The database is down" and "that is not yours" are different answers. */
    archiveAsset.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    expect(await archiveAssetAction(REST, form({ assetId: ASSET }))).toEqual({
      failure: "unavailable",
      attempt: 1,
    });
  });

  it("revalidates only after a write that happened", async () => {
    archiveAsset.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });
    await archiveAssetAction(REST, form({ assetId: ASSET }));
    expect(revalidatePath).not.toHaveBeenCalled();

    archiveAsset.mockResolvedValue({ ok: true, data: { id: ASSET } });
    await archiveAssetAction(REST, form({ assetId: ASSET }));

    /** Both routes render the mutated asset; invalidating one moves the bug. */
    expect(revalidatePath).toHaveBeenCalledWith(`/assets/${ASSET}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/assets/${ASSET}/edit`);
  });
});

/**
 * Which surfaces a transition invalidates (ATL-036 M5).
 *
 * ## Why `/assets` is the one that matters here
 *
 * Since M2 the default list hides archived rows. That makes archive and restore
 * *membership* changes, not just field changes: an archive that left `/assets`
 * cached would show the service still sitting in the active list — the one place
 * the user goes to see what is active — with no indication anything happened.
 *
 * The failure case is asserted as strictly as the success cases. Invalidating
 * after a write that did not occur is what made a failed archive look like a
 * completed round trip in ATL-112, and `/assets` is now a third path that could
 * reintroduce it.
 */
describe("what a transition invalidates", () => {
  const paths = () => revalidatePath.mock.calls.map(([path]) => path);

  const SURFACES = [`/assets/${ASSET}`, `/assets/${ASSET}/edit`, "/assets"];

  it("invalidates the detail page, the edit page and the list after an archive", async () => {
    await archiveAssetAction(REST, form({ assetId: ASSET }));

    /** Exact, not `toContain`: invalidating more than this is also a change. */
    expect(paths()).toEqual(SURFACES);
  });

  it("invalidates the same three surfaces after a restore", async () => {
    /**
     * Restore is the inverse membership change — the service rejoins the
     * default list — so an asymmetry here would mean undo appeared to work and
     * left the list wrong.
     */
    await restoreAssetAction(REST, form({ assetId: ASSET }));

    expect(paths()).toEqual(SURFACES);
  });

  it.each([
    ["a failed archive", () => archiveAssetAction(REST, form({ assetId: ASSET })), archiveAsset],
    ["a failed restore", () => restoreAssetAction(REST, form({ assetId: ASSET })), restoreAsset],
  ])("invalidates nothing after %s", async (_label, run, mocked) => {
    mocked.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    await run();

    expect(paths()).toEqual([]);
  });
});

describe("restoring", () => {
  it("restores the asset the form named, as the signed-in user", async () => {
    const state = await restoreAssetAction(REST, form({ assetId: ASSET }));

    expect(restoreAsset).toHaveBeenCalledWith(USER, ASSET);
    expect(state).toEqual({ failure: null, attempt: 1 });
  });

  it("reaches restore rather than any other transition", async () => {
    await restoreAssetAction(REST, form({ assetId: ASSET }));

    expect(archiveAsset).not.toHaveBeenCalled();
  });

  it("refuses to restore something that is not archived", async () => {
    /** The mirror guard: an expected status of `archived`. */
    restoreAsset.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    expect(await restoreAssetAction(REST, form({ assetId: ASSET }))).toEqual({
      failure: "not_found",
      attempt: 1,
    });
    expect(restoreAsset).toHaveBeenCalledTimes(1);
  });

  it("maps a store failure to unavailable", async () => {
    restoreAsset.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    expect(await restoreAssetAction(REST, form({ assetId: ASSET }))).toEqual({
      failure: "unavailable",
      attempt: 1,
    });
  });
});

describe("identity and input", () => {
  it("ignores a user id supplied by the caller", async () => {
    /**
     * Architecture §10: "never trust client-provided user IDs". A tampered form
     * carrying someone else's id must change nothing — the action reads the
     * session and passes that, so the extra field is inert.
     */
    await archiveAssetAction(
      REST,
      form({ assetId: ASSET, userId: "99999999-9999-4999-8999-999999999999" }),
    );

    expect(archiveAsset).toHaveBeenCalledWith(USER, ASSET);
  });

  it("passes exactly two arguments, so no third field can widen the call", async () => {
    await archiveAssetAction(REST, form({ assetId: ASSET, status: "removed" }));

    expect(archiveAsset.mock.calls[0]).toHaveLength(2);
  });

  it("treats a missing asset id as empty rather than as a File", async () => {
    /**
     * `FormData.get` returns `string | File`, and a `File` stringifies to
     * `[object File]` — a plausible-looking id. The shared `text` helper drops
     * anything that is not a string, and the service refuses the empty one.
     */
    archiveAsset.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    const data = new FormData();
    data.append("assetId", new File([], "not-an-id.txt"));

    expect(await archiveAssetAction(REST, data)).toEqual({ failure: "not_found", attempt: 1 });
    expect(archiveAsset).toHaveBeenCalledWith(USER, "");
  });
});

describe("attempt semantics", () => {
  it("increments from whatever the previous state carried", async () => {
    /**
     * `attempt` keys the alert that reports a failure, so a second identical
     * failure is announced again rather than sitting silently in the DOM.
     */
    const first = await archiveAssetAction({ failure: null, attempt: 4 }, form({ assetId: ASSET }));

    expect(first.attempt).toBe(5);
  });

  it("increments on failure as well as success", async () => {
    archiveAsset.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    const once = await archiveAssetAction(REST, form({ assetId: ASSET }));
    const twice = await archiveAssetAction(once, form({ assetId: ASSET }));

    expect([once.attempt, twice.attempt]).toEqual([1, 2]);
  });
});

describe("side effects stay with the service", () => {
  it("asks the service for the transition and nothing else", async () => {
    /**
     * The activity event, the findings recompute and the score recalculation are
     * `afterMutation`'s, inside the service. If the action emitted any of them,
     * it would need its own dependencies — so the absence of any call beyond the
     * transition is the evidence that it does not.
     */
    const service = { archiveAsset, restoreAsset } as Record<string, unknown>;

    await archiveAssetAction(REST, form({ assetId: ASSET }));

    const used = Object.keys(service).filter(
      (name) => (service[name] as { mock: { calls: unknown[] } }).mock.calls.length > 0,
    );

    expect(used).toEqual(["archiveAsset"]);
  });
});
