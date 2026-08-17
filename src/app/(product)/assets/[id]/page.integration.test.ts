import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ATL-034 M4 — the asset detail page's composition.
 *
 * ## What this layer uniquely owns
 *
 * The sections prove their own contents (M2), and the header proves its own
 * controls (M3). Neither can prove the thing that only exists once they are
 * assembled: that the page reads the *right* data, refuses the wrong asset
 * before reading anything else, and hands each component what it expects.
 *
 * So the feature components are doubled here and their props captured. That is
 * deliberate — re-asserting section order or button states through the page
 * would duplicate coverage that already exists and would fail in two places for
 * one cause. What is asserted is the wiring.
 *
 * ## Order of reads is a security property, not a performance one
 *
 * Every read is scoped by `user_id`, so a parallel fan-out could not return
 * another user's records. The reason `getAsset` still runs alone first is that a
 * guessed id would otherwise cost five database round trips instead of one. The
 * tests below assert that a refused asset triggers *no* further reads.
 */

const ASSET = "44444444-4444-4444-8444-444444444444";
const USER = "11111111-1111-4111-8111-111111111111";

/** `notFound()` throws a control-flow signal; this stands in for it. */
class NotFoundSignal extends Error {
  constructor() {
    super("NOT_FOUND");
  }
}

const getAsset = vi.fn();
const readMaskedAccountIdentifier = vi.fn();
const listAssetDetails = vi.fn();
const listFindingsForAsset = vi.fn();
const forEntity = vi.fn();

/** Props each doubled component was rendered with. */
const captured: Record<string, Record<string, unknown>> = {};
const capture =
  (name: string) =>
  (props: Record<string, unknown>): null => {
    captured[name] = props;
    return null;
  };

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal();
  },
}));

vi.mock("@/config/env", () => ({
  env: { AUDIT_HMAC_KEY: Buffer.alloc(32, 5).toString("base64") },
}));
vi.mock("@/server/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));

vi.mock("@/server/auth/require-user", () => ({
  requireVerifiedUser: () => Promise.resolve({ id: USER }),
}));

vi.mock("@/server/assets/asset-service", () => ({
  AssetService: {
    create: () => ({ getAsset, readMaskedAccountIdentifier, listAssetDetails }),
  },
}));

vi.mock("@/server/findings/finding-service", () => ({
  FindingService: { create: () => ({ listFindingsForAsset }) },
}));

vi.mock("@/server/repositories/activity-event-repository", () => ({
  ActivityEventRepository: class {
    forEntity = forEntity;
  },
}));

vi.mock("@/features/assets", () => ({
  AccountIdentifier: capture("AccountIdentifier"),
  AssetDetailHeaderActions: capture("AssetDetailHeaderActions"),
  AssetDetailSections: capture("AssetDetailSections"),
}));

vi.mock("@/features/findings", () => ({
  FindingAssistant: capture("FindingAssistant"),
}));

const summarizeAssetAction = vi.fn();
const archiveAssetAction = vi.fn();
const restoreAssetAction = vi.fn();
vi.mock("./actions", () => ({ summarizeAssetAction, archiveAssetAction, restoreAssetAction }));

const { default: AssetDetailPage } = await import("./page");

const asset = {
  id: ASSET,
  serviceName: "Beta Bank",
  serviceDomain: "beta.test",
  category: "finance",
  status: "active",
  sourceType: "manual",
  sourceLabel: null,
  confidence: "high",
  lastVerifiedAt: null,
  createdAt: "2026-01-05T00:00:00.000Z",
  notes: null,
};

const categories = [{ id: "category-1", category: "financial" }];
const permissions = [{ id: "permission-1", permissionType: "data_sharing" }];
const findings = [{ id: "finding-1", title: "Broad permission", severity: "high", status: "open" }];
const events = [{ id: "event-1", summary: "Added Beta Bank", occurredAt: "2026-01-05T00:00:00Z" }];

/**
 * Renders the page far enough to run its reads and collect the props it passed.
 *
 * The returned element tree is not walked: every component that matters is
 * doubled above, and React invokes them as the tree is produced.
 */
async function renderPage() {
  const element = await AssetDetailPage({ params: Promise.resolve({ id: ASSET }) });

  /** Force the doubled components to run so their props are captured. */
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object" || node === null) return;

    const el = node as { type?: unknown; props?: { children?: unknown } };
    if (typeof el.type === "function") {
      (el.type as (props: unknown) => unknown)(el.props);
    }
    if (el.props?.children !== undefined) walk(el.props.children);
  };

  walk(element);
  return element;
}

beforeEach(() => {
  for (const key of Object.keys(captured)) delete captured[key];
  vi.clearAllMocks();

  getAsset.mockResolvedValue({ ok: true, data: asset });
  readMaskedAccountIdentifier.mockResolvedValue({ ok: true, data: "be••••@beta.test" });
  listAssetDetails.mockResolvedValue({
    ok: true,
    data: { asset, dataCategories: categories, permissions },
  });
  listFindingsForAsset.mockResolvedValue({ ok: true, data: findings });
  forEntity.mockResolvedValue(events);
});

describe("the ownership gate", () => {
  it("answers 404 for an asset that is missing or is not the caller's", async () => {
    getAsset.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    await expect(renderPage()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("reads nothing else once the asset is refused", async () => {
    getAsset.mockResolvedValue({ ok: false, code: "NOT_FOUND" });

    await expect(renderPage()).rejects.toBeInstanceOf(NotFoundSignal);

    /**
     * The reason the reads are ordered. Fanning out immediately would make every
     * guessed id cost five round trips instead of one — none of them leaking,
     * all of them wasted, and an attacker choosing how many to provoke.
     */
    expect(readMaskedAccountIdentifier).not.toHaveBeenCalled();
    expect(listAssetDetails).not.toHaveBeenCalled();
    expect(listFindingsForAsset).not.toHaveBeenCalled();
    expect(forEntity).not.toHaveBeenCalled();
  });

  it("surfaces a store failure as an error rather than as a 404", async () => {
    getAsset.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    /** "The database is down" and "this is not yours" are different answers. */
    await expect(renderPage()).rejects.not.toBeInstanceOf(NotFoundSignal);
  });

  it("scopes every read to the session user, never to a caller-supplied id", async () => {
    await renderPage();

    for (const read of [getAsset, readMaskedAccountIdentifier, listAssetDetails]) {
      expect(read).toHaveBeenCalledWith(USER, ASSET);
    }
    expect(listFindingsForAsset).toHaveBeenCalledWith(USER, ASSET);
    expect(forEntity).toHaveBeenCalledWith(USER, "asset", ASSET);
  });
});

describe("what each section is given", () => {
  it("passes the asset, its child records, findings and activity", async () => {
    await renderPage();

    expect(captured.AssetDetailSections).toMatchObject({
      asset,
      categories,
      permissions,
      findings,
      events,
    });
  });

  it("takes findings from the open-only asset query", async () => {
    await renderPage();

    /**
     * `listFindingsForAsset` is restricted to `open` and `in_progress`, so the
     * section cannot show a resolved finding — the page does no filtering of its
     * own, which is what keeps that guarantee in one place.
     */
    expect(listFindingsForAsset).toHaveBeenCalledTimes(1);
    expect(captured.AssetDetailSections?.findings).toBe(findings);
  });

  it("delegates section order rather than restating it", async () => {
    await renderPage();

    /**
     * One component receives everything. Frontend §7's order lives inside it and
     * is asserted there; a page that mounted the seven sections itself would be
     * a second place for the order to drift.
     */
    expect(captured.AssetDetailSections).toBeDefined();
    expect(captured.AssetDetailOverview).toBeUndefined();
    expect(captured.AssetDetailRequests).toBeUndefined();
  });

  it("falls back to empty lists rather than failing the page on a partial read", async () => {
    listAssetDetails.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });
    listFindingsForAsset.mockResolvedValue({ ok: false, code: "UNAVAILABLE" });

    await renderPage();

    /** The asset's own facts still render; the sections that failed read empty. */
    expect(captured.AssetDetailSections).toMatchObject({
      categories: [],
      permissions: [],
      findings: [],
    });
  });
});

describe("the account identifier", () => {
  it("uses the masked read and passes only the mask", async () => {
    await renderPage();

    /**
     * ATL-035's guarantee at the composition layer: the page calls the masking
     * read, and what reaches the component is the mask plus an id. The plaintext
     * has no path into the payload because it was never fetched.
     *
     * Asserted on the element the page passes rather than on a rendered double:
     * the identifier travels to `AssetDetailSections` as a prop, not as a child,
     * which is what keeps the section a server component that never sees a
     * value.
     */
    expect(readMaskedAccountIdentifier).toHaveBeenCalledWith(USER, ASSET);

    const slot = captured.AssetDetailSections?.accountIdentifier as
      { props?: Record<string, unknown> } | undefined;

    expect(slot?.props).toMatchObject({ masked: "be••••@beta.test", assetId: ASSET });
  });

  it("passes no plaintext anywhere in the identifier slot", async () => {
    readMaskedAccountIdentifier.mockResolvedValue({ ok: true, data: "da••••@example.test" });

    await renderPage();

    /**
     * The service returns a mask, so a plaintext cannot be here — but asserting
     * it makes the claim testable rather than merely true today. If the page
     * were ever switched to the reveal path, this fails.
     */
    const payload = JSON.stringify(captured.AssetDetailSections?.accountIdentifier ?? null);

    expect(payload).toContain("••••");
    expect(payload).not.toContain("dana.scully");
  });

  it("omits the control entirely when no identifier is stored", async () => {
    readMaskedAccountIdentifier.mockResolvedValue({ ok: true, data: null });

    await renderPage();

    expect(captured.AssetDetailSections?.accountIdentifier).toBeUndefined();
  });
});

describe("the ATL-054 assistant", () => {
  it("is mounted for the selected asset, unchanged", async () => {
    await renderPage();

    /**
     * Same four props ATL-054 shipped: the asset as subject, its name as title,
     * its own action, and the asset-specific copy. A regression here would show
     * up in the browser as an assistant talking about findings on a service
     * page, or summarising the wrong record.
     */
    expect(captured.FindingAssistant).toMatchObject({
      subjectId: ASSET,
      title: "Beta Bank",
      request: summarizeAssetAction,
    });
    expect(captured.FindingAssistant?.copy).toBeDefined();
  });
});

describe("the header", () => {
  it("is given the asset it acts on", async () => {
    await renderPage();

    expect(captured.AssetDetailHeaderActions).toMatchObject({
      assetId: ASSET,
      serviceName: "Beta Bank",
    });
  });

  it("is told the status, so it offers the transition that can actually run", async () => {
    await renderPage();

    /**
     * From the row this page already read, not from a second query and not from
     * client state. `archiveAsset` expects `active` and `restoreAsset` expects
     * `archived`, so a status the header disagreed with would mean offering a
     * write the service refuses — and the Overview badge two elements away
     * would be saying something different.
     */
    expect(captured.AssetDetailHeaderActions?.status).toBe("active");
  });

  it("passes the archive and restore actions, and only those", async () => {
    await renderPage();

    /**
     * ATL-036 M5 replaced this file's older assertion that the header received
     * *no* callbacks at all. That assertion encoded a real constraint at the
     * time — archive had no undo affordance and no copy, so the page could not
     * be allowed to enable it by accident — and the constraint has been met
     * rather than dropped.
     *
     * The exact key set is still pinned, for the same reason it was then: the
     * two request controls have no capability behind them (ATL-056/057), and
     * this fails if a handler for one appears here.
     */
    expect(Object.keys(captured.AssetDetailHeaderActions ?? {}).sort()).toEqual([
      "archive",
      "assetId",
      "restore",
      "serviceName",
      "status",
    ]);

    expect(captured.AssetDetailHeaderActions?.archive).toBe(archiveAssetAction);
    expect(captured.AssetDetailHeaderActions?.restore).toBe(restoreAssetAction);
  });
});
